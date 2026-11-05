#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
桌面壳：起本地行情服务 + 开一个没有地址栏的应用窗口。

打包成 exe 后双击即可用；关掉窗口，服务随之退出。
开发时也可以直接 `python desktop.py`，效果一样。

日志写在 %LOCALAPPDATA%\\BinanceTerminal\\app.log
"""

import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request

APP_NAME = "看盘终端"
HOST = "127.0.0.1"
PORT = int(os.environ.get("BT_PORT") or 8848)


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------

def data_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    p = os.path.join(base, "BinanceTerminal")
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:       # noqa: BLE001
        pass
    return p


def setup_log():
    """无控制台打包后 sys.stdout 是 None，必须先把输出接住，否则 print 会炸"""
    path = os.path.join(data_dir(), "app.log")
    try:
        f = open(path, "a", encoding="utf-8", buffering=1)
    except Exception:       # noqa: BLE001
        try:
            f = open(os.devnull, "w", encoding="utf-8")
        except Exception:   # noqa: BLE001
            return
    sys.stdout = f
    sys.stderr = f
    print("\n===== %s =====" % time.strftime("%Y-%m-%d %H:%M:%S"))


def msgbox(text, title=APP_NAME, flags=0x10):
    try:
        ctypes.windll.user32.MessageBoxW(None, str(text), title, flags)
    except Exception:       # noqa: BLE001
        pass


def alive(url):
    try:
        with urllib.request.urlopen(url, timeout=1.2) as r:
            return r.status == 200
    except Exception:       # noqa: BLE001
        return False


def screen_size():
    try:
        u = ctypes.windll.user32
        u.SetProcessDPIAware()
        return u.GetSystemMetrics(0), u.GetSystemMetrics(1)
    except Exception:       # noqa: BLE001
        return 1920, 1080


BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser():
    for p in BROWSERS:
        if p and os.path.isfile(p):
            return p
    for name in ("chrome", "msedge"):
        hit = shutil.which(name)
        if hit:
            return hit
    return None


def open_window(url):
    """用 Chrome/Edge 的 --app 模式开一个无地址栏窗口，返回进程对象"""
    w, h = screen_size()
    ww, wh = int(w * 0.92), int(h * 0.90)
    left, top = max(0, (w - ww) // 2), max(0, (h - wh) // 2)
    exe = find_browser()
    if not exe:
        print("没找到 Chrome / Edge，改用系统默认浏览器")
        os.startfile(url)   # noqa: S606
        return None
    args = [
        exe,
        "--app=" + url,
        "--user-data-dir=" + os.path.join(data_dir(), "window"),
        "--window-size=%d,%d" % (ww, wh),
        "--window-position=%d,%d" % (left, top),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-features=Translate,MediaRouter",
    ]
    print("启动窗口: %s" % exe)
    try:
        return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:      # noqa: BLE001
        print("启动浏览器失败: %s" % e)
        os.startfile(url)       # noqa: S606
        return None


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def run():
    url = "http://%s:%d/" % (HOST, PORT)
    status = url + "api/status"

    # 已经有实例在跑：只开窗口，不接管服务生命周期
    if alive(status):
        print("已有实例在运行，直接开窗口")
        open_window(url)
        return

    import server                       # 延迟导入，保证日志先接好

    # 服务启动和窗口启动并行：build_server 一开始就把端口绑上，
    # 所以 Chrome 可以立刻开，它启动的 ~1 秒正好和"读缓存 + 探代理 + 拉起行情流"重叠。
    # 前端首屏请求自带重试（app.js 的 marketReq），理论上服务慢一点也不会白屏。
    box = {}
    ready = threading.Event()

    def boot():
        try:
            srv = server.build_server(HOST, PORT)
        except Exception as e:          # noqa: BLE001
            print("服务启动失败: %s" % e)
            ready.set()
            return
        box["srv"] = srv
        ready.set()
        srv.serve_forever()

    threading.Thread(target=boot, daemon=True).start()

    proc = open_window(url)
    ready.wait(15)
    if "srv" not in box:
        print("服务没起来，窗口里会显示连接失败")
    else:
        for _ in range(80):
            if alive(status):
                break
            time.sleep(0.2)
        print("服务已启动: %s" % url)
    if proc is None:
        # 没有可等待的窗口进程，就常驻后台（用任务管理器结束）
        print("无窗口进程可等待，服务常驻")
        while True:
            time.sleep(3600)
    try:
        proc.wait()
    except KeyboardInterrupt:
        pass
    print("窗口已关闭，服务退出")


def main():
    setup_log()
    try:
        run()
    except Exception:       # noqa: BLE001
        tb = traceback.format_exc()
        print(tb)
        msgbox("启动失败：\n\n" + tb[-800:] + "\n\n日志：%s" % os.path.join(data_dir(), "app.log"))


if __name__ == "__main__":
    main()
