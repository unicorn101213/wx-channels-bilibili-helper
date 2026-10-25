@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在检查视频号、B站、抖音下载服务...
node "%~dp0boot.js"
start "" "http://127.0.0.1:2025"
echo.
echo 下载台： http://127.0.0.1:2025
echo 视频号请在电脑微信 4.1.13 里点开视频，使用播放器右下角的下载图标。
echo.
pause
