@echo off
REM Lay ADMIN_API_KEY tu VPS va copy vao clipboard
REM Hoi pass neu chua set VPS_PASS
cd /d "%~dp0.."
if "%VPS_PASS%"=="" (
  set /p VPS_PASS=Nhap VPS_PASS (root@160.187.246.219): 
)
echo ======================================================
echo   LAY ADMIN_API_KEY  (VPS: 160.187.246.219)
echo ======================================================
node scripts/get-admin-key.js
pause
