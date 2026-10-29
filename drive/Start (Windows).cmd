@echo off
rem Starts the model on this drive on a Windows PC. Double-click it.
rem It never downloads anything: support\start-windows.ps1 reads this PC's memory and graphics card, picks the build
rem that fits, offers to copy it to this PC, then starts the llama.cpp server on 127.0.0.1 only and opens its chat page.
rem Close this window to stop the model.
setlocal
cd /d "%~dp0"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" goto arm
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" goto arm
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0support\start-windows.ps1"
echo.
pause
exit /b 0

:arm
echo This PC has an Arm processor. The model server on this drive is built for x64 PCs, so it can't run here yet.
echo.
pause
exit /b 1
