# install.ps1
# This script installs the Claude Usage Uploader on a developer's machine.

$targetDir = "C:\ClaudeUsageUploader"

Write-Host "Installing Claude Usage Uploader to $targetDir..."
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir | Out-Null
}

# Copy the executable and service account key
Copy-Item ".\ClaudeUsageUploader.exe" -Destination $targetDir -Force
Copy-Item ".\service-account-key.json" -Destination $targetDir -Force

Write-Host "Files copied successfully."
Write-Host "Launching Setup Wizard (Administrator privileges required to create the background task)..."

# Launch the executable with Administrator privileges to allow schtasks to run
Start-Process "$targetDir\ClaudeUsageUploader.exe" -Verb RunAs

Write-Host "Installation initiated. Please follow the instructions in your browser."
Start-Sleep -Seconds 3
