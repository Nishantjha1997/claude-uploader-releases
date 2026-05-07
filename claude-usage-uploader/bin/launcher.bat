@echo off
:loop
"C:\Users\ADMIN\Desktop\CLaudeCodeUsageAutoUploader\bin\ClaudeUsageUploader.exe"
timeout /t 60 /nobreak >nul 2>&1
goto loop
