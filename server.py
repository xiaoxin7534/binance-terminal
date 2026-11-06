#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
币安本地看盘终端 · 后端服务
=====================================
仅依赖 Python 标准库（3.8+），无需 pip install。

设计要点（针对本机网络环境优化）：
  * 行情全部走 WebSocket（data-stream.binance.vision），不依赖批量 REST 快照
  * REST 仅用于 K 线/深度，且强制 gzip —— 实测 500 根 K 线从 11.7s 降到 1.7s
  * 高频 tick 在服务端合并（0.7s 一批）后通过 SSE 推给浏览器，
    浏览器只做增量渲染，几百个交易对也不会卡
  * 全市场快照落盘缓存，重启秒开

启动：python server.py [--port 8848] [--host 127.0.0.1] [--open]
"""

import argparse
import base64
import concurrent.futures
import gzip

from sector_rules import ORDER as SECTOR_ORDER, TAG_MAP, keys_from_tags, keys_from_futures
from stock_map import (
    REGION_LABELS, REGION_ORDER, NAMES as STOCK_NAMES, regions_of,
)
import http.client
import queue
import json
import os
import queue
import select
import socket
import ssl
import struct
import sys

import app_paths
import threading
import time
import urllib.request
import webbrowser
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 打包成 exe 后，静态资源在 PyInstaller 的解包目录里（只读），
# 缓存必须落到用户目录，否则每次启动都要重新攒行情
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    ROOT = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    # 打包后缓存默认在 %LOCALAPPDATA%\BinanceTerminal\cache，
    # 可用 BTERM_DATA / exe 旁的 data-dir.txt 挪到别的盘（见 app_paths.py）
    CACHE_DIR = app_paths.data_dir("cache")
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    CACHE_DIR = os.path.join(ROOT, "cache")
TICKER_CACHE = os.path.join(CACHE_DIR, "tickers.json")
LISTING_CACHE = os.path.join(CACHE_DIR, "listing.json")
KLINES_FILE = os.path.join(CACHE_DIR, "klines.json")
SECTORS_FILE = os.path.join(ROOT, "assets", "data", "sectors.json")
REGIONS_FILE = os.path.join(ROOT, "assets", "data", "regions.json")

# 现货 REST：.vision 是币安给受限地区的公开行情域名，.me 是另一条不查地区的线路
REST_HOST = os.environ.get("BINANCE_REST_HOST") or "data-api.binance.vision"
REST_HOST_ALT = "api.binance.me"
# 合约直连域名：探测成功就填进来，之后合约请求不走代理
FAPI_DIRECT = None
WS_HOST = "data-stream.binance.vision"
FAPI_HOST = "www.binance.com"           # 合约 REST（网页版网关，fapi.binance.com 被 451）
FWS_HOST = "fstream.binance.com"        # 合约 WebSocket（需要代理）
FWS_PATH = "/market/stream"             # 网页版路径：有 !ticker@arr，但**没有 depth**
FWS_DEPTH_PATH = "/stream"              # 标准合并流端点：depth 走这里（见 DepthWorker）
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BinanceTerminal/1.0"

TOP_TICKER_STREAMS = 260        # rebalance 兜底保留的成交额前 N
MAX_TICKER_STREAMS = 950        # 单连接最多订阅的 ticker 流（币安上限 1024）
QUOTE_ASSETS = ("USDT", "USDC")  # 支持的计价货币
TICK_PUSH_INTERVAL = 0.7        # 全市场 tick 合并推送间隔（秒）
FAST_TICK_INTERVAL = 0.15       # 焦点品种（当前在看的那几十个）的推送间隔
TICKER_SAVE_INTERVAL = 25       # 快照落盘间隔（秒）

SEED_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT",
    "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT", "SUIUSDT", "APTUSDT",
    "ARBUSDT", "OPUSDT", "NEARUSDT", "LTCUSDT", "DOTUSDT", "TRXUSDT",
    "1000PEPEUSDT", "WIFUSDT", "ORDIUSDT", "INJUSDT", "TIAUSDT", "SEIUSDT",
]

# 稳定币/法币交易对：成交额虚高但没有看盘价值，从列表里剔除
STABLE_BASES = {
    "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "USDP", "EUR", "AEUR", "GBP",
    "USDT", "USD1", "XUSD", "PYUSD", "EURI", "BRL", "TRY", "ARS", "JPY",
    "RLUSD", "USDE", "SUSDE", "USDS", "EURC", "BFUSD", "USDF", "USDG",
    "GUSD", "LUSD", "FRAX", "CRVUSD", "MIM", "USTC", "UST", "SUSD",
}

log_lock = threading.Lock()


def log(*args):
    with log_lock:
        print("[%s]" % time.strftime("%H:%M:%S"), *args, flush=True)


# --------------------------------------------------------------------------
# REST（gzip）
# --------------------------------------------------------------------------

# ---- 本机 SOCKS5 代理探测（v2rayN / Clash 等） ----
SOCKS_PROXY = None


def probe_fapi_direct():
    """试一下合约接口能不能直连。

    币安合约 API 在受限地区返回 451，而且 fapi 域名本身被 DNS 污染，
    所以绝大多数情况必须走代理。但换个网络环境（或币安改策略）就可能通，
    通了延迟能从 2~4 秒降到 200ms，值得每次启动花 4 秒试一下。
    """
    global FAPI_DIRECT
    for host in ("fapi.binance.com", "fapi1.binance.com", "fapi2.binance.com"):
        try:
            ctx = ssl.create_default_context()
            conn = http.client.HTTPSConnection(host, timeout=4, context=ctx)
            conn.request("GET", "/fapi/v1/ping", headers={"User-Agent": UA})
            r = conn.getresponse()
            r.read()
            conn.close()
            if r.status == 200:
                FAPI_DIRECT = host
                log("合约接口可直连（%s），不走代理" % host)
                return
        except Exception:           # noqa: BLE001
            continue
    log("合约接口无法直连，继续走代理")


def _proxy_config_files():
    """代理配置文件的查找顺序：exe 同目录 → 用户数据目录

    便携包给别人用时，让对方改 proxy.txt 比设环境变量现实得多。
    """
    dirs = []
    if FROZEN:
        # sys.executable 是 exe 本身；_MEIPASS 是临时解包目录，不能放配置
        dirs.append(os.path.dirname(os.path.abspath(sys.executable)))
    else:
        dirs.append(ROOT)
    dirs.append(os.path.dirname(CACHE_DIR))      # %LOCALAPPDATA%\BinanceTerminal
    return [os.path.join(d, "proxy.txt") for d in dirs]


def _read_proxy_file():
    for p in _proxy_config_files():
        try:
            with open(p, "r", encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        return line, p
        except Exception:       # noqa: BLE001
            continue
    return "", ""


def detect_proxy():
    """探测本机常见代理端口，返回 (host, port) 或 None

    想指定代理，按优先级：
      1. 环境变量 BINANCE_PROXY=socks5://127.0.0.1:1080（也接受 host:port）
      2. exe 同目录或 %LOCALAPPDATA%/BinanceTerminal 下的 proxy.txt，
         一行 host:port，# 开头是注释
      3. 自动探测本机常见端口（10808 / 1080 / 7890 / 7891 / 10809 / 2080 / 20171）
    """
    global SOCKS_PROXY
    env = (os.environ.get("BINANCE_PROXY") or "").strip()
    src = "环境变量 BINANCE_PROXY"
    if not env:
        env, src = _read_proxy_file()
        src = "配置文件 " + src if src else ""
    if env:
        raw = env.split("://", 1)[-1]
        host, _, port = raw.rpartition(":")
        if host and port.isdigit():
            SOCKS_PROXY = (host, int(port))
            log("使用%s 指定的代理 %s:%s" % (src, SOCKS_PROXY[0], SOCKS_PROXY[1]))
            return SOCKS_PROXY
        log("BINANCE_PROXY 格式不对（要 host:port），忽略")
    for port in (10808, 1080, 7890, 7891, 10809, 2080, 20171):
        try:
            sk = socket.create_connection(("127.0.0.1", port), timeout=0.35)
            sk.close()
            SOCKS_PROXY = ("127.0.0.1", port)
            log("检测到本机代理 127.0.0.1:%d" % port)
            return SOCKS_PROXY
        except Exception:       # noqa: BLE001
            continue
    return None


def socks5_socket(host, port, timeout=15):
    """通过本机 SOCKS5 建立到目标的 TCP 连接"""
    px = SOCKS_PROXY
    if not px:
        raise ConnectionError("no proxy")
    s = socket.create_connection(px, timeout=timeout)
    s.settimeout(timeout)
    s.sendall(b"\x05\x01\x00")
    if s.recv(2) != b"\x05\x00":
        raise ConnectionError("socks auth failed")
    a = host.encode()
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(a)]) + a + port.to_bytes(2, "big"))
    r = s.recv(10)
    if len(r) < 2 or r[1] != 0:
        raise ConnectionError("socks connect failed code=%s" % (r[1] if len(r) > 1 else "?"))
    return s


def https_via_socks(host, path, timeout=25, headers=None):
    """走 SOCKS5 发一个 HTTPS GET，返回 (status, body_bytes)"""
    raw = socks5_socket(host, 443, timeout)
    ctx = ssl.create_default_context()
    s = ctx.wrap_socket(raw, server_hostname=host)
    s.settimeout(timeout)
    hdrs = {"Host": host, "User-Agent": UA, "Accept": "application/json",
            "Accept-Encoding": "gzip", "Connection": "close"}
    if headers:
        hdrs.update(headers)
    req = "GET %s HTTP/1.1\r\n" % path + "".join("%s: %s\r\n" % kv for kv in hdrs.items()) + "\r\n"
    s.sendall(req.encode())
    data = b""
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    head, _, body = data.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = int(lines[0].split(b" ")[1]) if len(lines[0].split(b" ")) > 1 else 0
    meta = {}
    for ln in lines[1:]:
        k, _, v = ln.partition(b":")
        meta[k.strip().lower()] = v.strip()
    if meta.get(b"transfer-encoding") == b"chunked":
        out = b""
        rest = body
        while True:
            i = rest.find(b"\r\n")
            if i < 0:
                break
            n = int(rest[:i].split(b";")[0] or b"0", 16)
            if n == 0:
                break
            out += rest[i + 2:i + 2 + n]
            rest = rest[i + 2 + n + 2:]
        body = out
    if b"gzip" in (meta.get(b"content-encoding") or b""):
        body = gzip.decompress(body)
    return status, body


def fapi_get(path, timeout=25):
    """合约 REST：能直连就直连（延迟差 10 倍），否则走代理"""
    if FAPI_DIRECT:
        try:
            return _http_get_pooled(FAPI_DIRECT, path, timeout)
        except Exception as e:      # noqa: BLE001
            log("合约直连失败，回退代理: %s" % e)
    if SOCKS_PROXY:
        status, body = https_via_socks(FAPI_HOST, path, timeout)
        if status == 451:
            raise PermissionError("451 受限地区（代理节点被币安限制）")
        if status != 200:
            raise ConnectionError("HTTP %d" % status)
        return body
    raise ConnectionError("未检测到可用代理，无法访问币安合约接口")


_cache = {}
_cache_lock = threading.Lock()
_inflight_api = {}           # 同一个合约 REST path 只允许一个请求在飞（key -> Event）
_inflight_api_lock = threading.Lock()
LAST_USER_REQ = 0.0          # 最后一次浏览器请求的时间，预取靠它判断「用户现在忙不忙」
_INTRADAY = {}               # 分时结果缓存（当天数据基本不变，只有最后一根在动）
_intraday_lock = threading.Lock()
_opener_env = urllib.request.build_opener()
_opener_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# --------------------------------------------------------------------------
# HTTPS 连接池
#
# 实测到 data-api.binance.vision 的 TLS 握手要 2 秒（TCP 只要 2ms），
# 每个 K 线请求都重新握手一次，8 个格子就是 8 次。复用连接能把这 2 秒省掉。
# 池子里失败就退回原来的 urllib 逻辑，不影响可用性。
# --------------------------------------------------------------------------

_https_pool = {}                 # host -> [(conn, 最后使用时间), ...]
_https_pool_lock = threading.Lock()
HTTPS_IDLE_MAX = 25.0            # 空闲超过这么久就丢掉，币安那边可能已经关了
HTTPS_POOL_MAX = 16


def _https_take(host):
    now = time.time()
    with _https_pool_lock:
        lst = _https_pool.get(host)
        while lst:
            conn, used = lst.pop()
            if conn.sock is not None and now - used < HTTPS_IDLE_MAX:
                return conn
            try:
                conn.close()
            except Exception:       # noqa: BLE001
                pass
    return None


def _https_give(host, conn):
    with _https_pool_lock:
        lst = _https_pool.setdefault(host, [])
        if len(lst) < HTTPS_POOL_MAX:
            lst.append((conn, time.time()))
            return
    try:
        conn.close()
    except Exception:           # noqa: BLE001
        pass


def _http_get_pooled(host, path, timeout):
    for attempt in (0, 1):
        conn = _https_take(host)
        fresh = conn is None
        if fresh:
            conn = http.client.HTTPSConnection(
                host, timeout=timeout, context=ssl.create_default_context())
        try:
            conn.request("GET", path, headers={
                "User-Agent": UA,
                "Accept": "application/json",
                "Accept-Encoding": "gzip, deflate",
            })
            r = conn.getresponse()
            body = r.read()
            enc = (r.getheader("Content-Encoding") or "").lower()
            if "gzip" in enc:
                body = gzip.decompress(body)
            elif "deflate" in enc:
                body = zlib.decompress(body, -zlib.MAX_WBITS)
            if r.status != 200:
                raise ConnectionError("HTTP %d" % r.status)
            _https_give(host, conn)
            return body
        except Exception:           # noqa: BLE001
            try:
                conn.close()
            except Exception:       # noqa: BLE001
                pass
            # 复用的旧连接可能已被服务端关掉，重开一条再试一次
            if attempt == 1 or fresh:
                if attempt == 1:
                    raise
    raise ConnectionError("http_get failed")


def http_get(path, timeout=25):
    for host in (REST_HOST, REST_HOST_ALT):
        try:
            return _http_get_pooled(host, path, timeout)
        except Exception:           # noqa: BLE001
            continue                # 主域名挂了就试备用
    url = "https://%s%s" % (REST_HOST, path)
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
    })
    last = None
    for opener in (_opener_env, _opener_direct):
        try:
            with opener.open(req, timeout=timeout) as r:
                body = r.read()
                enc = (r.headers.get("Content-Encoding") or "").lower()
                if "gzip" in enc:
                    body = gzip.decompress(body)
                elif "deflate" in enc:
                    body = zlib.decompress(body, -zlib.MAX_WBITS)
                return body
        except Exception as e:      # noqa: BLE001
            last = e
    raise last


def cached_fapi(path, ttl, timeout=25):
    """合约 REST 缓存 + 同 key 去重。

    合约接口单次 2~5 秒（走代理），而持仓量 / 多空比这类数据是
    「打开大图后台预取一次、点开面板又要一次」——不去重就是两边同时打币安，
    用户那次反而更慢（这个坑之前在 K 线预取上踩过一次）。
    """
    key = "f:" + path
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    with _inflight_api_lock:
        ev = _inflight_api.get(key)
        owner = ev is None
        if owner:
            ev = threading.Event()
            _inflight_api[key] = ev
    if not owner:
        # 已经在飞的那次最多等一个超时；它失败了我们再自己拉
        ev.wait(timeout)
        with _cache_lock:
            hit = _cache.get(key)
        if hit:
            return hit[1]
    try:
        body = fapi_get(path, timeout)
        # 先落缓存再唤醒等待方，否则它们醒来还是 miss，又各拉一次
        with _cache_lock:
            _cache[key] = (time.time() + ttl, body)
        return body
    finally:
        if owner:
            with _inflight_api_lock:
                _inflight_api.pop(key, None)
            ev.set()


def cached_get(path, ttl, timeout=25):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(path)
        if hit and hit[0] > now:
            return hit[1]
    body = http_get(path, timeout=timeout)
    with _cache_lock:
        _cache[path] = (now + ttl, body)
        if len(_cache) > 400:
            for k in list(_cache)[:100]:
                _cache.pop(k, None)
    return body


# --------------------------------------------------------------------------
# WebSocket 客户端（RFC6455 最小实现）
# --------------------------------------------------------------------------

class WSConn:
    def __init__(self, host, path, timeout=15, use_proxy=False):
        if use_proxy:
            raw = socks5_socket(host, 443, timeout)
        else:
            raw = socket.create_connection((host, 443), timeout=timeout)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        self.buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
               "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, key))
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed")
            head += chunk
        header, _, rest = head.partition(b"\r\n\r\n")
        if b"101" not in header.split(b"\r\n")[0]:
            first = header.split(b"\r\n")[0]
            if b"451" in first:
                raise PermissionError("451 受限地区")
            raise ConnectionError("handshake failed: %s" % first[:80])
        self.buf = rest

    def send_text(self, text):
        self._send_frame(0x1, text.encode())

    def _send_frame(self, opcode, data):
        n = len(data)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _parse(self):
        b = self.buf
        if len(b) < 2:
            return None
        b1, b2 = b[0], b[1]
        opcode = b1 & 0x0F
        ln = b2 & 0x7F
        pos = 2
        if ln == 126:
            if len(b) < 4:
                return None
            ln = struct.unpack("!H", b[2:4])[0]
            pos = 4
        elif ln == 127:
            if len(b) < 10:
                return None
            ln = struct.unpack("!Q", b[2:10])[0]
            pos = 10
        mask = None
        if b2 & 0x80:
            if len(b) < pos + 4:
                return None
            mask = b[pos:pos + 4]
            pos += 4
        if len(b) < pos + ln:
            return None
        payload = b[pos:pos + ln]
        if mask:
            payload = bytes(x ^ mask[i % 4] for i, x in enumerate(payload))
        self.buf = b[pos + ln:]
        return opcode, payload

    def recv_frame(self, timeout):
        deadline = time.time() + timeout
        while True:
            fr = self._parse()
            if fr:
                return fr
            remain = deadline - time.time()
            if remain <= 0:
                return None
            r, _, _ = select.select([self.sock], [], [], remain)
            if not r:
                return None
            try:
                data = self.sock.recv(65536)
            except ssl.SSLWantReadError:
                continue
            if not data:
                raise ConnectionError("socket closed")
            self.buf += data

    def close(self):
        try:
            self.sock.close()
        except Exception:       # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# 板块分类 & 上架时间
# --------------------------------------------------------------------------

SECTORS = {"labels": {}, "map": {}}
# 股票市场细分（美股/港股/A股/韩股/日股）：只覆盖 TradFi 里的股票类标的，
# 加密币不在里面。结构和 SECTORS 一样，前端按数组包含来筛。
REGIONS = {"labels": {}, "order": [], "map": {}, "names": {}}
LISTING = {}
_listing_lock = threading.Lock()


def load_regions():
    """载入股票市场细分表（assets/data/regions.json）

    缺失不影响启动：没有这张表时前端只是不显示市场入口，
    等新币归类线程拉到 exchangeInfo 会自动补上。
    运行时补录的（新上的股票合约）叠在 cache/sectors.local.json 的 reg 字段里，
    否则 exe 每次重启都要等下一次全量 exchangeInfo 才认得新股票。
    """
    global REGIONS
    try:
        with open(REGIONS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        REGIONS = {
            "labels": d.get("labels") or dict(REGION_LABELS),
            "order": d.get("order") or list(REGION_ORDER),
            "map": dict(d.get("map") or {}),
            "names": dict(d.get("names") or {}),
        }
        log("载入股票市场细分 %d 个代码" % len(REGIONS["map"]))
    except FileNotFoundError:
        log("没有 regions.json，股票市场筛选暂不可用（跑 tools/build_regions.py 生成）")
    except Exception as e:      # noqa: BLE001
        log("股票市场细分载入失败: %s" % e)
    try:
        with open(SECTORS_LOCAL, "r", encoding="utf-8") as f:
            local = json.load(f)
        delta = local.get("reg") or {}
        if delta:
            REGIONS["map"].update(delta)
            _region_added.update(delta)
            log("叠加运行时股票市场 %d 个" % len(delta))
        none = local.get("regn") or []
        if none:
            _region_none.update(none)
            log("已确认无股票市场的标的 %d 个（商品/指数/外汇/Pre-IPO）" % len(none))
    except Exception:           # noqa: BLE001
        pass


def stock_name(base):
    """代码 -> 名称（优先手工中文表，其次币安给的英文名）

    现货 token 化股票是「原代码 + B」（NVDAB），合约是原代码（NVDA）。
    两个方向都试一遍，永续和现货才能共用同一张表。
    """
    if not base:
        return ""
    alts = [base]
    if base.endswith("B") and len(base) > 2:
        alts.append(base[:-1])
    else:
        alts.append(base + "B")
    for src in (STOCK_NAMES, REGIONS["names"]):
        for k in alts:
            nm = src.get(k)
            if nm:
                return nm
    return ""


def load_sectors():
    """载入随包发布的分类表，再叠加运行时补录的增量（cache/sectors.local.json）

    增量单独存的原因：exe 里的 assets/data/sectors.json 在 _MEIPASS 只读，
    新品种归类结果必须落到可写目录，否则每次重启都要重新查一遍。
    """
    global SECTORS
    try:
        with open(SECTORS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        SECTORS = {"labels": d.get("labels", {}), "map": dict(d.get("map", {}))}
        log("载入板块分类 %d 个币种" % len(SECTORS["map"]))
    except Exception as e:      # noqa: BLE001
        log("板块分类载入失败: %s" % e)
    load_sectors_local()


# --------------------------------------------------------------------------
# 新币自动归类
#
# 币安上新币时，行情流（!ticker@arr）会在几秒内把它推进 HUB.tickers，
# 但板块分类来自静态表 —— 新币没有 sec，落不进任何板块筛选。
#
# 这里的做法是「事件驱动 + 分级取数」，空闲时零开销：
#   1. 某个 symbol 第一次出现 → note_new_symbol() 只塞队列，不发请求
#   2. 后台线程攒 6 秒（新币常常一次上好几个）后逐个归类
#   3. 先查单币接口（约 0.5KB）；查不到标签（只有合约没有现货的币）才退到
#      全量 exchangeInfo（约 1.1MB），且全量至少间隔 6 小时
#   4. 归类结果写 cache/sectors.local.json，并广播给前端
# --------------------------------------------------------------------------

SECTORS_LOCAL = os.path.join(CACHE_DIR, "sectors.local.json")
_sector_q = queue.Queue(maxsize=300)
_sector_pending = set()          # 已排队/正在查的 base，防重复
_sector_lock = threading.Lock()
_sector_bulk_at = 0.0            # 上次全量 exchangeInfo 的时间
SECTOR_BULK_GAP = 6 * 3600       # 全量刷新最小间隔
BULK_GAP_FAST = 10 * 60          # 快速通道：股票/商品类合约、补市场归属
SECTOR_RETRY_GAP = 30 * 60       # 归不上类的 base 多久后重试
SECTOR_MAX_TRY = 3               # 查不到标签的最多试几次就放弃
_sector_fails = {}               # base -> 已尝试次数
_sector_skip = set()             # 放弃的 base（已下架的杠杆代币等），不再查
# 单币查询是 IO 等待，串行查 186 个要 6 分钟；6 路并发压到 30 秒左右
_sector_pool = concurrent.futures.ThreadPoolExecutor(
    max_workers=6, thread_name_prefix="sector")
_sector_unknown_tags = {}        # 币安标签 -> 出现次数（映射表没覆盖的）
_sector_added = {}               # 运行时补录的 base -> keys（只这些写盘）
_region_added = {}               # 运行时补录的 base -> 股票市场（和上面同一份文件）
_region_none = set()             # 查过 exchangeInfo 确认「没有股票市场」的（商品/指数/外汇/Pre-IPO）


def load_sectors_local():
    try:
        with open(SECTORS_LOCAL, "r", encoding="utf-8") as f:
            d = json.load(f)
        add = d.get("map") or {}
        if add:
            SECTORS["map"].update(add)
            _sector_added.update(add)
            log("叠加运行时归类 %d 个币种" % len(add))
        for b in (d.get("skip") or []):
            _sector_skip.add(b)     # 上次已判定归不上类的，别再查
    except Exception:           # noqa: BLE001
        pass


def save_sectors_local():
    """只写运行时补录的增量 + 已放弃的名单

    不写整张表：随包发布的 sectors.json 以后可能重新生成，
    整表落盘会把新版内容盖成旧的。
    """
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = SECTORS_LOCAL + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 4, "map": _sector_added, "skip": sorted(_sector_skip),
                       "reg": _region_added, "regn": sorted(_region_none),
                       "ts": int(time.time())}, f,
                      ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, SECTORS_LOCAL)
    except Exception as e:      # noqa: BLE001
        log("归类结果写盘失败: %s" % e)


def queue_unregioned():
    """把「已有 TradFi 板块、却没有股票市场归属」的 base 排进归类队列。

    升级兼容用：老版本没有 regions.json，那时归好类的股票现在缺市场标签，
    而 note_new_symbol 只处理「完全没归类」的币，永远轮不到它们。
    商品/指数/外汇/Pre-IPO 查过一次就记进 _region_none，下次开机不会再排。
    """
    n = 0
    for base, keys in list(SECTORS["map"].items()):
        if base in REGIONS["map"] or base in _region_none or base in _sector_skip:
            continue
        if not any(k in ("TRADFI", "PREIPO", "PREMARKET") for k in keys):
            continue
        with _sector_lock:
            if base in _sector_pending:
                continue
            _sector_pending.add(base)
        try:
            _sector_q.put_nowait(base)
            n += 1
        except queue.Full:
            with _sector_lock:
                _sector_pending.discard(base)
            break
    if n:
        log("补历史股票的市场归属：排队 %d 个" % n)


def note_new_symbol(sym):
    """WS 里第一次见到某个 symbol 时调用。只入队，不阻塞行情线程。"""
    base, _ = split_symbol(sym)
    if not base or base in STABLE_BASES:
        return
    with _sector_lock:
        if base in SECTORS["map"] or base in _sector_pending or base in _sector_skip:
            return
        _sector_pending.add(base)
    try:
        _sector_q.put_nowait(base)
    except queue.Full:
        with _sector_lock:
            _sector_pending.discard(base)


# --------------------------------------------------------------------------
# 新品种上线通知
#
# 判定口径：行情流里第一次见到这个 base，且不在「已见名单」里。
# 已见名单落盘到 cache/seen.json —— 否则每次重启都会把全市场当成新币。
# 进程刚起来的前 90 秒只收录不通知：冷启动时 tickers 缓存可能是空的，
# 那一刻几千个币都算「第一次见到」，不设基线会一次性弹一堆通知。
# --------------------------------------------------------------------------

NEW_FILE = os.path.join(CACHE_DIR, "seen.json")
NEW_GRACE = 90                   # 启动后多少秒内出现的只收录、不通知
NEW_KEEP = 20                    # 内存里留最近多少条，供页面重连时补发

NEW_SEEN = set()                 # 见过（或已通知过）的 base
NEW_LIST = []                    # 最近发现的新品种 [{b,s,q,ts}]
_new_lock = threading.Lock()
_new_armed_at = 0.0
_new_dirty = False


def load_seen():
    global _new_armed_at
    try:
        with open(NEW_FILE, "r", encoding="utf-8") as f:
            NEW_SEEN.update(json.load(f).get("bases") or [])
        log("载入已见品种 %d 个" % len(NEW_SEEN))
    except FileNotFoundError:
        log("没有 seen.json，首次启动的前 %d 秒只收录不通知" % NEW_GRACE)
    except Exception as e:      # noqa: BLE001
        log("已见品种载入失败: %s" % e)
    _new_armed_at = time.time() + NEW_GRACE


def save_seen():
    global _new_dirty
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = NEW_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "bases": sorted(NEW_SEEN)}, f,
                      ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, NEW_FILE)
        _new_dirty = False
    except Exception as e:      # noqa: BLE001
        log("已见品种写盘失败: %s" % e)


def seen_saver():
    """冷启动会一口气收录上千个 base，逐个写盘没必要，30 秒攒一次"""
    while True:
        time.sleep(30)
        if _new_dirty:
            save_seen()


def note_new_listing(sym):
    """行情流第一次见到某个 base → 判定是不是新品种，是就通知前端"""
    global _new_dirty
    base, quote = split_symbol(sym)
    if not base or base in STABLE_BASES:
        return
    now = time.time()
    with _new_lock:
        if base in NEW_SEEN:
            return
        NEW_SEEN.add(base)
        _new_dirty = True
        if now < _new_armed_at:
            return              # 启动基线，静默收录
        item = {"b": base, "s": sym, "q": quote, "ts": int(now * 1000)}
        NEW_LIST.append(item)
        del NEW_LIST[:-NEW_KEEP]
    # 新币在 LISTING 里还没有上架日期（要等后台探第一根 K 线），先按现在记一笔，
    # 它就能立刻进「新币上线」页签；后台探到真实日期会覆盖掉
    with _listing_lock:
        LISTING.setdefault(base + "USDT", item["ts"])
    log("新品种上线：%s（%s）" % (base, quote))
    try:
        HUB.broadcast({"t": "new", "d": [item]})
    except Exception:           # noqa: BLE001
        pass


def _fetch_spot_tags(base):
    """单币查现货标签：约 0.5KB。返回 (板块 key 列表, 原始 tag 列表)"""
    try:
        status, body = https_via_socks(
            "www.binance.com",
            "/bapi/asset/v1/public/asset-service/product/get-products?symbol=%sUSDT" % base,
            20)
        if status != 200:
            return [], []
        rows = json.loads(body).get("data") or []
        for r in rows:
            if r.get("b") == base:
                tags = r.get("tags") or []
                return keys_from_tags(tags), tags
    except Exception:           # noqa: BLE001
        pass
    return [], []


def _fetch_futures_subtypes(bases):
    """全量 exchangeInfo（约 1.1MB），只取需要的 base。

    返回 (板块, 股票市场)：{base: [sector key]}、{base: [region key]}。
    股票市场顺带一起取——同一个响应里就有 underlyingType，不额外发请求。
    """
    out, reg = {}, {}
    try:
        raw = json.loads(fapi_get("/fapi/v1/exchangeInfo", 40))
        want = set(bases)
        for s in raw.get("symbols", []):
            b = s.get("baseAsset")
            if b not in want:
                continue
            ut = s.get("underlyingType")
            keys = keys_from_futures(s.get("underlyingSubType"), ut)
            if keys:
                out.setdefault(b, set()).update(keys)
            r = regions_of(b, ut)
            if r:
                reg[b] = r
    except Exception as e:      # noqa: BLE001
        log("拉 exchangeInfo 失败: %s" % e)
    return ({b: [k for k in SECTOR_ORDER if k in v] for b, v in out.items()}, reg)


def classify_bases(bases):
    """给一批 base 归类，返回 {base: [keys]}

    精度说明：现货标签把 Layer1/Layer2 合成一个 `Layer1_Layer2`，
    所以只拿到 `['L1']` 的结果是「不完整」而不是「错误」——
    这类也排进全量检查，等合约的 underlyingSubType 补齐 L2，两者取并集。
    """
    global _sector_bulk_at
    got, need_bulk = {}, []
    dirty = False
    # ex.map 保持顺序，6 路并发查单币标签
    try:
        fetched = list(_sector_pool.map(_fetch_spot_tags, bases))
    except Exception:           # noqa: BLE001
        fetched = [([], []) for _ in bases]
    had_tags = set()
    for base, (keys, tags) in zip(bases, fetched):
        if keys:
            got[base] = keys
        if tags:
            had_tags.add(base)
        if not keys or keys == ["L1"]:
            need_bulk.append(base)
        # 有标签但一个都没映射上 → 币安用了我们还不认识的分类
        for t in tags:
            if t not in TAG_MAP:
                _sector_unknown_tags[t] = _sector_unknown_tags.get(t, 0) + 1

    # 已经判成 TradFi 但还没有股票市场归属的，也要进全量检查。
    # 新上的股票合约走的是这条路：板块能从现货标签拿到，市场只有 exchangeInfo 有。
    need_region = [b for b in bases
                   if b not in REGIONS["map"]
                   and any(k in ("TRADFI", "PREIPO", "PREMARKET") for k in got.get(b, []))]
    todo = list(dict.fromkeys(need_bulk + need_region))

    bulk_checked = set()
    if todo:
        age = time.time() - _sector_bulk_at
        # 补板块默认等 6 小时（同一份 1.1MB 响应没必要反复拉）。两种情况走快速通道：
        #   1. 要补股票市场归属的（need_region）
        #   2. 单币接口一条标签都查不到的（blind）—— 股票/商品类合约在现货里没有对应
        #      交易对，`?symbol=XXXUSDT` 永远返回空，只能靠全量 exchangeInfo。
        #      这类如果也等 6 小时，新股票上市当天就进不了筛选。
        blind = [b for b in todo if b not in had_tags]
        if age > SECTOR_BULK_GAP or ((need_region or blind) and age > BULK_GAP_FAST):
            bulk, regs = _fetch_futures_subtypes(todo)
            bulk_checked = set(todo)
            _sector_bulk_at = time.time()
            for b, keys in bulk.items():
                merged = [k for k in SECTOR_ORDER
                          if k in (set(got.get(b, [])) | set(keys))]
                # 板块本来就是这个 → 不要重复播一次「新币已归类」
                if merged == SECTORS["map"].get(b):
                    got.pop(b, None)
                else:
                    got[b] = merged
            # 全量里确实没有市场归属的（商品/指数/外汇/Pre-IPO）记下来，别每次开机再查一遍
            marked = 0
            for b in todo:
                if b in regs or b in _region_none:
                    continue
                # 板块可能在 got 里（新币），也可能早就在 SECTORS 里（补历史）
                keys_now = got.get(b) or SECTORS["map"].get(b) or []
                if any(k in ("TRADFI", "PREIPO", "PREMARKET") for k in keys_now):
                    _region_none.add(b)
                    marked += 1
            if regs or marked:
                with _sector_lock:
                    REGIONS["map"].update(regs)
                    _region_added.update(regs)
                save_sectors_local()
            if regs:
                log("补充股票市场归属 %d 个：%s" % (len(regs), "、".join(
                    "%s(%s)" % (b, "/".join(REGION_LABELS.get(k, k) for k in v))
                    for b, v in list(regs.items())[:4])))
                try:
                    HUB.broadcast({"t": "reg", "d": regs})
                except Exception:       # noqa: BLE001
                    pass

    if got:
        with _sector_lock:
            SECTORS["map"].update(got)
            _sector_added.update(got)
        save_sectors_local()
        brief = "、".join("%s(%s)" % (b, "/".join(SECTORS["labels"].get(k, k) for k in v))
                          for b, v in list(got.items())[:4])
        log("新币自动归类 %d 个：%s" % (len(got), brief))
        try:
            HUB.broadcast({"t": "sec", "d": got})
        except Exception:       # noqa: BLE001
            pass

    with _sector_lock:
        for b in bases:
            _sector_pending.discard(b)
            if b in got:
                _sector_fails.pop(b, None)
            elif b in had_tags:
                # 币安给了标签、但没一个属于我们这 13 个板块（比如 Payments / fan_token），
                # 这类是「确定没有板块」，直接放弃，不用再试
                _sector_skip.add(b)
                _sector_fails.pop(b, None)
                dirty = True
            elif b in bulk_checked:
                # 全量 exchangeInfo 真的查过了还是没有 → 才算一次失败
                # 完全没标签（已下架的杠杆代币、只有币本位合约等），留到慢扫描再试；
                # 试满 SECTOR_MAX_TRY 次放弃，否则每 30 分钟白查一次
                n = _sector_fails.get(b, 0) + 1
                _sector_fails[b] = n
                if n >= SECTOR_MAX_TRY:
                    _sector_skip.add(b)
                    _sector_fails.pop(b, None)
                    dirty = True
    if dirty:
        save_sectors_local()
    return got


def sector_sync_worker():
    """事件驱动：有新 base 才动，攒 6 秒批量处理"""
    while True:
        try:
            first = _sector_q.get(timeout=60)
        except queue.Empty:
            continue
        batch = [first]
        time.sleep(6)               # 新币常成批上线，等一下凑一起查
        while True:
            try:
                batch.append(_sector_q.get_nowait())
            except queue.Empty:
                break
        try:
            classify_bases(list(dict.fromkeys(batch)))
        except Exception as e:      # noqa: BLE001
            log("新币归类出错: %s" % e)


def sector_sweep_worker():
    """慢扫描：每 30 分钟看一眼还有没有没归类的，没有就什么都不做（零请求）"""
    time.sleep(90)
    while True:
        try:
            with _sector_lock:
                pend = set(_sector_pending)
            with HUB.lock:
                syms = [x for x in HUB.tickers if "@" not in x]
            todo = []
            for sym in syms:
                base, _ = split_symbol(sym)
                if (base and base not in SECTORS["map"]
                        and base not in pend and base not in _sector_skip):
                    todo.append(base)
            todo = list(dict.fromkeys(todo))
            if todo:
                log("扫描到 %d 个未归类币种，开始补" % len(todo))
                for i in range(0, len(todo), 40):
                    # 用户在操作时让路：这和 K 线预取抢的是同一个代理，
                    # 后台补分类不该把首屏/切币的请求挤慢
                    while time.time() - LAST_USER_REQ < 2.0:
                        time.sleep(0.5)
                    classify_bases(todo[i:i + 40])
                    time.sleep(1)
                left = sum(1 for b in todo
                           if b not in SECTORS["map"] and b not in _sector_skip)
                log("归类扫描结束：补上 %d 个，%d 个确实不属于任何板块"
                    % (len(todo) - left, left))
                if _sector_unknown_tags:
                    # 币安新增了分类维度时，这里会冒出新标签 —— 提醒去补 TAG_MAP
                    top = sorted(_sector_unknown_tags.items(), key=lambda kv: -kv[1])[:8]
                    log("未映射的币安标签（可加进 sector_rules.TAG_MAP）：%s"
                        % "、".join("%s×%d" % (t, n) for t, n in top))
                    _sector_unknown_tags.clear()
        except Exception as e:      # noqa: BLE001
            log("归类扫描出错: %s" % e)
        time.sleep(SECTOR_RETRY_GAP)


def load_listing():
    try:
        with open(LISTING_CACHE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("v") == 2:
            LISTING.update(d.get("t", {}))
        log("载入上架时间 %d 个币种" % len(LISTING))
    except Exception:           # noqa: BLE001
        pass


def save_listing():
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with _listing_lock:
            snap = dict(LISTING)
        tmp = LISTING_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 2, "t": snap}, f, separators=(",", ":"))
        os.replace(tmp, LISTING_CACHE)
    except Exception:           # noqa: BLE001
        pass


def fetch_first_kline(sym):
    """用日线第一根的时间戳反推上架日期"""
    try:
        raw = json.loads(cached_get(
            "/api/v3/klines?symbol=%s&interval=1d&startTime=0&limit=1" % sym, 86400, timeout=12))
        if raw:
            return int(raw[0][0])
    except Exception:           # noqa: BLE001
        return None
    return None


def listing_worker():
    """后台慢慢补全每个币种的上架时间，补过的永不再查"""
    time.sleep(20)
    while True:
        with HUB.lock:
            # 只查现货 symbol：合约（带 @f）的日线接口要另走 fapi，上架时间直接沿用现货的
            todo = [x for x in HUB.tickers if "@" not in x and x not in LISTING]
        todo.sort()
        todo = todo[:72]
        if todo:
            sem = threading.Semaphore(6)

            def run(sym):
                with sem:
                    _fill_listing(sym)

            ts = [threading.Thread(target=run, args=(x,), daemon=True) for x in todo]
            for t in ts:
                t.start()
            for t in ts:
                t.join(timeout=20)
            save_listing()
        time.sleep(30)


def _fill_listing(sym):
    ts = fetch_first_kline(sym)
    if ts:
        with _listing_lock:
            LISTING[sym] = ts


# --------------------------------------------------------------------------
# 行情中枢
# --------------------------------------------------------------------------

def split_symbol(sym):
    """BTCUSDC -> ('BTC', 'USDC')；BTCUSDT@f -> ('BTC','USDT')；非目标计价对返回 (None, None)"""
    if sym.endswith("@f"):
        return split_symbol(sym[:-2])
    for q in QUOTE_ASSETS:
        if sym.endswith(q) and len(sym) > len(q):
            return sym[:-len(q)], q
    return None, None


def price_dp(s):
    """从价格字符串推断显示精度：'77862.15000000' -> 2"""
    if "." not in s:
        return 0
    frac = s.split(".")[1].rstrip("0")
    return len(frac)


class Hub:
    def __init__(self):
        self.lock = threading.Lock()
        self.tickers = {}      # sym -> dict(l,chgp,h,lo,v,qv,o,dp,ts)
        self.dirty = set()
        self.clients = set()
        self.explicit = set(SEED_SYMBOLS)   # 客户端显式要求的
        self.top = set()                    # 按成交额自动挑选的
        self.want_klines = set()
        self.depth_symbol = None
        self.trade_symbol = None
        self.ws_connected = False
        self.msg_count = 0
        self.last_ws_msg = 0.0
        self.snaps = []          # 每 10 秒一份全市场价格快照，用于算涨速
        self.load_cache()

    # -- 磁盘缓存 --------------------------------------------------------
    def load_cache(self):
        try:
            with open(TICKER_CACHE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if time.time() - data.get("ts", 0) < 86400 * 3:
                with self.lock:
                    self.tickers = data.get("t", {})
                log("载入本地行情快照 %d 个交易对" % len(self.tickers))
        except Exception:       # noqa: BLE001
            pass

    def save_cache(self):
        with self.lock:
            snap = dict(self.tickers)
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            tmp = TICKER_CACHE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"ts": time.time(), "t": snap}, f, separators=(",", ":"))
            os.replace(tmp, TICKER_CACHE)
        except Exception as e:      # noqa: BLE001
            log("快照落盘失败: %s" % e)

    # -- 客户端 ----------------------------------------------------------
    def add_client(self):
        c = Client(self)
        with self.lock:
            self.clients.add(c)
        return c

    def remove_client(self, c):
        with self.lock:
            self.clients.discard(c)

    def broadcast(self, obj):
        with self.lock:
            clients = list(self.clients)
        if not clients:
            return
        payload = obj if isinstance(obj, str) else json.dumps(obj, separators=(",", ":"))
        for c in clients:
            c.push(payload)

    # -- 订阅 ------------------------------------------------------------
    def set_wanted(self, tickers, klines, depth, trades):
        with self.lock:
            if tickers is not None:
                self.explicit = set(tickers) | set(SEED_SYMBOLS)
            self.want_klines = set(tuple(x) for x in (klines or []))
            self.depth_symbol = depth or None
            self.trade_symbol = trades or None

    def rebalance(self):
        """按成交额自动挑选实时订阅的币种"""
        with self.lock:
            ranked = sorted(self.tickers.items(), key=lambda kv: -(kv[1].get("qv") or 0))
            self.top = {k for k, _ in ranked[:TOP_TICKER_STREAMS]}

    def desired_streams(self):
        with self.lock:
            s = {"!miniTicker@arr"}
            # 全市场：按成交额从大到小，控制在单连接上限内
            spot_only = {k: v for k, v in self.tickers.items() if "@" not in k}
            ranked = sorted(spot_only.items(), key=lambda kv: -(kv[1].get("qv") or 0))
            picked = [k for k, _ in ranked[:MAX_TICKER_STREAMS]]
            for sym in set(picked) | set(SEED_SYMBOLS):
                s.add(sym.lower() + "@miniTicker")
            for sym, iv in self.want_klines:
                if sym.endswith("@f"):
                    continue        # 合约 K 线走 FuturesWorker，现货流不认 @f
                s.add(sym.lower() + "@kline_" + iv)
            # 合约 symbol 不能进现货流：btcusdt@f@depth20@100ms 是非法流名。
            # 永续盘口走 DepthWorker（标准 /stream 端点的 @depth20@100ms），
            # 现货盘口走这条流，两边都在服务端转成 {"t":"d"} 推给浏览器。
            if self.depth_symbol and not self.depth_symbol.endswith("@f"):
                s.add(self.depth_symbol.lower() + "@depth20@100ms")
            if self.trade_symbol and not self.trade_symbol.endswith("@f"):
                s.add(self.trade_symbol.lower() + "@aggTrade")
            return s

    # -- 合约行情 --------------------------------------------------------
    def on_futures_ticker(self, m):
        sym = m.get("s")
        if not sym:
            return
        key = sym + "@f"
        try:
            last_s = m["c"]
            last = float(last_s)
            op = float(m["o"]) or last
        except (KeyError, ValueError):
            return
        with self.lock:
            old = self.tickers.get(key)
            dp = price_dp(last_s)
            if old and old.get("dp", 0) > dp:
                dp = old["dp"]
            is_new = old is None
            self.tickers[key] = {
                "l": last, "chgp": float(m.get("P") or 0),
                "h": float(m["h"]), "lo": float(m["l"]),
                "v": float(m["v"]), "qv": float(m["q"]), "o": op,
                "dp": dp, "ts": time.time(), "mkt": "perp",
            }
            self.dirty.add(key)
            self.msg_count += 1
            self.last_ws_msg = time.time()
        if is_new:                  # 新合约第一次出现 → 补板块分类 + 新品种通知
            note_new_symbol(key)
            note_new_listing(key)

    # -- 涨速 ------------------------------------------------------------
    def speed(self, sym, price):
        """相对最早一份快照（约 60~70 秒前）的涨速 %"""
        snaps = self.snaps
        if not snaps or not price:
            return 0.0
        p0 = snaps[0].get(sym)
        if not p0:
            return 0.0
        return (price - p0) / p0 * 100.0

    # -- 行情写入 --------------------------------------------------------
    def on_mini_ticker(self, m):
        sym = m.get("s")
        if not sym:
            return
        base, quote = split_symbol(sym)
        if not base:
            return
        try:
            last_s = m["c"]
            last = float(last_s)
            op = float(m["o"]) or last
        except (KeyError, ValueError):
            return
        chgp = (last - op) / op * 100 if op else 0.0
        now = time.time()
        with self.lock:
            old = self.tickers.get(sym)
            dp = price_dp(last_s)
            if old and old.get("dp", 0) > dp:
                dp = old["dp"]
            is_new = old is None
            self.tickers[sym] = {
                "l": last, "chgp": chgp, "h": float(m["h"]), "lo": float(m["l"]),
                "v": float(m["v"]), "qv": float(m["q"]), "o": op, "dp": dp, "ts": now,
            }
            self.dirty.add(sym)
            self.msg_count += 1
            self.last_ws_msg = now
        if is_new:                  # 新币第一次出现 → 补板块分类 + 新品种通知
            note_new_symbol(sym)
            note_new_listing(sym)


class Client:
    def __init__(self, hub):
        self.hub = hub
        self.q = queue.Queue(maxsize=1200)
        self.alive = True

    def push(self, payload):
        try:
            self.q.put_nowait(payload)
        except queue.Full:
            try:
                self.q.get_nowait()
                self.q.put_nowait(payload)
            except queue.Empty:
                pass


HUB = Hub()


# --------------------------------------------------------------------------
# WebSocket 流线程
# --------------------------------------------------------------------------

class StreamWorker(threading.Thread):
    def __init__(self, hub):
        super().__init__(daemon=True)
        self.hub = hub
        self.applied = set()
        self.conn = None

    def run(self):
        backoff = 1.0
        while True:
            try:
                self._session()
                backoff = 1.0
            except Exception as e:      # noqa: BLE001
                log("行情流断开: %s %s" % (type(e).__name__, e))
            finally:
                self.applied = set()
                if self.conn:
                    self.conn.close()
                    self.conn = None
                with self.hub.lock:
                    self.hub.ws_connected = False
                self.hub.broadcast({"t": "ws", "up": False})
            time.sleep(backoff)
            backoff = min(backoff * 1.8, 20.0)
            if self.hub.msg_count and backoff > 4:
                backoff = 4.0

    def _session(self):
        log("连接币安行情流 ...")
        self.conn = WSConn(WS_HOST, "/stream")
        self.applied = set()
        with self.hub.lock:
            self.hub.ws_connected = True
        log("行情流已连接")
        self.hub.broadcast({"t": "ws", "up": True})
        last_sync = last_ping = 0.0
        while True:
            now = time.time()
            if now - last_sync > 0.4:
                self._sync_subs()
                last_sync = time.time()
            if now - last_ping > 150:
                self.conn._send_frame(0x9, b"hb")
                last_ping = now

            fr = self.conn.recv_frame(0.2)
            if fr is None:
                continue
            # 一次性把已到达的帧全部处理掉，避免积压导致控制帧排队
            drained = 0
            while fr is not None:
                self._handle_frame(fr)
                drained += 1
                if drained >= 500:
                    break
                fr = self.conn.recv_frame(0)

    def _handle_frame(self, fr):
        opcode, payload = fr
        if opcode == 0x9:
            self.conn._send_frame(0xA, payload)
            return
        if opcode in (0xA,):
            return
        if opcode == 0x8:
            raise ConnectionError("server closed")
        if opcode not in (0x1, 0x2):
            return
        try:
            msg = json.loads(payload)
        except Exception:       # noqa: BLE001
            return
        self._dispatch(msg)

    def _sync_subs(self):
        desired = self.hub.desired_streams()
        if desired == self.applied:
            return
        add = sorted(desired - self.applied)
        rem = sorted(self.applied - desired)
        for i in range(0, len(rem), 90):
            self.conn.send_text(json.dumps(
                {"method": "UNSUBSCRIBE", "params": rem[i:i + 100], "id": 900 + i}))
            time.sleep(0.26)
        for i in range(0, len(add), 90):
            self.conn.send_text(json.dumps(
                {"method": "SUBSCRIBE", "params": add[i:i + 100], "id": 100 + i}))
            time.sleep(0.26)
        self.applied = desired

    def _dispatch(self, msg):
        """合并流端点的消息形如 {"stream": "...", "data": {...}}，按流名路由。"""
        if not isinstance(msg, dict):
            return
        stream = msg.get("stream")
        data = msg.get("data") if stream else msg
        if data is None:
            return

        if stream == "!miniTicker@arr":
            if isinstance(data, list):
                for m in data:
                    if isinstance(m, dict):
                        self.hub.on_mini_ticker(m)
            return

        if stream and "@depth" in stream:
            if isinstance(data, dict) and "bids" in data:
                sym = stream.split("@")[0].upper()
                self.hub.broadcast({
                    "t": "d", "s": sym,
                    "b": [[float(p), float(q)] for p, q in data["bids"][:20]],
                    "a": [[float(p), float(q)] for p, q in data["asks"][:20]],
                })
            return

        if isinstance(data, list):
            for m in data:
                if isinstance(m, dict) and m.get("e") == "24hrMiniTicker":
                    self.hub.on_mini_ticker(m)
            return
        if not isinstance(data, dict):
            return

        e = data.get("e")
        if e == "24hrMiniTicker":
            self.hub.on_mini_ticker(data)
        elif e == "kline":
            k = data["k"]
            self.hub.broadcast({"t": "k", "s": k["s"], "i": k["i"],
                                "d": [k["t"], float(k["o"]), float(k["h"]), float(k["l"]),
                                      float(k["c"]), float(k["v"]), float(k["q"]),
                                      float(k["V"]), 1 if k["x"] else 0]})
        elif e == "aggTrade":
            self.hub.broadcast({"t": "r", "s": data["s"], "p": float(data["p"]),
                                "q": float(data["q"]), "m": 1 if data["m"] else 0,
                                "T": data["T"]})


# --------------------------------------------------------------------------
# 合约行情线程（走本机 SOCKS5）
# --------------------------------------------------------------------------

class FuturesWorker(threading.Thread):
    """fstream.binance.com/market/stream
    - `!ticker@arr`：每秒一次全市场合约快照
    - 按需订阅合约 K 线与 aggTrade（实测这条网关**不提供 depth 流**）
    """

    def __init__(self, hub):
        super().__init__(daemon=True)
        self.hub = hub
        self.conn = None
        self.applied = set()
        self.state = "init"      # init / ok / blocked / off

    def run(self):
        backoff = 5.0
        while True:
            try:
                self._session()
                backoff = 5.0
            except PermissionError as e:
                self.state = "blocked"
                log("合约行情不可用：%s（代理节点被币安限制）" % e)
                time.sleep(600)
                continue
            except Exception as e:      # noqa: BLE001
                self.state = "off"
                log("合约行情断开: %s %s" % (type(e).__name__, e))
            finally:
                self.applied = set()
                if self.conn:
                    self.conn.close()
                    self.conn = None
            time.sleep(backoff)
            backoff = min(backoff * 1.6, 60)

    def _session(self):
        if not SOCKS_PROXY:
            self.state = "off"
            raise ConnectionError("未检测到代理")
        log("连接币安合约行情流（经代理）...")
        self.conn = WSConn(FWS_HOST, FWS_PATH, timeout=20, use_proxy=True)
        self.state = "ok"
        log("合约行情流已连接")
        self.applied = {"!ticker@arr"}
        self.conn.send_text(json.dumps({"method": "SUBSCRIBE", "params": ["!ticker@arr"], "id": 1}))
        last_ping = time.time()
        last_sync = 0.0
        while True:
            now = time.time()
            if now - last_sync > 1.2:
                self._sync_subs()
                last_sync = time.time()
            if now - last_ping > 150:
                self.conn._send_frame(0x9, b"hb")
                last_ping = now
            fr = self.conn.recv_frame(0.5)
            if fr is None:
                continue
            op, payload = fr
            if op == 0x9:
                self.conn._send_frame(0xA, payload)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                raise ConnectionError("server closed")
            if op not in (0x1, 0x2):
                continue
            try:
                msg = json.loads(payload)
            except Exception:       # noqa: BLE001
                continue
            self._dispatch(msg)

    def _wanted(self):
        with self.hub.lock:
            kl = set(self.hub.want_klines)
            tr = self.hub.trade_symbol
        want = {"!ticker@arr"}
        for sym, iv in kl:
            if sym.endswith("@f"):
                want.add(sym[:-2].lower() + "@kline_" + iv)
        if tr and tr.endswith("@f"):
            want.add(tr[:-2].lower() + "@aggTrade")
        return want

    def _sync_subs(self):
        want = self._wanted()
        if want == self.applied:
            return
        add = sorted(want - self.applied)
        rem = sorted(self.applied - want)
        for i in range(0, len(rem), 40):
            self.conn.send_text(json.dumps(
                {"method": "UNSUBSCRIBE", "params": rem[i:i + 40], "id": 800 + i}))
            time.sleep(0.25)
        for i in range(0, len(add), 40):
            self.conn.send_text(json.dumps(
                {"method": "SUBSCRIBE", "params": add[i:i + 40], "id": 100 + i}))
            time.sleep(0.25)
        self.applied = want

    def _dispatch(self, msg):
        data = msg.get("data") if isinstance(msg, dict) and "data" in msg else msg
        if isinstance(data, list):
            for x in data:
                if isinstance(x, dict) and x.get("e") == "24hrTicker":
                    self.hub.on_futures_ticker(x)
            return
        if not isinstance(data, dict):
            return
        e = data.get("e")
        if e == "kline":
            k = data["k"]
            # 前端用带 @f 的 symbol 匹配格子，这里补上后缀
            self.hub.broadcast({"t": "k", "s": k["s"] + "@f", "i": k["i"],
                                "d": [k["t"], float(k["o"]), float(k["h"]), float(k["l"]),
                                      float(k["c"]), float(k["v"]), float(k["q"]),
                                      float(k["V"]), 1 if k["x"] else 0]})
        elif e == "aggTrade":
            self.hub.broadcast({"t": "r", "s": data["s"] + "@f", "p": float(data["p"]),
                                "q": float(data["q"]), "m": 1 if data["m"] else 0,
                                "T": data["T"]})


FUTURES = None
FUT_DEPTH = None


class DepthWorker(threading.Thread):
    """fstream.binance.com/stream —— 合约盘口（实时）

    之前文档里「合约没有 depth 流」的结论只对 `/market/stream`（网页版网关）成立。
    标准合并流端点 `/stream` 是给 depth 的，实测 `@depth20@100ms` 稳定 100ms 一帧，
    而且这一条不需要 `!ticker@arr`，所以单独开一条连接，只订阅当前正在看的那个合约。

    优先级：`depth_symbol` 是永续时才订阅；现货盘口走现货流（StreamWorker）。
    """

    def __init__(self, hub):
        super().__init__(daemon=True)
        self.hub = hub
        self.conn = None
        self.applied = set()
        self.state = "init"      # init / ok / off

    def run(self):
        backoff = 5.0
        while True:
            try:
                self._session()
                backoff = 5.0
            except Exception as e:      # noqa: BLE001
                self.state = "off"
                log("合约盘口流断开: %s %s" % (type(e).__name__, e))
            finally:
                self.applied = set()
                if self.conn:
                    self.conn.close()
                    self.conn = None
            time.sleep(backoff)
            backoff = min(backoff * 1.6, 60)

    def _wanted(self):
        with self.hub.lock:
            sym = self.hub.depth_symbol
        if sym and sym.endswith("@f"):
            return {sym[:-2].lower() + "@depth20@100ms"}
        return set()

    def _sync_subs(self):
        want = self._wanted()
        if want == self.applied:
            return
        add = sorted(want - self.applied)
        rem = sorted(self.applied - want)
        if rem:
            self.conn.send_text(json.dumps({"method": "UNSUBSCRIBE", "params": rem, "id": 810}))
        if add:
            self.conn.send_text(json.dumps({"method": "SUBSCRIBE", "params": add, "id": 110}))
        self.applied = want

    def _session(self):
        if not SOCKS_PROXY:
            self.state = "off"
            raise ConnectionError("未检测到代理")
        log("连接币安合约盘口流...")
        self.conn = WSConn(FWS_HOST, FWS_DEPTH_PATH, timeout=20, use_proxy=True)
        self.state = "ok"
        log("合约盘口流已连接")
        last_ping = time.time()
        last_sync = 0.0
        while True:
            now = time.time()
            # 对账快一点：用户切币后盘口能早 0.7 秒出来
            if now - last_sync > 0.3:
                self._sync_subs()
                last_sync = now
            if now - last_ping > 150:
                self.conn._send_frame(0x9, b"hb")
                last_ping = now
            fr = self.conn.recv_frame(0.5)
            if fr is None:
                continue
            op, payload = fr
            if op == 0x9:
                self.conn._send_frame(0xA, payload)
                continue
            if op == 0xA:
                continue
            if op == 0x8:
                raise ConnectionError("server closed")
            if op not in (0x1, 0x2):
                continue
            try:
                msg = json.loads(payload)
            except Exception:       # noqa: BLE001
                continue
            self._dispatch(msg)

    def _dispatch(self, msg):
        data = msg.get("data") if isinstance(msg, dict) and "data" in msg else msg
        if not isinstance(data, dict):
            return
        b, a, s = data.get("b"), data.get("a"), data.get("s")
        if not b or not a or not s:
            return                      # 订阅确认 / 心跳之类的消息
        # 和 REST /api/depth 保持同一种形状：[[价格, 数量], ...]，数字不是字符串
        self.hub.broadcast({
            "t": "d",
            "s": s + "@f",
            "b": [[float(p), float(q)] for p, q in b],
            "a": [[float(p), float(q)] for p, q in a],
        })


# --------------------------------------------------------------------------
# 合约衍生指标：资金费率 / 标记价 / 指数价
# --------------------------------------------------------------------------

FUNDING = {}                 # "BTCUSDT" -> {"fr": 0.0001, "nft": ms, "mp": ..., "ip": ...}
_funding_lock = threading.Lock()
FUNDING_INTERVAL = 60        # 全量 premiumIndex 一次 210KB / 约 1.1s，60 秒足够


def funding_worker():
    """一次请求拿到全部合约的资金费率，只把发生变化的推给前端"""
    time.sleep(5)
    while True:
        try:
            raw = json.loads(cached_fapi("/fapi/v1/premiumIndex", 25, 40))
            now = time.time()
            changed = []
            with _funding_lock:
                for m in raw:
                    sym = m.get("symbol")
                    if not sym:
                        continue
                    try:
                        fr = float(m.get("lastFundingRate") or 0)
                        nft = int(m.get("nextFundingTime") or 0)
                        mp = float(m.get("markPrice") or 0)
                        ip = float(m.get("indexPrice") or 0)
                    except (TypeError, ValueError):
                        continue
                    old = FUNDING.get(sym)
                    FUNDING[sym] = {"fr": fr, "nft": nft, "mp": mp, "ip": ip, "ts": now}
                    # 费率或结算时间变了才推送，避免每分钟重复发 945 条
                    if old is None or old["fr"] != fr or old["nft"] != nft:
                        changed.append([sym + "@f", round(fr * 100, 6), nft])
            if changed:
                HUB.broadcast({"t": "fund", "d": changed})
                if len(changed) > 20:
                    log("资金费率更新 %d 个合约" % len(changed))
        except Exception as e:      # noqa: BLE001
            log("资金费率获取失败: %s %s" % (type(e).__name__, e))
        time.sleep(FUNDING_INTERVAL)


def funding_of(sym):
    """sym 可带 @f 后缀"""
    key = sym[:-2] if sym.endswith("@f") else sym
    with _funding_lock:
        f = FUNDING.get(key)
        return dict(f) if f else None


# --------------------------------------------------------------------------
# 启动预热：一次全量 24h 快照，让冷门币和 USDC 对立刻可见
# --------------------------------------------------------------------------

def bootstrap_market():
    time.sleep(1.5)
    try:
        raw = json.loads(cached_get("/api/v3/ticker/24hr", 1800, timeout=90))
    except Exception as e:      # noqa: BLE001
        log("全量行情预热失败: %s" % e)
        return
    added = 0
    with HUB.lock:
        for t in raw:
            sym = t.get("symbol") or ""
            base, quote = split_symbol(sym)
            if not base:
                continue
            try:
                qv = float(t["quoteVolume"])
                if qv < 1000:
                    continue
                last_s = t["lastPrice"]
                last = float(last_s)
                op = float(t["openPrice"]) or last
                row = {
                    "l": last, "chgp": (last - op) / op * 100 if op else 0.0,
                    "h": float(t["highPrice"]), "lo": float(t["lowPrice"]),
                    "v": float(t["volume"]), "qv": qv, "o": op,
                    "dp": price_dp(last_s), "ts": time.time(),
                }
            except (KeyError, ValueError):
                continue
            old = HUB.tickers.get(sym)
            if old is None:          # 已有 WS 实时数据的不覆盖
                HUB.tickers[sym] = row
                added += 1
    log("全量行情预热：新增 %d 个交易对（共 %d）" % (added, len(HUB.tickers)))


# --------------------------------------------------------------------------
# 后台线程：tick 合并推送 / 订阅再平衡 / 快照落盘
# --------------------------------------------------------------------------

def push_loop():
    last_save = time.time()
    last_rebalance = time.time()
    last_snap = time.time()
    last_kl_save = time.time()
    last_slow = time.time()

    def row(sym):
        t = HUB.tickers.get(sym)
        if not t:
            return None
        return [sym, t["l"], t["chgp"], t["h"], t["lo"], t["v"], t["qv"],
                round(HUB.speed(sym, t["l"]), 3)]

    while True:
        time.sleep(FAST_TICK_INTERVAL)
        now = time.time()

        # 焦点品种（客户端显式订阅的那几十个：格子/大图/自选/行情条）单独高频推，
        # 让正在看的东西跟手；全市场仍然 0.7 秒一批，免得 1800 个币把带宽打满。
        # 注意这里**不清 dirty**：慢批次还会把它们带上，重复推一次没有副作用。
        with HUB.lock:
            fast = [r for r in (row(sym) for sym in HUB.dirty if sym in HUB.explicit) if r]
        if fast:
            HUB.broadcast({"t": "tk", "d": fast})

        if now - last_slow < TICK_PUSH_INTERVAL:
            continue
        last_slow = now
        with HUB.lock:
            batch = [r for r in (row(sym) for sym in HUB.dirty) if r]
            HUB.dirty.clear()
        if batch:
            HUB.broadcast({"t": "tk", "d": batch})
        if now - last_snap > 10:
            last_snap = now
            with HUB.lock:
                HUB.snaps.append({k: v["l"] for k, v in HUB.tickers.items()})
                if len(HUB.snaps) > 7:
                    HUB.snaps.pop(0)
        if now - last_save > TICKER_SAVE_INTERVAL:
            last_save = now
            HUB.save_cache()
        if now - last_kl_save > 120:
            last_kl_save = now
            save_klines()
        if now - last_rebalance > 120:
            last_rebalance = now
            HUB.rebalance()


# --------------------------------------------------------------------------
# K 线缓存：整段只拉一次，之后只补最近几根
# --------------------------------------------------------------------------

IV_MS = {
    "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
    "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000,
    "8h": 28800000, "12h": 43200000, "1d": 86400000, "3d": 259200000,
    "1w": 604800000, "1M": 2592000000,
}
KLINE_TTL = 30.0           # 这么新的缓存直接返回，不打接口（前端 WS 会实时补最后一根）
KLINE_KEEP = 3000          # 单条序列最多留多少根
KLINE_MAX_SERIES = 1200    # 内存里最多留多少条序列（磁盘不限，内存淘汰后下次从盘里读回来）
KLINE_FETCH = 1000         # 首次拉取多拉一些存着，用户往前拖不用再请求
KLINES_DIR = os.path.join(CACHE_DIR, "klines")     # 每条序列一个文件，按需读
DISK_MAX_FILES = 6000      # 磁盘最多留多少个分片
KLINES = {}
_klines_lock = threading.Lock()
_klines_dirty = False
_dirty_keys = set()
_dirty_lock = threading.Lock()

# 切周期是最常见的动作：第一次看某个币时，把其余周期排进队列预热
OTHER_IVS = ["5m", "15m", "1h", "4h", "1d"]
_prefetch_q = queue.Queue(maxsize=400)
_seen_symbols = set()
_seen_lock = threading.Lock()
# 同一个 key 同时只允许一个请求在飞：预取和用户请求撞上时，后来的等前一个
_inflight = {}
_inflight_lock = threading.Lock()
PERP_CACHE = {}              # 合约详情结果缓存（10 秒），去重时给等待方直接用
_perp_cache_lock = threading.Lock()


def _fetch_klines(perp, sym, iv, limit, start=None, end=None):
    """拉一段 K 线，返回 [[t, o, h, l, c, v, q, tb], ...]

    tb = 主动买成交量（币安 K 线的第 10 个字段）。
    有了它前端才能算 CVD：每根柱子 Δ = 2*tb - v（主动买 - 主动卖），累加就是曲线。

    start：从这个时间往后拉（增量补）
    end：拉这个时间之前的（用户往左拖加载历史）
    """
    if perp:
        path = "/fapi/v1/klines?symbol=%s&interval=%s&limit=%d" % (sym, iv, limit)
        if start:
            path += "&startTime=%d" % start
        if end:
            path += "&endTime=%d" % end
        if start or end:
            raw = json.loads(fapi_get(path, 30))
        else:
            raw = json.loads(cached_fapi(path, 2, 30))
    else:
        path = "/api/v3/klines?symbol=%s&interval=%s&limit=%d" % (sym, iv, limit)
        if start:
            path += "&startTime=%d" % start
        if end:
            path += "&endTime=%d" % end
        if start or end:
            raw = json.loads(http_get(path))
        else:
            raw = json.loads(cached_get(path, 2))
    return [[int(k[0]), float(k[1]), float(k[2]), float(k[3]),
             float(k[4]), float(k[5]), float(k[7]), float(k[9])] for k in raw]


def _merge_bars(old, new):
    """按开盘时间合并，新数据覆盖同一根（最后一根通常是还在走的）"""
    if not new:
        return old
    d = {b[0]: b for b in old}
    for b in new:
        d[b[0]] = b
    return [d[t] for t in sorted(d)]


def get_klines_before(perp, sym, iv, limit, before):
    """拉 before 之前的 limit 根，并合并进缓存。返回 [[...], ...]（可能为空=到头了）"""
    key = ("f:" if perp else "s:") + sym + "|" + iv
    with _klines_lock:
        ent = KLINES.get(key)
    if ent is None:
        ent = _read_disk(key)
        if ent:
            with _klines_lock:
                KLINES[key] = ent
    bars = ent["bars"] if ent else []
    before = int(before)

    # 缓存里已经有比 before 更早的，直接切一段给它，连接口都不用打。
    # （服务端缓存可能比前端手上那批厚得多：前端 500 根，缓存 1500 根）
    if bars and bars[0][0] < before:
        earlier = [b for b in bars if b[0] < before]
        if earlier:
            return earlier[-limit:]

    try:
        raw = _fetch_klines(perp, sym, iv, limit, end=before)
    except Exception:           # noqa: BLE001
        return []
    if not raw:
        return []
    # 币安按 endTime 返回时包含边界那根，裁掉（它在缓存里已经有了）
    raw = [b for b in raw if b[0] < before]
    if not raw:
        return []               # 到最早了

    merged = _merge_bars(raw, bars)
    if len(merged) > KLINE_KEEP:
        merged = merged[-KLINE_KEEP:]
    with _klines_lock:
        KLINES[key] = {"ts": time.time(), "bars": merged}
    with _dirty_lock:
        _dirty_keys.add(key)
    return raw


def get_klines(perp, sym, iv, limit, prefetch=False, bg=False):
    global _klines_dirty
    key = ("f:" if perp else "s:") + sym + "|" + iv
    step = IV_MS.get(iv, 60000)
    now = time.time()
    # 周期越大，缓存留得越久（1 分钟图 30 秒，日线留 5 分钟）
    ttl = max(KLINE_TTL, min(300.0, step / 2000.0))
    with _klines_lock:
        ent = KLINES.get(key)
    if ent is None:
        # 内存里没有，先看看磁盘上有没有（重启后第一件事就是这个）
        ent = _read_disk(key)
        if ent:
            with _klines_lock:
                KLINES[key] = ent
    if ent and now - ent["ts"] < ttl and len(ent["bars"]) >= min(limit, 50):
        return ent["bars"][-limit:]

    # 过期了但手上有一份完整数据：先把旧的给前端（最后一根有 K 线流实时补），
    # 后台再去补缺口。原来这里会同步等币安，切回一个 30 秒没看的币就要多等 0.3~0.8 秒。
    # 只差一两根时才这么做：差得多说明中间断档了，K 线流补不回来，必须同步拉全。
    missing = ((now * 1000 - ent["bars"][-1][0]) / step) if (ent and ent["bars"]) else 999
    if (ent and not bg and not prefetch and missing <= 2
            and len(ent["bars"]) >= min(limit, 50)):
        threading.Thread(
            target=lambda: get_klines(perp, sym, iv, limit, prefetch=False, bg=True),
            daemon=True).start()
        return ent["bars"][-limit:]

    bars = ent["bars"] if ent else []
    start = int(bars[-1][0]) if bars else None
    if start is not None and (now * 1000 - start) / step > limit:
        start = None        # 落后太多，增量不划算，整段重拉

    # 同一个 key 正在被别人拉（预取线程 / 另一个格子），等它拉完直接用结果，
    # 否则两边同时打币安，用户反而等更久
    with _inflight_lock:
        ev = _inflight.get(key)
        owner = ev is None
        if owner:
            ev = threading.Event()
            _inflight[key] = ev

    if not owner:
        ev.wait(8)
        with _klines_lock:
            done = KLINES.get(key)
        if done and len(done["bars"]) >= min(limit, 50):
            return done["bars"][-limit:]
        # 等的人失败了，自己再来一次
        with _inflight_lock:
            if key not in _inflight:
                _inflight[key] = threading.Event()
                owner = True
                ev = _inflight[key]

    try:
        if start is None:
            # 首次多拉一些存着：用户往左拖、切大图都不用再打接口
            fresh = _fetch_klines(perp, sym, iv, max(limit, KLINE_FETCH))
            # 隔了很久再打开时 start 会被置空走这条路，别把磁盘上更早的历史冲掉
            if bars and fresh and bars[0][0] < fresh[0][0]:
                older = [b for b in bars if b[0] < fresh[0][0]]
                merged = older + fresh
            else:
                merged = fresh
        else:
            need = int((now * 1000 - start) / step) + 3
            merged = _merge_bars(bars, _fetch_klines(perp, sym, iv, max(2, min(need, 500)), start))
    except Exception:           # noqa: BLE001
        if owner:
            with _inflight_lock:
                _inflight.pop(key, None)
            ev.set()
        if bars:
            log("K 线拉取失败，用缓存兜底: %s %s" % (sym, iv))
            return bars[-limit:]        # 网络抖的时候先看旧的，别白屏
        raise

    if len(merged) > KLINE_KEEP:
        merged = merged[-KLINE_KEEP:]
    with _klines_lock:
        KLINES[key] = {"ts": now, "bars": merged}
        if len(KLINES) > KLINE_MAX_SERIES:
            # 只从内存里淘汰，磁盘上还在，下次用到再读回来
            for k in sorted(KLINES, key=lambda x: KLINES[x]["ts"])[:40]:
                KLINES.pop(k, None)
    with _dirty_lock:
        _dirty_keys.add(key)
    if not prefetch:
        _maybe_prefetch_other(perp, sym, iv)
    if owner:
        with _inflight_lock:
            _inflight.pop(key, None)
        ev.set()
    return merged[-limit:]


def _maybe_prefetch_other(perp, sym, iv):
    """第一次看某个币时，把它其余几个周期排进预取队列。

    用户切周期是最常见的动作，切之前备好就不用等那 1~2 秒。
    每个币只排一次，队列满了就放弃。
    """
    sk = ("f:" if perp else "s:") + sym
    with _seen_lock:
        if sk in _seen_symbols:
            return
        _seen_symbols.add(sk)
        if len(_seen_symbols) > 3000:
            _seen_symbols.clear()
    for o in OTHER_IVS:
        if o == iv:
            continue
        try:
            _prefetch_q.put_nowait((perp, sym, o))
        except queue.Full:
            return


def kline_prefetch_worker():
    """后台把队列里的周期一个个拉好；用户一有请求就让路"""
    while True:
        try:
            perp, sym, iv = _prefetch_q.get(timeout=5)
        except queue.Empty:
            continue
        while time.time() - LAST_USER_REQ < 1.5:
            time.sleep(0.3)
        try:
            get_klines(perp, sym, iv, 500, prefetch=True)
        except Exception:       # noqa: BLE001
            pass
        time.sleep(0.8)     # 间隔长一点，别和用户请求抢连接


def prefetch_klines():
    """后台预热默认格子的 1m K 线。

    用户第一次打开某个币的图，服务端要现去币安拉 500 根，1~3 秒。
    启动后先把默认那 12 个拉好，页面打开时直接命中缓存（5ms）。
    3 个线程并发、每个之间歇 200ms，别把带宽和代理吃满。
    """
    # 等首屏那 8 个 K 线请求先跑完，别跟用户抢带宽
    time.sleep(6)
    # 默认格子 + 成交额前 40（现货和合约都算），用户随手点一个多半已经备好了
    queue = list(SEED_SYMBOLS[:12])
    with HUB.lock:
        ranked = sorted(HUB.tickers.items(), key=lambda kv: -(kv[1].get("qv") or 0))
        top = [k for k, _ in ranked][:40]
    for sym in top:
        if sym not in queue:
            queue.append(sym)
    lock = threading.Lock()

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                sym = queue.pop(0)
            key = "s:" + sym + "|1m"
            with _klines_lock:
                ent = KLINES.get(key)
            if ent and time.time() - ent["ts"] < 20:
                continue            # 已经有新鲜的，别重复拉
            # 用户一有请求就让路，别把带宽和代理抢走
            while time.time() - LAST_USER_REQ < 2.0:
                time.sleep(0.4)
            try:
                get_klines(False, sym, "1m", 500)
            except Exception:       # noqa: BLE001
                pass
            time.sleep(0.4)

    for _ in range(3):
        threading.Thread(target=worker, daemon=True).start()


def _kfile(key):
    """key 形如 s:BTCUSDT|1m / f:BTCUSDT@1m，转成安全文件名"""
    name = key.replace(":", "_").replace("|", "_").replace("@", "_")
    return os.path.join(KLINES_DIR, name + ".json")


def _read_disk(key):
    try:
        with open(_kfile(key), "r", encoding="utf-8") as f:
            d = json.load(f)
        bars = d.get("bars") or []
        # 旧版本的缓存是 7 个字段（没有主动买量），CVD 算不出来，直接丢弃重拉
        if bars and len(bars[0]) >= 8:
            return {"ts": d.get("ts", 0), "bars": bars}
    except Exception:           # noqa: BLE001
        pass
    return None


def _write_disk(key, ent):
    os.makedirs(KLINES_DIR, exist_ok=True)
    p = _kfile(key)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"ts": ent.get("ts", 0), "bars": ent["bars"]}, f, separators=(",", ":"))
    os.replace(tmp, p)


def _prune_disk():
    """分片太多就按修改时间删最旧的"""
    try:
        files = [os.path.join(KLINES_DIR, f) for f in os.listdir(KLINES_DIR) if f.endswith(".json")]
        if len(files) <= DISK_MAX_FILES:
            return
        files.sort(key=lambda p: os.path.getmtime(p))
        for p in files[:len(files) - DISK_MAX_FILES]:
            try:
                os.remove(p)
            except Exception:   # noqa: BLE001
                pass
    except Exception:           # noqa: BLE001
        pass


def kline_saver():
    """后台把改动过的序列写回磁盘（每条一个文件，不整体重写）"""
    while True:
        time.sleep(2.0)
        with _dirty_lock:
            keys = list(_dirty_keys)
            _dirty_keys.clear()
        if not keys:
            continue
        for k in keys:
            with _klines_lock:
                ent = KLINES.get(k)
            if not ent:
                continue
            try:
                _write_disk(k, ent)
            except Exception:   # noqa: BLE001
                pass
        if len(keys) > 20:
            _prune_disk()


def load_klines():
    """启动时**不**全量载入（分片可能上千个），只把老的单文件缓存迁过来。

    真正读取发生在 get_klines() 里：内存没有就去磁盘捞那一条，几毫秒。
    """
    try:
        if not os.path.exists(KLINES_FILE):
            return
        with open(KLINES_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        n = 0
        for k, v in (d.get("s") or {}).items():
            if v.get("bars"):
                try:
                    _write_disk(k, v)
                    n += 1
                except Exception:       # noqa: BLE001
                    pass
        os.replace(KLINES_FILE, KLINES_FILE + ".migrated")
        log("K 线缓存迁移到分片目录：%d 条" % n)
    except Exception:           # noqa: BLE001
        pass


def save_klines(force=False):
    """兼容旧调用：把所有脏序列标一遍，由 kline_saver 后台写盘"""
    if not force and not _dirty_keys:
        return
    with _klines_lock:
        keys = list(KLINES.keys())
    with _dirty_lock:
        _dirty_keys.update(keys)


# --------------------------------------------------------------------------
# 前端报错落盘
# --------------------------------------------------------------------------

FRONT_LOG = os.path.join(CACHE_DIR, "frontend-errors.log")
_front_log_lock = threading.Lock()
_front_log_seen = {}          # 同一条错误 5 分钟内只记一次，防止刷屏


def append_frontend_log(body):
    """前端 window.onerror / unhandledrejection 送过来的错误。

    打包成 exe 后用户看不到 DevTools，白屏时只能靠这个文件定位。
    """
    msg = str(body.get("msg") or "")[:2000]
    if not msg:
        return
    key = msg[:160]
    now = time.time()
    with _front_log_lock:
        if now - _front_log_seen.get(key, 0) < 300:
            return
        _front_log_seen[key] = now
        if len(_front_log_seen) > 500:
            _front_log_seen.clear()
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(FRONT_LOG, "a", encoding="utf-8") as f:
                f.write("[%s] %s\n  url=%s\n  stack=%s\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), msg,
                    body.get("url") or "", str(body.get("stack") or "")[:4000]))
        except Exception:       # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".map": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BinanceTerminal/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        enc = ""
        # 行情快照 450KB，压完约 60KB；本地传输省得有限，但浏览器解析明显快
        if len(body) > 8192 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 5)
            enc = "gzip"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if enc:
            self.send_header("Content-Encoding", enc)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _chunk(self, text):
        data = text.encode()
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    # ------------------------------------------------------------------
    def do_GET(self):
        global LAST_USER_REQ
        LAST_USER_REQ = time.time()
        u = urlparse(self.path)
        try:
            if u.path == "/api/stream":
                return self.sse()
            if u.path == "/api/market":
                return self.api_market()
            if u.path == "/api/klines":
                return self.api_klines(parse_qs(u.query))
            if u.path == "/api/depth":
                return self.api_depth(parse_qs(u.query))
            if u.path == "/api/trades":
                return self.api_trades(parse_qs(u.query))
            if u.path == "/api/oihist":
                return self.api_oihist(parse_qs(u.query))
            if u.path == "/api/lsrh":
                return self.api_lsrh(parse_qs(u.query))
            if u.path == "/api/perp":
                return self.api_perp(parse_qs(u.query))
            if u.path == "/api/intraday":
                return self.api_intraday(parse_qs(u.query))
            if u.path == "/api/fundinghist":
                return self.api_fundinghist(parse_qs(u.query))
            if u.path == "/api/status":
                with HUB.lock:
                    return self._json({
                        "ws": HUB.ws_connected, "msgs": HUB.msg_count,
                        "tickers": len(HUB.tickers), "clients": len(HUB.clients),
                        "streams": len(HUB.explicit | HUB.top) + len(HUB.want_klines),
                        "last": int(HUB.last_ws_msg * 1000),
                        "fut": FUTURES.state if FUTURES else "off",
                        "futdepth": FUT_DEPTH.state if FUT_DEPTH else "off",
                        "depth": HUB.depth_symbol or "",
                        "trades": HUB.trade_symbol or "",
                    })
            return self.static(u.path)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as e:      # noqa: BLE001
            if isinstance(e, OSError):
                self.close_connection = True
                return
            log("GET %s 失败: %s %s" % (u.path, type(e).__name__, e))
            try:
                self._json({"error": "%s: %s" % (type(e).__name__, e)}, 500)
            except Exception:       # noqa: BLE001
                pass

    def do_POST(self):
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:       # noqa: BLE001
            body = {}
        if u.path == "/api/sub":
            HUB.set_wanted(body.get("tickers"), body.get("klines"),
                           body.get("depth"), body.get("trades"))
            return self._json({"ok": True})
        if u.path == "/api/log":
            append_frontend_log(body)
            return self._json({"ok": True})
        self._json({"error": "not found"}, 404)

    # ------------------------------------------------------------------
    def api_market(self):
        with HUB.lock:
            snap = dict(HUB.tickers)
        with _funding_lock:
            fund_snap = dict(FUNDING)
        rows = []
        for sym, t in snap.items():
            perp = sym.endswith("@f")
            base, quote = split_symbol(sym)
            if not base or base in STABLE_BASES:
                continue
            sec = SECTORS["map"].get(base, [])
            # 股票市场细分：加密币一律空数组，前端只对非空的行显示
            reg = REGIONS["map"].get(base) or REGIONS["map"].get(base[:-1]) or []
            # 上架时间按现货 symbol 存，永续取同一个 base 的现货日期
            ln_key = sym[:-2] if perp else sym
            row = {
                "s": sym, "b": base, "q": quote, "dp": t.get("dp", 2),
                "mkt": "perp" if perp else "spot",
                "spd": round(HUB.speed(sym, t["l"]), 3),
                "l": t["l"], "chgp": round(t["chgp"], 4),
                "o": t["o"], "h": t["h"], "lo": t["lo"],
                "v": t["v"], "qv": t["qv"],
                "wavg": (t["qv"] / t["v"]) if t["v"] else t["l"],
                "sec": sec,
                "reg": reg,
                "ln": LISTING.get(ln_key),
            }
            if reg:
                row["nm"] = stock_name(base)
            if perp:
                f = fund_snap.get(sym[:-2])
                if f:
                    row["fr"] = round(f["fr"] * 100, 6)   # 百分比，便于直接显示
                    row["nft"] = f["nft"]
                    # 标记价 / 指数价：扫描器算基差用，免得每个合约再单拉一次 /api/perp
                    if f.get("mp"):
                        row["mp"] = f["mp"]
                    if f.get("ip"):
                        row["ip"] = f["ip"]
            rows.append(row)
        rows.sort(key=lambda r: -r["qv"])
        self._json({"ts": int(time.time() * 1000), "rows": rows,
                    "labels": SECTORS["labels"],
                    "regions": {"labels": REGIONS["labels"], "order": REGIONS["order"]}})

    def api_klines(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = sym[:-2] if perp else sym.upper()
        iv = (qs.get("interval") or ["1m"])[0]
        limit = min(int((qs.get("limit") or ["400"])[0]), 1000)
        before = qs.get("before")
        if before:
            out = get_klines_before(perp, sym, iv, limit, int(before[0]))
            return self._json({"symbol": sym, "interval": iv, "k": out, "more": bool(out)})
        out = get_klines(perp, sym, iv, limit)
        self._json({"symbol": sym, "interval": iv, "k": out})

    def api_oihist(self, qs):
        """持仓量历史：/futures/data/openInterestHist（和 /fapi 一样走 www 域名）"""
        sym = (qs.get("symbol") or ["BTCUSDT"])[0].replace("@f", "").upper()
        period = (qs.get("period") or ["5m"])[0]
        if period not in ("5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"):
            period = "5m"
        limit = min(int((qs.get("limit") or ["500"])[0]), 500)
        # 持仓量历史最小粒度也是 5m，缓存 2 分钟不会看到旧数据；
        # 单次要走代理 3~5 秒，大图里切周期 / 反复开关持仓量全靠它挡
        raw = json.loads(cached_fapi(
            "/futures/data/openInterestHist?symbol=%s&period=%s&limit=%d" % (sym, period, limit), 120, 30))
        self._json({"h": [[int(x["timestamp"]), float(x["sumOpenInterest"]),
                           float(x["sumOpenInterestValue"])] for x in raw]})

    def api_lsrh(self, qs):
        """多空账户比历史"""
        sym = (qs.get("symbol") or ["BTCUSDT"])[0].replace("@f", "").upper()
        period = (qs.get("period") or ["5m"])[0]
        if period not in ("5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"):
            period = "5m"
        limit = min(int((qs.get("limit") or ["60"])[0]), 500)
        raw = json.loads(cached_fapi(
            "/futures/data/globalLongShortAccountRatio?symbol=%s&period=%s&limit=%d" % (sym, period, limit), 60, 30))
        self._json({"h": [[int(x["timestamp"]), float(x["longShortRatio"]),
                           float(x["longAccount"]) * 100] for x in raw]})

    def api_depth(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = sym[:-2] if perp else sym.upper()
        limit = min(int((qs.get("limit") or ["20"])[0]), 1000)  # 盘口合并粒度大时要更多原始档
        if perp:
            # 合约 depth 只认这几档，传 200 会被当成非法值
            limit = next((v for v in (5, 10, 20, 50, 100, 500, 1000) if v >= limit), 1000)
        else:
            limit = next((v for v in (5, 10, 20, 50, 100, 500, 1000, 5000) if v >= limit), 5000)
        if perp:
            raw = json.loads(cached_fapi("/fapi/v1/depth?symbol=%s&limit=%d" % (sym, limit), 1, 30))
        else:
            raw = json.loads(cached_get("/api/v3/depth?symbol=%s&limit=%d" % (sym, limit), 1))
        self._json({"symbol": sym,
                    "b": [[float(p), float(q)] for p, q in raw["bids"]],
                    "a": [[float(p), float(q)] for p, q in raw["asks"]]})

    def api_trades(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = sym[:-2] if perp else sym.upper()
        limit = min(int((qs.get("limit") or ["30"])[0]), 100)
        if perp:
            raw = json.loads(cached_fapi("/fapi/v1/aggTrades?symbol=%s&limit=%d" % (sym, limit), 2, 30))
        else:
            raw = json.loads(cached_get(
                "/api/v3/aggTrades?symbol=%s&limit=%d" % (sym, limit), 2))
        self._json({"symbol": sym, "t": [[float(x["p"]), float(x["q"]),
                                          x["T"], 1 if x["m"] else 0] for x in raw]})

    # -- 合约衍生指标 ------------------------------------------------------
    def api_perp(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        sym = (sym[:-2] if sym.endswith("@f") else sym).upper()
        # 列表详情 + 大图盘口栏可能同时问同一个币，别让它们各打一次币安
        now = time.time()
        with _perp_cache_lock:
            hit = PERP_CACHE.get(sym)
            if hit and hit[0] > now:
                return self._json(hit[1])

        ck = "perp:" + sym
        with _inflight_lock:
            ev = _inflight.get(ck)
            owner = ev is None
            if owner:
                ev = threading.Event()
                _inflight[ck] = ev
        if not owner:
            ev.wait(6)
            with _perp_cache_lock:
                hit = PERP_CACHE.get(sym)
                if hit:
                    return self._json(hit[1])
            with _inflight_lock:
                if ck not in _inflight:
                    _inflight[ck] = threading.Event()
                    ev = _inflight[ck]
                    owner = True
        base, quote = split_symbol(sym)
        f = funding_of(sym) or {}
        fr = f.get("fr")
        out = {
            "symbol": sym, "base": base, "quote": quote, "mkt": "perp",
            "fr": None if fr is None else round(fr * 100, 6),   # 百分比，与列表列一致
            "nft": f.get("nft"),
            "mp": f.get("mp"), "ip": f.get("ip"),
        }

        res = {}

        def grab(name, path, ttl):
            try:
                res[name] = json.loads(cached_fapi(path, ttl, 12))
            except Exception:       # noqa: BLE001
                res[name] = None

        jobs = [
            threading.Thread(target=grab, args=(
                "oi", "/fapi/v1/openInterest?symbol=%s" % sym, 20)),
            threading.Thread(target=grab, args=(
                "lsr", "/futures/data/globalLongShortAccountRatio?symbol=%s&period=5m&limit=1" % sym, 90)),
        ]
        for t in jobs:
            t.start()
        # 持仓量/多空比是可选数据，拿不到就空着，别让整个面板等 8 秒
        deadline = time.time() + 4
        for t in jobs:
            t.join(max(0.1, deadline - time.time()))
        with _perp_cache_lock:
            if len(PERP_CACHE) > 300:
                PERP_CACHE.clear()
            PERP_CACHE[sym] = (time.time() + 10, out)
        if owner:
            with _inflight_lock:
                _inflight.pop(ck, None)
            ev.set()

        oi = res.get("oi")
        if isinstance(oi, dict):
            try:
                out["oi"] = float(oi.get("openInterest") or 0)
            except (TypeError, ValueError):
                pass
        lsr = res.get("lsr")
        if isinstance(lsr, list) and lsr and isinstance(lsr[0], dict):
            try:
                out["lsr"] = float(lsr[0].get("longShortRatio") or 0)
                out["longPct"] = float(lsr[0].get("longAccount") or 0) * 100
            except (TypeError, ValueError):
                pass
        self._json(out)

    def _intraday_multi(self, sym, perp, days, midnight):
        """多日连续分时：用 5 分钟粒度，5 天 = 1440 根，两段并行拉完。

        1 分钟粒度 5 天要 7200 根、8 次请求，而且小格子里本来就显示不下，
        5 分钟足够看清日内形态。
        """
        step = 300000
        start = midnight - (days - 1) * 86400000
        ck = ("f:" if perp else "s:") + sym + "|%dd" % days
        now = time.time()
        with _intraday_lock:
            hit = _INTRADAY.get(ck)
            if hit and hit[0] > now:
                return self._json(hit[1])

        def fetch(st):
            path = "/fapi/v1/klines" if perp else "/api/v3/klines"
            q = "%s?symbol=%s&interval=5m&startTime=%d&limit=1000" % (path, sym, st)
            return json.loads(cached_fapi(q, 20, 30) if perp else cached_get(q, 20))

        starts = [start + i * 1000 * step for i in range(0, 2)]
        out = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            for f in [ex.submit(fetch, st) for st in starts]:
                try:
                    out.extend(f.result() or [])
                except Exception:       # noqa: BLE001
                    pass
        out.sort(key=lambda r: r[0])
        # 只留 start 之后、今天之内的
        out = [r for r in out if r[0] >= start]

        if not out:
            return self._json({"symbol": sym, "o": None, "k": [], "days": days})
        payload = {
            "symbol": sym,
            "o": float(out[0][1]),      # 基准线 = 首日开盘价
            "days": days,
            "step": 300,
            "k": [[int(r[0]), float(r[4]), float(r[5])] for r in out],
        }
        with _intraday_lock:
            if len(_INTRADAY) > 200:
                _INTRADAY.clear()
            _INTRADAY[ck] = (now + 20.0, payload)
        return self._json(payload)

    def api_intraday(self, qs):
        """分时：本地当天 00:00 起的 1 分钟收盘价，附带今日开盘价作为基准线

        一天 1440 根，接口单次上限 1000，必须分两段。**两段并行拉**——
        原来串行是 2×RTT，合约走代理时就是 5 秒起步，分时图慢的根因就在这里。
        """
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = (sym[:-2] if perp else sym).upper()
        lt = time.localtime()
        midnight = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)
        day = time.strftime("%Y%m%d", lt)
        days = max(1, min(10, int((qs.get("days") or ["1"])[0])))
        if days > 1:
            return self._intraday_multi(sym, perp, days, midnight)

        ck = ("f:" if perp else "s:") + sym + "|" + day
        now = time.time()
        with _intraday_lock:
            hit = _INTRADAY.get(ck)
            if hit and hit[0] > now:
                return self._json(hit[1])

        # 1 分钟一根，前 1000 根覆盖 00:00~16:39，第二段直接从 16:40 起，
        # 不用等第一段回来就能发出去
        starts = [midnight, midnight + 1000 * 60000]

        def fetch(st):
            if perp:
                return json.loads(cached_fapi(
                    "/fapi/v1/klines?symbol=%s&interval=1m&startTime=%d&limit=1000" % (sym, st), 20, 30))
            return json.loads(cached_get(
                "/api/v3/klines?symbol=%s&interval=1m&startTime=%d&limit=1000" % (sym, st), 20))

        out = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
            for f in [ex.submit(fetch, st) for st in starts]:
                try:
                    out.extend(f.result() or [])
                except Exception:       # noqa: BLE001
                    pass
        out.sort(key=lambda r: r[0])

        if not out:
            return self._json({"symbol": sym, "o": None, "k": []})
        payload = {
            "symbol": sym,
            "o": float(out[0][1]),      # 今日开盘价 = 分时基准线
            "k": [[int(r[0]), float(r[4]), float(r[5])] for r in out],
        }
        with _intraday_lock:
            if len(_INTRADAY) > 200:
                _INTRADAY.clear()
            _INTRADAY[ck] = (now + 12.0, payload)
        self._json(payload)

    def api_fundinghist(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        sym = (sym[:-2] if sym.endswith("@f") else sym).upper()
        try:
            raw = json.loads(cached_fapi(
                "/fapi/v1/fundingRate?symbol=%s&limit=12" % sym, 300, 30))
            hist = [[int(x["fundingTime"]), round(float(x["fundingRate"]) * 100, 6)]
                    for x in raw]
        except Exception as e:      # noqa: BLE001
            return self._json({"symbol": sym, "h": [], "error": str(e)})
        self._json({"symbol": sym, "h": hist})

    def static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        full = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            body = b"404 Not Found"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------------
    def sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        client = HUB.add_client()
        log("界面已连接（%d 个客户端）" % len(HUB.clients))
        try:
            with HUB.lock:
                hello = {"t": "hi", "ws": HUB.ws_connected, "n": len(HUB.tickers)}
            self._chunk("data: %s\n\n" % json.dumps(hello, separators=(",", ":")))
            while client.alive:
                try:
                    payload = client.q.get(timeout=12)
                except queue.Empty:
                    self._chunk(": ping\n\n")
                    continue
                self._chunk("data: %s\n\n" % payload)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            client.alive = False
            HUB.remove_client(client)
            log("界面断开（剩 %d 个客户端）" % len(HUB.clients))
            self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        import sys
        et = sys.exc_info()[0]
        if et and issubclass(et, (ConnectionError, OSError)):
            return
        super().handle_error(request, client_address)


def build_server(host, port):
    """装配好后台线程和 HTTP 服务，返回未启动的 Server（桌面壳也用它）"""
    # 先把端口绑上：桌面版会在这之后立刻开窗口，
    # Chrome 启动的 ~1 秒正好和下面的初始化（读缓存、探测代理、拉起各条流）重叠。
    # HTTPServer 的构造里已经 server_bind + listen，早到的连接会排队等 serve_forever。
    srv = Server((host, port), Handler)

    load_sectors()
    load_regions()
    queue_unregioned()
    load_listing()
    load_seen()
    threading.Thread(target=seen_saver, daemon=True).start()
    threading.Thread(target=load_klines, daemon=True).start()
    threading.Thread(target=kline_saver, daemon=True).start()
    threading.Thread(target=kline_prefetch_worker, daemon=True).start()
    threading.Thread(target=prefetch_klines, daemon=True).start()

    detect_proxy()
    threading.Thread(target=probe_fapi_direct, daemon=True).start()
    global FUTURES, FUT_DEPTH
    if SOCKS_PROXY:
        FUTURES = FuturesWorker(HUB)
        FUTURES.start()
        FUT_DEPTH = DepthWorker(HUB)
        FUT_DEPTH.start()

    StreamWorker(HUB).start()
    threading.Thread(target=push_loop, daemon=True).start()
    threading.Thread(target=listing_worker, daemon=True).start()
    threading.Thread(target=sector_sync_worker, daemon=True).start()
    threading.Thread(target=sector_sweep_worker, daemon=True).start()
    threading.Thread(target=bootstrap_market, daemon=True).start()
    if SOCKS_PROXY:
        threading.Thread(target=funding_worker, daemon=True).start()

    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8848)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true")
    args = ap.parse_args()

    srv = build_server(args.host, args.port)
    url = "http://%s:%d/" % ("127.0.0.1" if args.host == "0.0.0.0" else args.host, args.port)
    log("看盘终端已启动 -> %s   (Ctrl+C 退出)" % url)
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("已退出")


if __name__ == "__main__":
    main()
