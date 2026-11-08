@echo off
rem Menjalankan MediaMTX (config tes) dan halaman web tes sekaligus.
cd /d "%~dp0"

rem Cek apakah ada MediaMTX lain yang masih jalan (port 8889 terpakai)
netstat -ano | findstr /R /C:":8889 .*LISTENING" >nul
if %errorlevel%==0 (
  echo.
  echo  [!] Port 8889 sudah dipakai, kemungkinan ada MediaMTX lain yang masih jalan.
  echo      Tutup dulu jendela MediaMTX itu, atau akhiri "mediamtx.exe" di Task Manager,
  echo      lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)

start "MediaMTX (tes)" mediamtx\mediamtx.exe mediamtx-test.yml

rem Web tes: jangan jalankan dua kali kalau sudah ada
netstat -ano | findstr /R /C:":8090 .*LISTENING" >nul
if not %errorlevel%==0 start "Web tes" node serve.js

timeout /t 2 >nul
start http://localhost:8090
