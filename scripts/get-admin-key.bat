@echo off
REM Lay ADMIN_API_KEY tu VPS va copy vao clipboard
cd /d "%~dp0.."
if defined VPS_PASS goto :run
set /p VPS_PASS=Nhap VPS_PASS root@160.187.246.219: 
:run
echo ======================================================
echo   LAY ADMIN_API_KEY  ^(VPS: 160.187.246.219^)
echo ======================================================
node scripts/get-admin-key.js
pause
