@echo off
rem Checks every file on this drive against SHA256SUMS. Double-click it. It reads the files and changes nothing.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0support\verify-windows.ps1"
echo.
pause
