@echo off
chcp 65001 >nul
title 看盘终端 · 局域网访问
cd /d "%~dp0"

echo.
echo  ============================================
echo   看盘终端 · 局域网模式（给 iPad / 手机看）
echo  ============================================
echo.
echo  电脑和 iPad 要连同一个 Wi-Fi。
echo.

rem 从 ipconfig 里取第一个非回环的 IPv4（中英文系统都能匹配 IPv4 这个词）
set "IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  if not defined IP (
    for /f "tokens=* delims= " %%b in ("%%a") do set "IP=%%b"
  )
)

if "%IP%"=="" (
  echo  [!] 没读到局域网 IP。请在命令行执行 ipconfig 自己看一下。
) else (
  echo  iPad 上的 Safari 打开这个地址：
  echo.
  echo      http://%IP%:8848/
  echo.
)

echo  首次运行如果弹 Windows 防火墙，选「允许访问」（专用网络）。
echo  关掉窗口服务就停了。
echo.
pause

set "BT_HOST=0.0.0.0"

if exist "%~dp0BinanceTerminal.exe" (
  start "" "%~dp0BinanceTerminal.exe"
  exit /b
)
if exist "%~dp0dist\BinanceTerminal.exe" (
  start "" "%~dp0dist\BinanceTerminal.exe"
  exit /b
)

rem 没有 exe 就用源码跑（需要装 Python）
where python >nul 2>nul
if errorlevel 1 (
  echo  [!] 既没有 BinanceTerminal.exe，也没找到 python。
  pause
  exit /b 1
)
python "%~dp0server.py" --host 0.0.0.0 --port 8848
pause
