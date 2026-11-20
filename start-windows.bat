@echo off
title Ludo Live
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nahi mila. PowerShell mein ye chalao, phir ye file dobara kholo:
  echo     winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo cloudflared nahi mila. PowerShell mein ye chalao, phir ye file dobara kholo:
  echo     winget install Cloudflare.cloudflared
  pause
  exit /b 1
)

if not exist node_modules (
  echo Pehli baar setup ho raha hai...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo npm install fail hua. Internet check karo.
    pause
    exit /b 1
  )
)

set "DATA_DIR=%~dp0data"
set "TRUST_PROXY=cloudflare"
start "Ludo Live server" cmd /k node src\server.js

echo.
echo Server chal gaya: http://localhost:3000
echo Public link neeche "trycloudflare.com" wali line mein aayega. Wahi dosto ko bhejo.
echo Ye window band mat karna.
echo.
cloudflared tunnel --no-autoupdate --url http://localhost:3000
pause
