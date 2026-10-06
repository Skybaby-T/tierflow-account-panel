@echo off
cd /d "%~dp0"
title TierFlow 停止服务
rem 从 accounts.json 读取实际端口（未读到则用默认 8899）
set PORT=
for /f "tokens=2 delims=:, " %%a in ('findstr /r /c:"\"port\"" accounts.json') do if not defined PORT set PORT=%%a
if not defined PORT set PORT=8899
echo 正在停止面板服务（端口 %PORT%）...
echo.
set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo 结束进程 PID %%a
    taskkill /F /PID %%a >nul 2>nul
    set FOUND=1
)
if not defined FOUND echo 没有找到正在运行的服务（可能本来就没开）。
echo.
echo 完成。
echo （如需再次启动，双击 start-silent.vbs）
echo.
pause