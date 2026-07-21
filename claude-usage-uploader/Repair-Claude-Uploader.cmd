@echo off
setlocal
title Claude Usage Uploader Repair
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-v2.0.4.ps1"
if errorlevel 1 (
  echo.
  echo Repair did not finish. Copy the error above and send it to IT.
) else (
  echo.
  echo Claude Usage Uploader v2.0.4 repair completed successfully.
)
echo.
pause
endlocal
