@echo off
chcp 65001 >nul
title 创建桌面快捷方式
cd /d "%~dp0"

set "EXE=%CD%\dist\BinanceTerminal.exe"
if not exist "%EXE%" (
  echo   [!] 还没打包。请先运行 打包exe.bat
  pause
  exit /b 1
)

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $p = Join-Path ([Environment]::GetFolderPath('Desktop')) '看盘终端.lnk'; $l = $ws.CreateShortcut($p); $l.TargetPath = '%EXE%'; $l.WorkingDirectory = '%CD%\dist'; $l.IconLocation = '%EXE%'; $l.Description = '币安本地看盘终端'; $l.Save(); Write-Host ('已创建: ' + $p)"

echo.
echo   桌面已生成「看盘终端」，双击即可打开。
echo   想固定到任务栏：右键那个快捷方式 - 固定到任务栏。
echo.
pause
