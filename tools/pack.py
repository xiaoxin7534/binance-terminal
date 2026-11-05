#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打便携分发包：构建 exe → 组装目录 → 压成 zip

    python tools/pack.py                # 完整流程（重新构建 exe）
    python tools/pack.py --skip-build   # 复用 dist/BinanceTerminal.exe，只重打包

产物：
    dist/package/币安看盘终端/          ← 解压后就是这个目录
    dist/币安看盘终端_YYYY-MM-DD.zip

分发包里的说明文档和代理模板放在 packaging/ 下，改文案改那里，
不要改 dist/package 里的副本（每次打包都会覆盖）。
"""

import io
import os
import shutil
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
STAGE_ROOT = os.path.join(DIST, "package")
FOLDER = "币安看盘终端"                     # 解压出来的目录名
EXE = os.path.join(DIST, "BinanceTerminal.exe")
SRC_TEMPLATES = os.path.join(ROOT, "packaging")

# 分发包里带哪些文件（顺序即 zip 里的顺序）
TEMPLATES = ["使用说明.txt", "设置代理.bat", "proxy.txt", "局域网访问.bat"]


def find_pyinstaller():
    cand = os.path.join(ROOT, "build", ".venv", "Scripts", "pyinstaller.exe")
    if os.path.isfile(cand):
        return cand
    hit = shutil.which("pyinstaller")
    if hit:
        return hit
    sys.exit("找不到 pyinstaller：既没有 build/.venv/Scripts/pyinstaller.exe，PATH 里也没有")


def build_exe():
    print("[1/3] 构建 exe ...")
    pyi = find_pyinstaller()
    cmd = [
        pyi, "--noconfirm", "--clean", "--onefile", "--noconsole",
        "--name", "BinanceTerminal",
        "--icon", os.path.join(ROOT, "app.ico"),
        # 注意分隔符是分号：--add-data "源;目标"
        "--add-data", os.path.join(ROOT, "index.html") + ";.",
        "--add-data", os.path.join(ROOT, "assets") + ";assets",
        "--distpath", DIST,
        "--workpath", os.path.join(ROOT, "build", "work"),
        "--specpath", os.path.join(ROOT, "build"),
        os.path.join(ROOT, "desktop.py"),
    ]
    r = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = r.stdout.decode("utf-8", "replace").strip().splitlines()[-3:]
    for line in tail:
        print("      " + line)
    if r.returncode != 0 or not os.path.isfile(EXE):
        sys.exit("构建失败，退出码 %d" % r.returncode)
    print("      完成：%.2f MB" % (os.path.getsize(EXE) / 1024 / 1024))


def stage():
    print("[2/3] 组装目录 ...")
    out = os.path.join(STAGE_ROOT, FOLDER)
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out, exist_ok=True)

    shutil.copy2(EXE, os.path.join(out, "BinanceTerminal.exe"))
    for name in TEMPLATES:
        src = os.path.join(SRC_TEMPLATES, name)
        if not os.path.isfile(src):
            sys.exit("缺少模板：%s" % src)
        shutil.copy2(src, os.path.join(out, name))
    return out


def zip_it(staged):
    print("[3/3] 压缩 ...")
    out = os.path.join(DIST, "币安看盘终端_%s.zip" % time.strftime("%Y-%m-%d"))
    if os.path.exists(out):
        os.remove(out)

    # 用 zipfile 而不是调外部工具：它会给中文名写 UTF-8 标志位，
    # 资源管理器解压不会乱码（GBK 编码的老压缩包会）
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name in ["BinanceTerminal.exe"] + TEMPLATES:
            p = os.path.join(staged, name)
            z.write(p, FOLDER + "/" + name)

    print("\n分发包：%s" % out)
    print("大小：%.2f MB" % (os.path.getsize(out) / 1024 / 1024))
    print("\n内容：")
    with zipfile.ZipFile(out) as z:
        for i in z.infolist():
            print("  %-44s %8.2f KB" % (i.filename, i.file_size / 1024))
    print("\n解压后双击 %s/BinanceTerminal.exe 即可运行。" % FOLDER)


def main():
    if "--skip-build" in sys.argv:
        print("[1/3] 跳过构建，复用 %s" % EXE)
        if not os.path.isfile(EXE):
            sys.exit("dist/BinanceTerminal.exe 不存在，去掉 --skip-build 重新构建")
    else:
        build_exe()
    zip_it(stage())


if __name__ == "__main__":
    main()
