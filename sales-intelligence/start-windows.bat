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
if not exist settings.env (
  copy settings.example.env settings.env >nul
  echo.
  echo   First run: fill in settings.env (bot token and group id), save it, then run this file again.
  echo.
  start "" notepad settings.env
  pause
  exit /b 0
)
if not exist node_modules (
  echo   Installing the Claude library (one time only)...
  call npm install --no-audit --no-fund
)
node bot.js
echo.
echo   The bot stopped. Press any key to close this window.
pause >nul
