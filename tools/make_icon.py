#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 app.ico —— 黄底 + 四个黑菱形，和网页里的 favicon 一致。纯标准库，无第三方依赖。"""

import os
import struct
import zlib

SIZE = 256
BG = (240, 185, 11)        # #f0b90b
FG = (27, 31, 38)          # #1b1f26
RADIUS = 56

# 32×32 视图里的四个菱形中心，放大 8 倍
CENTERS = [(16 * 8, 9 * 8), (10 * 8, 15 * 8), (22 * 8, 15 * 8), (16 * 8, 21 * 8)]
DIAMOND_R = 3 * 8


def in_round_rect(x, y, w, h, r):
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = min(max(x, r), w - r - 1)
    cy = min(max(y, r), h - r - 1)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def make_png():
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)                       # 每行的 filter type
        for x in range(SIZE):
            if not in_round_rect(x, y, SIZE, SIZE, RADIUS):
                raw += bytes((0, 0, 0, 0))
                continue
            col = BG
            for cx, cy in CENTERS:
                if abs(x - cx) + abs(y - cy) <= DIAMOND_R:
                    col = FG
                    break
            raw += bytes(col) + b"\xff"

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def main():
    png = make_png()
    # ICO 头 + 一个 256×256 的 PNG 条目（宽高写 0 表示 256）
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 6 + 16)
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.ico")
    with open(out, "wb") as f:
        f.write(header + entry + png)
    print("已生成 %s (%d bytes)" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    main()
