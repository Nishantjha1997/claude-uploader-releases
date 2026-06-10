@echo off
:loop
"C:\Users\ADMIN\Desktop\CLaudeCodeUsageAutoUploader\claude-usage-uploader\ClaudeUsageUploader_v2.0.1-win-x64.exe"
timeout /t 60 /nobreak >nul 2>&1
goto loop
