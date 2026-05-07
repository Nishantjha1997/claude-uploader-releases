# Claude Usage Uploader — Developer Installation Guide

> Version 1.3.1 | Sigma Solve

This tool runs silently in the background on your machine and automatically uploads your Claude AI usage data to the admin dashboard every week. After the one-time setup below, you never need to touch it again.

---

## What You Need

You should have received two files from your admin:

| File | Description |
|---|---|
| `ClaudeUsageUploader.exe` | Windows binary |
| `ClaudeUsageUploader-mac-x64` | macOS binary (Intel / older Mac) |
| `ClaudeUsageUploader-mac-arm64` | macOS binary (Apple Silicon — M1/M2/M3/M4) |
| `ClaudeUsageUploader-linux` | Linux binary |
| `service-account-key.json` | Google credentials — keep this next to the binary |

Use the binary for your platform. **Always keep `service-account-key.json` in the same folder as the binary.**

---

## Windows Installation

### Step 1 — Place the files

Create a folder such as `C:\ClaudeUploader\` and put these two files in it:
- `ClaudeUsageUploader.exe`
- `service-account-key.json`

### Step 2 — Run as Administrator (first time only)

Right-click `ClaudeUsageUploader.exe` → **Run as administrator**

> Administrator rights are required only this one time to register the background Task Scheduler entry.

### Step 3 — Complete setup in your browser

A browser window opens automatically at `http://localhost:3000`.

1. Enter your **First Name** and **Last Name** exactly as your admin registered you
2. Click **Complete Setup**
3. Close the browser tab

### Step 4 — Done

The tool is now running **completely hidden** in the background — no window, no taskbar icon. It will start automatically on every login and every reboot, forever.

**To verify it is running:**
```cmd
tasklist /v /fi "imagename eq ClaudeUsageUploader.exe"
```
You should see it listed with `Window Title: N/A`.

### Uninstall / Reset

```cmd
schtasks /delete /tn "ClaudeUsageUploader" /f
taskkill /IM ClaudeUsageUploader.exe /F
```
Then delete your install folder and `%APPDATA%\ClaudeUsageUploader\`.

---

## macOS Installation

### Which binary do I need?

| Mac type | Binary to use |
|---|---|
| MacBook / iMac with **M1, M2, M3, or M4** chip | `ClaudeUsageUploader-mac-arm64` |
| Older Intel Mac (pre-2020) | `ClaudeUsageUploader-mac-x64` |

Not sure? Click  → **About This Mac**. If Chip says **Apple M1** (or M2/M3/M4) use `arm64`. If it says **Intel** use `x64`.

### Step 1 — Place the files

```bash
mkdir ~/ClaudeUploader
cp ClaudeUsageUploader-mac-* ~/ClaudeUploader/
cp service-account-key.json ~/ClaudeUploader/
```

### Step 2 — Make executable

```bash
# Intel Mac:
chmod +x ~/ClaudeUploader/ClaudeUsageUploader-mac-x64

# Apple Silicon Mac:
chmod +x ~/ClaudeUploader/ClaudeUsageUploader-mac-arm64
```

### Step 3 — Apple Silicon only: codesign

Apple Silicon Macs require the binary to be signed before first run:

```bash
codesign --sign - ~/ClaudeUploader/ClaudeUsageUploader-mac-arm64
```

> **If macOS shows "cannot be opened because the developer cannot be verified":**
> Go to **System Settings → Privacy & Security** → scroll down → click **Allow Anyway** → try running again.

### Step 4 — Run once to complete setup

```bash
# Intel Mac:
~/ClaudeUploader/ClaudeUsageUploader-mac-x64

# Apple Silicon Mac:
~/ClaudeUploader/ClaudeUsageUploader-mac-arm64
```

A browser window opens at `http://localhost:3000`.

1. Enter your **First Name** and **Last Name**
2. Click **Complete Setup**
3. Close the browser tab — the tool continues running in the background

### Step 5 — Done

The tool installs a **LaunchAgent** that keeps it running and restarts it automatically on every login.

**To verify it is running:**
```bash
launchctl list | grep claudeuploader
```

### Uninstall / Reset

```bash
launchctl unload ~/Library/LaunchAgents/com.sigmasolve.claudeuploader.plist
rm ~/Library/LaunchAgents/com.sigmasolve.claudeuploader.plist
rm -rf ~/.config/ClaudeUsageUploader/
```

---

## Linux Installation

### Step 1 — Place the files

```bash
mkdir ~/ClaudeUploader
cp ClaudeUsageUploader-linux ~/ClaudeUploader/
cp service-account-key.json ~/ClaudeUploader/
```

### Step 2 — Make executable

```bash
chmod +x ~/ClaudeUploader/ClaudeUsageUploader-linux
```

### Step 3 — Run once to complete setup

```bash
~/ClaudeUploader/ClaudeUsageUploader-linux
```

A browser window opens at `http://localhost:3000`.

> **Headless / remote server (no GUI)?** Use SSH port forwarding from your local machine:
> ```bash
> ssh -L 3000:localhost:3000 youruser@yourserver
> ```
> Then visit `http://localhost:3000` in your local browser while the SSH session is open.

1. Enter your **First Name** and **Last Name**
2. Click **Complete Setup**
3. You can close the terminal — the tool continues running in the background

### Step 4 — Done

The tool adds a `@reboot` crontab entry so it restarts automatically after every reboot.

**To verify it is running:**
```bash
pgrep -a ClaudeUsageUploader-linux
```

**To verify the crontab entry:**
```bash
crontab -l | grep ClaudeUploader
```

### Uninstall / Reset

```bash
# Remove the crontab entry (opens editor — delete the @reboot line)
crontab -e

# Kill the running process
pkill -f ClaudeUsageUploader-linux

# Remove config
rm -rf ~/.config/ClaudeUsageUploader/
```

---

## Troubleshooting

### `ccusage: command not found`
The tool installs `ccusage` automatically on first run. If it fails, install Node.js from [nodejs.org](https://nodejs.org) then run:
```bash
npm install -g ccusage
```

### Not showing Online in the admin dashboard
- Confirm setup completed — config file must exist:
  - **Windows:** `%APPDATA%\ClaudeUsageUploader\config.json`
  - **macOS/Linux:** `~/.config/ClaudeUsageUploader/config.json`
- Check your name in config matches exactly what the admin registered
- The first heartbeat ping arrives within 30 seconds of the tool starting

### macOS: "App is damaged and can't be opened"
```bash
xattr -cr ~/ClaudeUploader/ClaudeUsageUploader-mac-arm64
codesign --sign - ~/ClaudeUploader/ClaudeUsageUploader-mac-arm64
```

### Windows: setup window didn't open / browser didn't launch
The tool must be run as Administrator the first time. Right-click → **Run as administrator**.

### Need to redo setup (wrong name entered)
Delete the config file and run the binary again:
- **Windows:** delete `%APPDATA%\ClaudeUsageUploader\config.json`
- **macOS/Linux:** `rm ~/.config/ClaudeUsageUploader/config.json`

---

## Support

Contact your admin if you encounter issues not covered here.
