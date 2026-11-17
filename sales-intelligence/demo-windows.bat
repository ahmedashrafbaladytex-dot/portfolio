@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\demo.js
start "" demo-output\dashboard.html
start "" demo-output
pause
