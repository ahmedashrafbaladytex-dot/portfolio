@echo off
chcp 65001 >nul
title Orders System
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
set OPEN_BROWSER=1
node server.js
echo.
echo   The system stopped. Press any key to close this window.
pause >nul
