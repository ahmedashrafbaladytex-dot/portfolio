@echo off
chcp 65001 >nul
title Orders System - allow network access
rem Opens port 3000 in Windows Firewall for devices on the same local network only.
net session >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set PORT=3000
netsh advfirewall firewall delete rule name="Orders System" >nul 2>nul
netsh advfirewall firewall add rule name="Orders System" dir=in action=allow protocol=TCP localport=%PORT% remoteip=localsubnet profile=any
if errorlevel 1 (
  echo   Failed to add the firewall rule.
) else (
  echo.
  echo   Done. Phones and other computers on the same Wi-Fi/network can now open the system.
)
echo.
pause
