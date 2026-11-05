@echo off
chcp 65001 >nul
title 币安看盘终端
cd /d "%~dp0"

rem 注意：Windows 自带的「应用商店占位符」python.exe 能通过 where 检查，
rem 但一执行就跳商店 / 直接返回 9009。所以这里必须实打实跑一句再算数。
set "PY="
python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=python"

if not defined PY (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)

if not defined PY goto nopython

echo.
echo   正在启动币安看盘终端 ...
echo   浏览器会自动打开 http://127.0.0.1:8848/
echo   关闭本窗口即停止服务。
echo.
%PY% server.py --port 8848 --open
echo.
echo   服务已停止。
pause
exit /b 0

:nopython
echo.
echo   [!] 没有找到能用的 Python 3。
echo.
echo       如果你确定装过 Python，但双击本文件却跳微软商店：
echo         设置 - 应用 - 高级应用设置 - 应用执行别名
echo         把 python.exe / python3.exe 两项关掉，再双击本文件。
echo.
echo       没装过的话装一个（安装时勾选 Add python.exe to PATH）：
echo         https://www.python.org/downloads/
echo.
pause
exit /b 1
