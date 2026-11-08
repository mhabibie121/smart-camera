@echo off
rem ============================================================
rem  CCTV Live View - jalankan web + MediaMTX
rem  Klik dua kali file ini. Tutup kedua jendela untuk berhenti.
rem  Lupa password admin?  cctv.exe reset-admin PasswordBaru
rem ============================================================
cd /d "%~dp0"

for %%P in (8889 9997 3000) do (
  netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul && (
    echo.
    echo  [!] Port %%P sudah dipakai program lain.
    echo      Kemungkinan CCTV atau MediaMTX lain masih jalan. Tutup dulu, lalu jalankan lagi.
    echo.
    pause & exit /b 1
  )
)

echo  Menjalankan web...
start "CCTV Web" cctv.exe
timeout /t 3 >nul

echo  Menjalankan MediaMTX...
start "CCTV MediaMTX" mediamtx.exe mediamtx.yml
timeout /t 2 >nul

start http://localhost:3000
echo.
echo  Selesai. Web: http://localhost:3000
echo  Saat pertama kali jalan, password admin tertulis di jendela "CCTV Web".
echo.
timeout /t 8
