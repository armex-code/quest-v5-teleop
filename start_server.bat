@echo off
rem Quest -> V5 teleop server. Double-click to start; Ctrl+C or close to stop.
cd /d "%~dp0"
python server\run.py
echo.
echo Server stopped.
pause
