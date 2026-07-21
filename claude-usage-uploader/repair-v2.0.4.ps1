[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskNames = @('ClaudeUsageUploader', 'ClaudeUsageUploaderHealth')
$binaryName = 'ClaudeUsageUploader_v2.0.4-win-x64.exe'
$keyName = 'service-account-key.json'
$sourceBinary = Join-Path $PSScriptRoot $binaryName
$sourceKey = Join-Path $PSScriptRoot $keyName
$installDir = Join-Path $env:LOCALAPPDATA 'SigmaSolve\ClaudeUsageUploader'
$configDir = Join-Path $env:APPDATA 'ClaudeUsageUploader'
$targetBinary = Join-Path $installDir $binaryName
$targetKey = Join-Path $installDir $keyName
$backupDir = Join-Path $configDir ('repair-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Write-Step([string]$Message) {
  Write-Host "[Claude Uploader Repair] $Message"
}

if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
  throw "Missing $binaryName beside this repair script."
}
if (-not (Test-Path -LiteralPath $sourceKey -PathType Leaf)) {
  throw "Missing $keyName beside this repair script."
}

Write-Step 'Stopping the existing scheduled tasks.'
foreach ($taskName in $taskNames) {
  & schtasks.exe /End /TN $taskName 2>$null | Out-Null
  & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
}

Write-Step 'Stopping only Claude Usage Uploader processes.'
$uploaderProcesses = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like 'ClaudeUsageUploader*.exe'
}
foreach ($uploaderProcess in $uploaderProcesses) {
  Invoke-CimMethod -InputObject $uploaderProcess -MethodName Terminate | Out-Null
}
Start-Sleep -Seconds 2

if (Test-Path -LiteralPath $configDir) {
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  foreach ($configFileName in @('config.json', 'upload-queue.json', 'failed-pings.ndjson', 'events.ndjson')) {
    $configFile = Join-Path $configDir $configFileName
    if (Test-Path -LiteralPath $configFile -PathType Leaf) {
      Copy-Item -LiteralPath $configFile -Destination $backupDir -Force
    }
  }
  Remove-Item -LiteralPath (Join-Path $configDir 'service.lock') -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $configDir 'service.heartbeat') -Force -ErrorAction SilentlyContinue
}

Write-Step 'Installing the verified v2.0.4 files without deleting user settings.'
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath $sourceBinary -Destination $targetBinary -Force
Copy-Item -LiteralPath $sourceKey -Destination $targetKey -Force

# Any legacy forever-loop reads this file again and exits. The new executable
# replaces it with its supervised launcher when it repairs task registration.
Set-Content -LiteralPath (Join-Path $installDir 'launcher.bat') -Value "@echo off`r`nexit /b 0`r`n" -Encoding Ascii

Write-Step 'Starting v2.0.4 so it can recreate its supervised background tasks.'
Start-Process -FilePath $targetBinary -WorkingDirectory $installDir
Start-Sleep -Seconds 8

$mainTask = & schtasks.exe /Query /TN 'ClaudeUsageUploader' /FO LIST 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'v2.0.4 started, but the background task was not registered. Run this repair as the same Windows user who runs the uploader.'
}

Write-Step 'Repair complete. Configuration was preserved and v2.0.4 is running.'
if (Test-Path -LiteralPath $backupDir) {
  Write-Host "Settings backup: $backupDir"
}

