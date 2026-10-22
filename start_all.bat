@echo off
REM Everything at once: web page + WS bridge + V5 serial + 360 camera.
REM Double-click, or pass arguments through, e.g.
REM   start_all.bat -Test       (generated pattern, no camera needed)
REM   start_all.bat -NoCamera   (robot side only)
REM   start_all.bat -Force      (kill leftovers from a previous run)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_all.ps1" %*
echo.
pause
