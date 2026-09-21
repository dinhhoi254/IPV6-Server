@echo off
REM 1-CLICK DEPLOY - Double click file nay la xong
REM Chay: git push + upload + bootstrap full tren VPS
cd /d "%~dp0.."
echo ======================================================
echo   ONE-CLICK DEPLOY  (git push + SSH deploy)
echo   VPS: 160.187.246.219
echo ======================================================
node scripts/one-click-deploy.js
pause
