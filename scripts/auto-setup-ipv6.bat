@echo off
REM Tu dong: SSH lay ADMIN_API_KEY + ghi vao DB web chinh (khong can vao admin)
cd /d "%~dp0.."
if "%VPS_PASS%"=="" (
  set /p VPS_PASS=Nhap VPS_PASS (root@160.187.246.219): 
)
echo ======================================================
echo   AUTO SETUP IPv6 Proxy (VPS: 160.187.246.219)
echo   SSH lay key + ghi DB tu dong
echo ======================================================
node scripts/auto-setup-ipv6.js %*
pause
