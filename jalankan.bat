@echo off
rem ============================================================
rem  CCTV Live View - jalankan web + MediaMTX (versi produksi)
rem  Klik dua kali file ini. Tutup kedua jendela untuk berhenti.
rem ============================================================
cd /d "%~dp0"

if not exist "bin\mediamtx.exe" (
  echo  [!] bin\mediamtx.exe tidak ditemukan.
  echo      Download mediamtx_vX.X.X_windows_amd64.zip dari
  echo      https://github.com/bluenviron/mediamtx/releases
  echo      lalu taruh mediamtx.exe di folder bin\
  pause & exit /b 1
)

if not exist "node_modules" (
  echo  Install dependency pertama kali...
  call npm install --omit=dev || (pause & exit /b 1)
)

rem Cek port yang dipakai MediaMTX & web
for %%P in (8889 9997 3000) do (
  netstat -ano | findstr /R /C:":%%P .*LISTENING" >nul && (
    echo.
    echo  [!] Port %%P sudah dipakai program lain.
    echo      Kemungkinan MediaMTX tes atau web ini masih jalan.
    echo      Tutup jendelanya, atau akhiri "mediamtx.exe" / "node.exe" di Task Manager,
    echo      lalu jalankan file ini lagi.
    echo.
    pause & exit /b 1
  )
)

echo  Menjalankan web...
start "CCTV Web" cmd /k npm start
timeout /t 3 >nul

echo  Menjalankan MediaMTX...
start "CCTV MediaMTX" bin\mediamtx.exe mediamtx\mediamtx.yml
timeout /t 2 >nul

start http://localhost:3000
echo.
echo  Selesai. Web: http://localhost:3000
echo  Saat pertama kali jalan, password admin tertulis di jendela "CCTV Web".
echo.
timeout /t 8
