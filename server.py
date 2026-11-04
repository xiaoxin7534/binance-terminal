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
import gzip
import json
import os
import queue
import select
import socket
import ssl
import struct
import sys
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
    CACHE_DIR = os.path.join(
        os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "BinanceTerminal", "cache")
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    CACHE_DIR = os.path.join(ROOT, "cache")
TICKER_CACHE = os.path.join(CACHE_DIR, "tickers.json")
LISTING_CACHE = os.path.join(CACHE_DIR, "listing.json")
KLINES_FILE = os.path.join(CACHE_DIR, "klines.json")
SECTORS_FILE = os.path.join(ROOT, "assets", "data", "sectors.json")

REST_HOST = "data-api.binance.vision"
WS_HOST = "data-stream.binance.vision"
FAPI_HOST = "www.binance.com"           # 合约 REST（网页版网关，fapi.binance.com 被 451）
FWS_HOST = "fstream.binance.com"        # 合约 WebSocket（需要代理）
FWS_PATH = "/market/stream"             # 网页版路径，标准 /stream 收不到数据
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BinanceTerminal/1.0"

TOP_TICKER_STREAMS = 260        # rebalance 兜底保留的成交额前 N
MAX_TICKER_STREAMS = 950        # 单连接最多订阅的 ticker 流（币安上限 1024）
QUOTE_ASSETS = ("USDT", "USDC")  # 支持的计价货币
TICK_PUSH_INTERVAL = 0.7        # tick 合并推送间隔（秒）
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


def detect_proxy():
    """探测本机常见代理端口，返回 (host, port) 或 None"""
    global SOCKS_PROXY
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
    """合约 REST：优先走代理"""
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
_opener_env = urllib.request.build_opener()
_opener_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get(path, timeout=25):
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
    key = "f:" + path
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    body = fapi_get(path, timeout)
    with _cache_lock:
        _cache[key] = (now + ttl, body)
    return body


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
LISTING = {}
_listing_lock = threading.Lock()


def load_sectors():
    global SECTORS
    try:
        with open(SECTORS_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        SECTORS = {"labels": d.get("labels", {}), "map": d.get("map", {})}
        log("载入板块分类 %d 个币种" % len(SECTORS["map"]))
    except Exception as e:      # noqa: BLE001
        log("板块分类载入失败: %s" % e)


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
            # 合约 symbol 不能进现货流：btcusdt@f@depth20@100ms 是非法流名，
            # 而且 /market/stream 本来也不提供 depth（实测只有 !ticker@arr 和 aggTrade），
            # 永续盘口由前端按 4 秒轮询 REST 解决
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
            self.tickers[key] = {
                "l": last, "chgp": float(m.get("P") or 0),
                "h": float(m["h"]), "lo": float(m["l"]),
                "v": float(m["v"]), "qv": float(m["q"]), "o": op,
                "dp": dp, "ts": time.time(), "mkt": "perp",
            }
            self.dirty.add(key)
            self.msg_count += 1
            self.last_ws_msg = time.time()

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
            self.tickers[sym] = {
                "l": last, "chgp": chgp, "h": float(m["h"]), "lo": float(m["l"]),
                "v": float(m["v"]), "qv": float(m["q"]), "o": op, "dp": dp, "ts": now,
            }
            self.dirty.add(sym)
            self.msg_count += 1
            self.last_ws_msg = now


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
                                      1 if k["x"] else 0]})
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
                                      1 if k["x"] else 0]})
        elif e == "aggTrade":
            self.hub.broadcast({"t": "r", "s": data["s"] + "@f", "p": float(data["p"]),
                                "q": float(data["q"]), "m": 1 if data["m"] else 0,
                                "T": data["T"]})


FUTURES = None


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
    while True:
        time.sleep(TICK_PUSH_INTERVAL)
        with HUB.lock:
            batch = []
            for sym in HUB.dirty:
                t = HUB.tickers.get(sym)
                if t:
                    batch.append([sym, t["l"], t["chgp"], t["h"], t["lo"], t["v"], t["qv"],
                                  round(HUB.speed(sym, t["l"]), 3)])
            HUB.dirty.clear()
        if batch:
            HUB.broadcast({"t": "tk", "d": batch})
        now = time.time()
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
KLINE_MAX_SERIES = 240     # 最多缓存多少条序列
KLINES = {}
_klines_lock = threading.Lock()
_klines_dirty = False


def _fetch_klines(perp, sym, iv, limit, start=None):
    """拉一段 K 线，返回 [[t, o, h, l, c, v, q], ...]"""
    if perp:
        path = "/fapi/v1/klines?symbol=%s&interval=%s&limit=%d" % (sym, iv, limit)
        if start:
            path += "&startTime=%d" % start
            raw = json.loads(fapi_get(path, 30))
        else:
            raw = json.loads(cached_fapi(path, 2, 30))
    else:
        path = "/api/v3/klines?symbol=%s&interval=%s&limit=%d" % (sym, iv, limit)
        if start:
            path += "&startTime=%d" % start
            raw = json.loads(http_get(path))
        else:
            raw = json.loads(cached_get(path, 2))
    return [[int(k[0]), float(k[1]), float(k[2]), float(k[3]),
             float(k[4]), float(k[5]), float(k[7])] for k in raw]


def _merge_bars(old, new):
    """按开盘时间合并，新数据覆盖同一根（最后一根通常是还在走的）"""
    if not new:
        return old
    d = {b[0]: b for b in old}
    for b in new:
        d[b[0]] = b
    return [d[t] for t in sorted(d)]


def get_klines(perp, sym, iv, limit):
    global _klines_dirty
    key = ("f:" if perp else "s:") + sym + "|" + iv
    step = IV_MS.get(iv, 60000)
    now = time.time()
    # 周期越大，缓存留得越久（1 分钟图 30 秒，日线留 5 分钟）
    ttl = max(KLINE_TTL, min(300.0, step / 2000.0))
    with _klines_lock:
        ent = KLINES.get(key)
    if ent and now - ent["ts"] < ttl and len(ent["bars"]) >= min(limit, 50):
        return ent["bars"][-limit:]

    bars = ent["bars"] if ent else []
    start = int(bars[-1][0]) if bars else None
    if start is not None and (now * 1000 - start) / step > limit:
        start = None        # 落后太多，增量不划算，整段重拉

    try:
        if start is None:
            merged = _fetch_klines(perp, sym, iv, limit)
        else:
            need = int((now * 1000 - start) / step) + 3
            merged = _merge_bars(bars, _fetch_klines(perp, sym, iv, max(2, min(need, 500)), start))
    except Exception:           # noqa: BLE001
        if bars:
            log("K 线拉取失败，用缓存兜底: %s %s" % (sym, iv))
            return bars[-limit:]        # 网络抖的时候先看旧的，别白屏
        raise

    if len(merged) > KLINE_KEEP:
        merged = merged[-KLINE_KEEP:]
    with _klines_lock:
        KLINES[key] = {"ts": now, "bars": merged}
        if len(KLINES) > KLINE_MAX_SERIES:
            for k in sorted(KLINES, key=lambda x: KLINES[x]["ts"])[:40]:
                KLINES.pop(k, None)
    _klines_dirty = True
    return merged[-limit:]


def load_klines():
    try:
        with open(KLINES_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("v") != 1:
            return
        cutoff = time.time() - 7 * 86400
        n = 0
        with _klines_lock:
            for k, v in (d.get("s") or {}).items():
                if v.get("ts", 0) > cutoff and v.get("bars"):
                    KLINES[k] = v
                    n += 1
        if n:
            log("载入 K 线缓存 %d 条序列" % n)
    except Exception:           # noqa: BLE001
        pass


def save_klines(force=False):
    global _klines_dirty
    if not _klines_dirty and not force:
        return
    _klines_dirty = False
    try:
        with _klines_lock:
            snap = dict(KLINES)
        os.makedirs(CACHE_DIR, exist_ok=True)
        tmp = KLINES_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"v": 1, "s": snap}, f, separators=(",", ":"))
        os.replace(tmp, KLINES_FILE)
        if snap:
            log("K 线缓存已保存 %d 条序列" % len(snap))
    except Exception as e:      # noqa: BLE001
        log("K 线缓存落盘失败: %s" % e)


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
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
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
                "ln": LISTING.get(ln_key),
            }
            if perp:
                f = fund_snap.get(sym[:-2])
                if f:
                    row["fr"] = round(f["fr"] * 100, 6)   # 百分比，便于直接显示
                    row["nft"] = f["nft"]
            rows.append(row)
        rows.sort(key=lambda r: -r["qv"])
        self._json({"ts": int(time.time() * 1000), "rows": rows,
                    "labels": SECTORS["labels"]})

    def api_klines(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = sym[:-2] if perp else sym.upper()
        iv = (qs.get("interval") or ["1m"])[0]
        limit = min(int((qs.get("limit") or ["400"])[0]), 1000)
        out = get_klines(perp, sym, iv, limit)
        self._json({"symbol": sym, "interval": iv, "k": out})

    def api_depth(self, qs):
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = sym[:-2] if perp else sym.upper()
        limit = min(int((qs.get("limit") or ["20"])[0]), 50)
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
                res[name] = json.loads(cached_fapi(path, ttl, 25))
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
        deadline = time.time() + 8
        for t in jobs:
            t.join(max(0.1, deadline - time.time()))

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

    def api_intraday(self, qs):
        """分时：本地当天 00:00 起的 1 分钟收盘价，附带今日开盘价作为基准线"""
        sym = (qs.get("symbol") or ["BTCUSDT"])[0]
        perp = sym.endswith("@f")
        sym = (sym[:-2] if perp else sym).upper()
        lt = time.localtime()
        midnight = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)
        out = []
        start = midnight
        for _ in range(3):          # 一天 1440 根，接口单次上限 1000，最多分 2 段
            if perp:
                raw = json.loads(cached_fapi(
                    "/fapi/v1/klines?symbol=%s&interval=1m&startTime=%d&limit=1000" % (sym, start), 20, 30))
            else:
                raw = json.loads(cached_get(
                    "/api/v3/klines?symbol=%s&interval=1m&startTime=%d&limit=1000" % (sym, start), 20))
            if not raw:
                break
            out.extend(raw)
            if len(raw) < 1000:
                break
            start = int(raw[-1][0]) + 60000
        if not out:
            return self._json({"symbol": sym, "o": None, "k": []})
        self._json({
            "symbol": sym,
            "o": float(out[0][1]),      # 今日开盘价 = 分时基准线
            "k": [[int(r[0]), float(r[4]), float(r[5])] for r in out],
        })

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
    load_sectors()
    load_listing()
    threading.Thread(target=load_klines, daemon=True).start()

    detect_proxy()
    global FUTURES
    if SOCKS_PROXY:
        FUTURES = FuturesWorker(HUB)
        FUTURES.start()

    StreamWorker(HUB).start()
    threading.Thread(target=push_loop, daemon=True).start()
    threading.Thread(target=listing_worker, daemon=True).start()
    threading.Thread(target=bootstrap_market, daemon=True).start()
    if SOCKS_PROXY:
        threading.Thread(target=funding_worker, daemon=True).start()

    return Server((host, port), Handler)


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
