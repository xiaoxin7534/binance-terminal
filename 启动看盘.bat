@echo off
chcp 65001 >nul
title 币安看盘终端
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto nopython

echo.
echo   正在启动币安看盘终端 ...
echo   浏览器会自动打开 http://127.0.0.1:8848/
echo   关闭本窗口即停止服务。
echo.
python server.py --port 8848 --open
echo.
echo   服务已停止。
pause
exit /b 0

:nopython
echo.
echo   [!] 没有找到 Python。
echo       请先安装 Python 3.8 或更高版本（安装时勾选 Add to PATH）：
echo       https://www.python.org/downloads/
echo.
pause
exit /b 1
