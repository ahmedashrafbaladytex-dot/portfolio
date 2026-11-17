@echo off
chcp 65001 >nul
title Sales Bot - Setup
setlocal
set "DEST=%USERPROFILE%\SalesBot"
set "ZIP_URL=https://github.com/ahmedashrafbaladytex-dot/portfolio/archive/refs/heads/claude/eager-maxwell-4dnywd.zip"
set "TMPDIR=%TEMP%\salesbot-setup"

echo.
echo   ==========================================
echo      Sales Bot - automatic setup
echo   ==========================================
echo.

rem ---------- 1) Node.js ----------
echo   [1/4] Checking Node.js ...
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo         Installing Node.js (this can take a few minutes) ...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements >nul 2>nul
set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo.
echo   Could not install Node.js automatically.
echo   The download page will open: install the LTS version, then run this file again.
start "" https://nodejs.org
pause
exit /b 1
:node_ok
echo         OK

rem ---------- 2) Download ----------
echo   [2/4] Downloading the bot ...
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%ZIP_URL%' -OutFile '%TMPDIR%\bot.zip'; Expand-Archive -Force '%TMPDIR%\bot.zip' '%TMPDIR%\x'"
if not exist "%TMPDIR%\bot.zip" goto download_failed
for /d %%D in ("%TMPDIR%\x\*") do set "SRC=%%D\sales-intelligence"
if not exist "%SRC%\bot.js" goto download_failed
rem keeps your data and settings when updating
robocopy "%SRC%" "%DEST%" /E /XD data node_modules demo-output /XF settings.env /NFL /NDL /NJH /NJS /NP >nul
if not exist "%DEST%\bot.js" goto download_failed
echo         OK  -  %DEST%

rem ---------- 3) Libraries ----------
echo   [3/4] Preparing ...
pushd "%DEST%"
call npm install --no-audit --no-fund --loglevel=error >nul 2>nul
popd
echo         OK

rem ---------- 4) Shortcuts + start with Windows ----------
echo   [4/4] Desktop shortcut + auto start with Windows ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; foreach($p in @(@([Environment]::GetFolderPath('Desktop'),1),@([Environment]::GetFolderPath('Startup'),7))){ $l=$w.CreateShortcut((Join-Path $p[0] 'Sales Bot.lnk')); $l.TargetPath='%DEST%\start-windows.bat'; $l.WorkingDirectory='%DEST%'; $l.WindowStyle=$p[1]; $l.Save() }"
echo         OK
rmdir /s /q "%TMPDIR%" >nul 2>nul

echo.
echo   Done! Starting the bot now ...
echo.
cd /d "%DEST%"
call start-windows.bat
exit /b 0

:download_failed
echo.
echo   Download failed. Check the internet connection and run this file again.
pause
exit /b 1
