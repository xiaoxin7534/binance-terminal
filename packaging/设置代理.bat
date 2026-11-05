@echo off
chcp 65001 >nul
title 设置代理
cd /d "%~dp0"

echo.
echo  合约行情需要本机能访问币安的合约接口（要走代理）。
echo  现货行情不需要，配不配都能看。
echo.
echo  请输入代理地址，格式 地址:端口
echo  例如：127.0.0.1:7890
echo.
echo  直接回车 = 清空配置（改回自动探测）
echo.

set "P="
set /p P=代理地址：

if "%P%"=="" goto clear

echo %P%> "%~dp0proxy.txt"
echo.
echo  已写入 proxy.txt：%P%
echo  重新打开程序生效。
goto end

:clear
if exist "%~dp0proxy.txt" del "%~dp0proxy.txt"
echo.
echo  已清空配置，程序会自己探测常见代理端口。
echo  重新打开程序生效。

:end
echo.
pause
