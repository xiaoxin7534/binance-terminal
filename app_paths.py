"""数据目录解析（app.log / 行情缓存 / 窗口 profile 都放这里）

默认还是 `%LOCALAPPDATA%\\BinanceTerminal`，但允许挪走——系统盘紧张的用户
不想让一个看盘工具在 C 盘常驻 180MB+（Chrome 窗口 profile 就占 160MB）。

优先级：
1. 环境变量 `BTERM_DATA`
2. exe（或源码）同目录、或它的上一级目录里的 `data-dir.txt`，取第一行非注释内容
3. `%LOCALAPPDATA%\\BinanceTerminal`

打包后 `data-dir.txt` 放在 exe 旁边就能生效，便携版可以直接写 `data`（相对 exe）。
"""

import os
import sys

APP_NAME = "BinanceTerminal"
CONF_NAME = "data-dir.txt"


def app_root():
    """exe 所在目录（打包后）或源码目录"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _read_conf():
    for base in (app_root(), os.path.dirname(app_root())):
        path = os.path.join(base, CONF_NAME)
        try:
            with open(path, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip().strip('"').strip("'")
                    if line and not line.startswith("#"):
                        return line
        except OSError:
            continue
    return ""


def _resolve_base():
    raw = (os.environ.get("BTERM_DATA") or "").strip().strip('"')
    if not raw:
        raw = _read_conf()
    if not raw:
        return os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), APP_NAME)
    # 相对路径按 exe 目录解析，方便便携版直接写 data
    if not os.path.isabs(raw):
        raw = os.path.join(app_root(), raw)
    return os.path.normpath(raw)


def data_dir(sub=""):
    """返回（并确保存在）数据目录；sub 是子目录名，如 "cache" / "window" """
    base = _resolve_base()
    path = os.path.join(base, sub) if sub else base
    try:
        os.makedirs(path, exist_ok=True)
    except OSError:
        pass
    return path
