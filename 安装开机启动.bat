@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0install-startup.js"
echo 下次登录 Windows 时会自动启动。下载台： http://127.0.0.1:2025
pause
