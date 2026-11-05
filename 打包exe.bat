@echo off
chcp 65001 >nul
title 打包看盘终端
cd /d "%~dp0"

echo.
echo   ============================================
echo      打包成桌面程序 (dist\BinanceTerminal.exe)
echo   ============================================
echo.

rem 和「启动看盘.bat」一样：where python 可能是商店占位符，要真跑一句
set "PY="
python -c "import sys" >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  py -3 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo   [!] 没有找到能用的 Python，无法打包。
  echo       若已安装却跳微软商店：设置 - 应用 - 应用执行别名，关掉 python.exe。
  pause
  exit /b 1
)

if not exist "build\.venv\Scripts\python.exe" (
  echo   首次打包，正在创建构建环境（约 30 秒）...
  %PY% -m venv build\.venv
  if errorlevel 1 goto fail
)

echo   检查 PyInstaller ...
build\.venv\Scripts\python.exe -m pip install -q --upgrade pyinstaller
if errorlevel 1 goto fail

if not exist "app.ico" (
  echo   生成图标 ...
  build\.venv\Scripts\python.exe tools\make_icon.py
)

echo   开始打包（约 30~60 秒）...
build\.venv\Scripts\pyinstaller.exe --noconfirm --clean --onefile --noconsole ^
  --name BinanceTerminal --icon "%CD%\app.ico" ^
  --add-data "%CD%\index.html;." --add-data "%CD%\assets;assets" ^
  --distpath dist --workpath build\work --specpath build ^
  desktop.py
if errorlevel 1 goto fail

echo.
echo   打包完成: %CD%\dist\BinanceTerminal.exe
echo   双击即可运行；关掉窗口服务就停了。
echo.
pause
exit /b 0

:fail
echo.
echo   [!] 打包失败，请把上面的报错发给我。
pause
exit /b 1
