@echo off
chcp 65001 >nul
title Sales Intelligence Bot
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Download the LTS version from https://nodejs.org then run this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo   Preparing for first run, please wait...
  call npm install --no-audit --no-fund >nul 2>nul
)
node bot.js
echo.
echo   The bot stopped. Press any key to close this window.
pause >nul
