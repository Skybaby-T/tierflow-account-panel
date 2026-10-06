@echo off
cd /d "%~dp0"
title TierFlow 环境自检
echo ============================================
echo   清枢面板 - 环境自检报告
echo   （把本窗口全部内容复制给 AI 助手即可）
echo ============================================
echo.
echo 文件夹: %CD%
ver
echo.
echo [1] Node.js 检查
where node >nul 2>nul
if errorlevel 1 goto NONODE
for /f "delims=" %%v in ('node -v') do echo     OK - Node.js %%v
goto FILES
:NONODE
echo     [缺失] 未安装 Node.js
echo     解决：打开 https://nodejs.org/zh-cn 下载 LTS 版本，安装后重开本窗口
:FILES
echo.
echo [2] 核心文件检查（没有"缺失"字样即为正常）
if exist "server.js" (echo     OK - server.js) else (echo     [缺失] server.js)
if exist "public\index.html" (echo     OK - public\index.html) else (echo     [缺失] public\index.html)
if exist "accounts.json" (echo     OK - accounts.json) else (echo     [缺失] accounts.json)
echo.
echo [3] 端口检查
rem 从 accounts.json 读取实际端口（未读到则用默认 8899）
set PORT=
for /f "tokens=2 delims=:, " %%a in ('findstr /r /c:"\"port\"" accounts.json') do if not defined PORT set PORT=%%a
if not defined PORT set PORT=8899
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul 2>nul
if errorlevel 1 (echo     %PORT% 端口空闲 - 可以直接启动) else (echo     %PORT% 端口被占用 - 可能面板已在运行，直接打开 http://localhost:%PORT% 试试)
echo.
echo [4] 结论
echo     全部正常：双击 start-silent.vbs 即可使用
echo     有缺失项：把本报告发给你的 AI 助手，让它帮你处理
echo.
pause