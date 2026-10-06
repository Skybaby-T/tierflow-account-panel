@echo off
cd /d "%~dp0"
title TierFlow 多账号管理面板
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 未检测到 Node.js
    echo 请先安装 Node.js（免费）: https://nodejs.org/zh-cn
    echo 下载 LTS 版本，一路下一步，安装完成后重新双击本文件。
    echo.
    pause
    exit /b
)
echo ============================================
echo   TierFlow 多账号管理面板
set PORT=
for /f "tokens=2 delims=:, " %%a in ('findstr /r /c:"\"port\"" accounts.json') do if not defined PORT set PORT=%%a
if not defined PORT set PORT=8899
echo   启动后访问: http://localhost:%PORT%
echo   关闭本窗口即停止服务
echo ============================================
echo.
node server.js
echo.
echo [服务已退出] 按任意键关闭...
pause >nul
