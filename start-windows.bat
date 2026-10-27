@echo off
setlocal
title Holdline3FA test site
cd /d "%~dp0"

echo.
echo  Holdline3FA - test version (simulated numbers, free test credit)
echo  ----------------------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install the LTS version from https://nodejs.org
  echo  then close this window and double-click this file again.
  echo.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo  Your Node.js is too old. You need version 22.13 or newer.
  echo  Install the LTS version from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

if not exist "data\holdline.db" goto :makeadmin
echo  An account already exists on this computer.
set /p "AGAIN=  Press Enter to start the site, or type N to create/replace the admin login first: "
if /i "%AGAIN%"=="N" goto :makeadmin
goto :start

:makeadmin
echo.
echo  Create your admin login. You will use it to log in and open the Admin page.
set /p "HL_EMAIL=  Your email: "
set /p "HL_PASSWORD=  Password (at least 10 characters): "
echo.
node scripts\create-admin.js
if errorlevel 1 (
  echo.
  echo  Could not create the account. Check the message above and try again.
  pause
  exit /b 1
)

:start
echo.
echo  Starting the site. Your browser will open in a few seconds.
echo  Keep this window open while you use the site. Close it to stop the site.
echo.
set "ALLOW_DEMO_TOPUP=1"
set "HL_EMAIL="
set "HL_PASSWORD="
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"
node src\server.js
echo.
echo  The site stopped. If you did not close it, copy the message above and send it to me.
pause
