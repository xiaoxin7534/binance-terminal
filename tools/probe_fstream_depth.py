#!/usr/bin/env python3
"""探测合约盘口能不能走 WebSocket（而不是 4 秒一次的 REST 轮询）。

背景：PROJECT-STATE 里记的结论是「/market/stream 上没有 depth 流」。
但那是**合并流端点**的结论，币安还有**单流端点** /ws/<stream>，
以及 /stream 合并端点，都没单独试过。

用法：
    python tools/probe_fstream_depth.py
    python tools/probe_fstream_depth.py --secs 8

只做探测，不改任何代码。
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server as S  # noqa: E402

HOST = "fstream.binance.com"

# (标签, 路径, 需要发的订阅消息)
CASES = [
    ("单流 /ws/<sym>@depth20@100ms", "/ws/btcusdt@depth20@100ms", None),
    ("单流 /ws/<sym>@depth20@500ms", "/ws/btcusdt@depth20@500ms", None),
    ("单流 /ws/<sym>@depth20", "/ws/btcusdt@depth20", None),
    ("单流 /ws/<sym>@depth@100ms", "/ws/btcusdt@depth@100ms", None),
    ("合并 /stream 订阅 depth20", "/stream", {"method": "SUBSCRIBE", "params": ["btcusdt@depth20@100ms"], "id": 1}),
    ("合并 /stream 订阅 depth@100ms", "/stream", {"method": "SUBSCRIBE", "params": ["btcusdt@depth@100ms"], "id": 2}),
]


def probe(label, path, sub, secs, use_proxy):
    try:
        ws = S.WSConn(HOST, path, timeout=15, use_proxy=use_proxy)
    except Exception as e:  # noqa: BLE001
        return {"label": label, "ok": False, "error": "%s: %s" % (type(e).__name__, e), "frames": 0}

    try:
        if sub:
            ws.send_text(json.dumps(sub))
        frames = 0
        sample = None
        deadline = time.time() + secs
        while time.time() < deadline:
            fr = ws.recv_frame(min(2.0, max(0.2, deadline - time.time())))
            if not fr:
                continue
            opcode, payload = fr
            if opcode == 0x9:          # ping
                continue
            if opcode == 0x8:          # close
                return {"label": label, "ok": False, "error": "服务端主动关闭", "frames": frames}
            if opcode != 0x1:
                continue
            frames += 1
            if sample is None:
                try:
                    sample = json.loads(payload.decode())
                except Exception:      # noqa: BLE001
                    sample = payload[:80].decode("utf-8", "replace")
        return {"label": label, "ok": frames > 0, "frames": frames, "sample": sample}
    except Exception as e:  # noqa: BLE001
        return {"label": label, "ok": False, "error": "%s: %s" % (type(e).__name__, e), "frames": 0}
    finally:
        ws.close()


def summarize(sample):
    if not isinstance(sample, dict):
        return str(sample)[:70]
    if "b" in sample and "a" in sample:
        return "盘口快照 bids=%d asks=%d lastUpdateId=%s" % (
            len(sample.get("b") or []), len(sample.get("a") or []), sample.get("lastUpdateId") or sample.get("u"))
    if "data" in sample and isinstance(sample["data"], dict):
        d = sample["data"]
        return "stream=%s bids=%d asks=%d" % (sample.get("stream"), len(d.get("b") or []), len(d.get("a") or []))
    return str(sample)[:70]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=6.0, help="每个用例观察多少秒")
    args = ap.parse_args()

    proxy = S.detect_proxy()
    print("代理探测：%s" % ("%s:%s" % proxy if proxy else "（无，直连）"))
    print("目标：%s\n" % HOST)

    rows = []
    for label, path, sub in CASES:
        sys.stdout.write("  %-34s" % label)
        sys.stdout.flush()
        r = probe(label, path, sub, args.secs, use_proxy=bool(proxy))
        rows.append(r)
        if r["ok"]:
            print("✅ 收到 %d 帧   %s" % (r["frames"], summarize(r.get("sample"))))
        else:
            print("❌ %s" % r.get("error", "0 帧（没报错也不给数据）"))

    ok = [r for r in rows if r["ok"]]
    print("\n结论：%s" % ("合约盘口可以走 WebSocket ✅" if ok else "合约盘口仍然只能 REST 轮询 ❌"))
    if ok:
        print("可用端点：%s" % "、".join(r["label"] for r in ok))


if __name__ == "__main__":
    main()
