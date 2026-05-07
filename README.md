# Claude Usage Uploader — Setup Guide

> Version 1.3.1 | Cross-platform (Windows / macOS / Linux)

A silent background service that collects Claude AI usage data from developer machines every week and uploads it to a shared Google Drive folder. An admin dashboard shows who is active, lets you request reports on demand, and view per-developer activity logs.

**v1.3.1 highlights:** the Windows service now runs **completely hidden** (no console window) via a VBS launcher, and a single-instance lock prevents duplicate pollers if the exe is launched twice. macOS / Linux were already hidden via LaunchAgent / cron `@reboot`.

---

## What Each Person Needs to Do

| Role | Action |
|---|---|
| **Admin (you)** | One-time Google Cloud + GAS setup, then distribute the binary |
| **Each developer** | Run the binary once to complete setup, then do nothing |

---

## Part 1 — Admin Setup (One-Time)

### 1.1 Google Drive Folder

You have already created the shared Drive folder. The folder ID is hard-coded in the binary:
`0AMXBcPT9R10cUk9PVA`

Verify the service account `claude-uploader@claude-usage-auto-uploader.iam.gserviceaccount.com` has **Contributor** access to the Shared Drive:
1. Open the Shared Drive → click the members list (top right)
2. Add `claude-uploader@claude-usage-auto-uploader.iam.gserviceaccount.com` as **Contributor**
3. Click **Share**

That's all Drive needs. No Domain-Wide Delegation. No Google Admin Console setup.

---

### 1.2 Deploy the Admin Dashboard (Google Apps Script)

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Rename the project to **Claude Usage Dashboard**
3. Attach it to your Google Sheet:
   - In the Script editor: **Resources → Advanced Google Services** (or **Project Settings** in new editor) — not required, GAS auto-discovers the bound sheet
   - Or open your compliance Google Sheet → **Extensions → Apps Script** — this binds it automatically. **This is the recommended approach.**
4. Copy each file into the GAS editor:

   | Local file | GAS file name | Type |
   |---|---|---|
   | `Code.gs` | `Code` | Script |
   | `Index.html` | `Index` | HTML |
   | `JavaScript.html` | `JavaScript` | HTML |
   | `Stylesheet.html` | `Stylesheet` | HTML |

5. **Deploy → New deployment:**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone within [your domain]** (or "Anyone" for testing)
   - Click **Deploy** → copy the web app URL

6. **Update `WEBHOOK_URL`** in `claude-usage-uploader.js` if it's different from the current value, then rebuild the binary (see Part 3).

7. Bookmark the web app URL — that's your admin dashboard.

---

### 1.3 Add Expected Developers

In the compliance Google Sheet, find the **ExpectedDevelopers** tab (created automatically on first dashboard load).

Add each developer's name in column A, one per row, matching exactly what they'll enter in the setup form:
```
Name
Nishant Jha
John Smith
Jane Doe
```

---

## Part 2 — Developer Setup (Per Machine)

### What developers need

- The binary for their platform (you distribute this)
- `service-account-key.json` in the **same folder** as the binary

### Windows

1. Place `ClaudeUsageUploader.exe` and `service-account-key.json` in the same folder (e.g. `C:\ClaudeUploader\`)
2. **Right-click → Run as administrator** (only needed on first run for Task Scheduler registration)
3. A browser window opens automatically — enter their full name → click **Complete Setup**
4. Done. The tool runs **fully hidden** in the background from now on (no console window, no taskbar icon), and restarts automatically on every login and every boot.

The first-time setup writes three files next to the exe:
- `ClaudeUsageUploader.exe` — the binary itself
- `launcher.bat` — restart loop (calls the exe, sleeps 60s on exit, retries)
- `launcher.vbs` — runs the bat with `WindowStyle=0` (fully hidden); the Task Scheduler entry calls `wscript.exe launcher.vbs`

To verify it's running hidden:
```
schtasks /query /tn "ClaudeUsageUploader" /v /fo list
tasklist /v /fi "imagename eq ClaudeUsageUploader.exe"
```
The process should be listed with `Window Title: N/A`.

### Upgrading an existing developer machine to v1.3.1
If a developer already had v1.3.0 installed, replace just the exe and re-register the task:
```
schtasks /delete /tn "ClaudeUsageUploader" /f
:: replace ClaudeUsageUploader.exe with the new build
:: then run the new exe once as admin — it skips setup (config exists) and re-creates the task with the VBS launcher
```

### macOS (Intel)

```bash
# Place both files in the same directory, then:
chmod +x ClaudeUsageUploader-mac-x64
./ClaudeUsageUploader-mac-x64
```
Browser opens → enter name → submit. The LaunchAgent is installed and will restart the tool automatically on login.

### macOS (Apple Silicon / M1/M2/M3)

```bash
chmod +x ClaudeUsageUploader-mac-arm64
# Must codesign on a real Mac before first use:
codesign --sign - ClaudeUsageUploader-mac-arm64
./ClaudeUsageUploader-mac-arm64
```

### Linux

```bash
chmod +x ClaudeUsageUploader-linux-x64
./ClaudeUsageUploader-linux-x64
```
Browser opens → enter name → submit. A `@reboot` crontab entry is added so the tool restarts automatically after each boot.

---

### What happens after developer setup

The tool runs silently in the background forever. Developers never need to touch it again.

Every week it automatically:
1. Runs `ccusage session --json` and `ccusage daily --json`
2. Finds the existing files in the Shared Drive (or creates them if missing) and replaces their content (PATCH method)
3. Sends a status ping to the admin dashboard (critical events to ComplianceLog, heartbeats to HeartbeatLog)

If a week is missed (PC was off), it catches up automatically on the next run.

---

## Part 3 — Building the Binaries

Run these commands from the project root (requires `node_modules` installed — run `npm install` first).

```bash
# Windows
npx pkg claude-usage-uploader.js --target node16-win-x64 --output ClaudeUsageUploader.exe

# macOS Intel
npx pkg claude-usage-uploader.js --target node16-macos-x64 --output ClaudeUsageUploader-mac-x64

# macOS Apple Silicon
npx pkg claude-usage-uploader.js --target node16-macos-arm64 --no-bytecode --public --public-packages "*" --output ClaudeUsageUploader-mac-arm64

# Linux x64
npx pkg claude-usage-uploader.js --target node16-linux-x64 --output ClaudeUsageUploader-linux-x64
```

After building, distribute both the binary **and** `service-account-key.json` to developers.

---

## Part 4 — Admin Dashboard Guide

Open your GAS web app URL in a browser.

### Active Users Panel (top card)

Shows every developer who has ever run the tool:

| Column | Meaning |
|---|---|
| Status | 🟢 Online (heartbeat < 4h) · 🟡 Away (< 24h) · ⚫ Offline |
| Last Seen | When any ping was last received from this developer |
| Last Ping Response | How long ago they responded to your last Ping test |
| Last Upload | When they last successfully uploaded a usage report |

**Generate button** — Queues a force-run on that developer's machine. Their tool picks it up within 30 seconds and runs the full generate + upload pipeline. The button shows **Queued ✓** while pending.

**Ping button** — Sends a connection test. Their tool responds with PONG within 30 seconds. Watch the "Last Ping Response" column update. Use this to verify the tool is alive and connected before queuing a generate.

**Logs button** — Opens an activity log modal showing the last 25 status events for that developer in reverse chronological order:
```
2026-05-04 10:45:14   SUCCESS        Admin-triggered for week of 2026-04-28
2026-05-04 10:45:09   UPLOAD_DONE    Files uploaded to Drive
2026-05-04 10:45:03   UPLOAD_START   Uploading to Drive
2026-05-04 10:45:01   GENERATE_DONE  sessions:47 daily:12
2026-05-04 10:44:58   GENERATE_START source=admin
2026-05-04 10:42:01   HEARTBEAT      v1.3.0
```

If something fails, the FAILURE line shows the error code:
```
DRIVE_AUTH_FAILED: unauthorized_client
NO_DATA: Report generation produced empty files
CREDENTIALS_MISSING: Missing Google service account key
```

### Compliance View

Select a week from the dropdown. Shows every developer's status for that week:
- **Reported** — uploaded successfully
- **Failed** — attempted but had errors
- **Pending** — no ping received this week

Click any row to see the full ping history for that developer for that week.

### Admin — Force Run (secondary)

Same as Generate button in Active Users, but via a dropdown. Also shows the **Pending Trigger Queue** — all queued instructions across all developers, with the option to cancel any.

### Test Webhook

Send a fake ping for any developer/status combination — useful for testing the dashboard without a real developer machine.

---

## Part 5 — Troubleshooting

### Tool not appearing online after setup

- Check `%APPDATA%\ClaudeUsageUploader\config.json` exists and has `"name"` field
- Check Windows Task Scheduler → Task Scheduler Library → `ClaudeUsageUploader` — should show **Running**
- If status is **Ready** (not running): `schtasks /run /tn "ClaudeUsageUploader"` to start it now
- Confirm `launcher.vbs` and `launcher.bat` both exist next to the exe (they're created during setup; if the install folder was moved after setup, the task still points to the old location and silently fails — re-run setup to regenerate)
- The first ping is a HEARTBEAT — it arrives within ~30 seconds of the task starting

### Developer showing Offline but they're working

- They may not have restarted since the update to v1.3.0 (old version ran once and exited)
- Ask them to run the exe again manually — it will self-start and register in the background

### Drive upload fails with DRIVE_AUTH_FAILED

- Verify the Drive folder `0AMXBcPT9R10cUk9PVA` is shared with `claude-uploader@claude-usage-auto-uploader.iam.gserviceaccount.com` as Contributor
- Check `service-account-key.json` is in the same folder as the binary

### Dashboard shows no data

- Confirm GAS web app is deployed and the URL matches `WEBHOOK_URL` in the binary
- Send a test ping from the Test Webhook panel — if that doesn't show in the sheet, the GAS deployment needs to be redeployed

### ccusage not found

- The tool installs `ccusage` globally via npm automatically on first run
- If it fails, have the developer run `npm install -g ccusage` manually

---

## File Reference

```
project/
├── claude-usage-uploader.js   Main source (edit here, then rebuild)
├── service-account-key.json   Google service account key (distribute with binary)
├── Code.gs                    GAS server-side logic
├── Index.html                 GAS dashboard HTML
├── JavaScript.html            GAS dashboard JavaScript
├── Stylesheet.html            GAS dashboard CSS
├── generate-manifest.js       Build tool: generates version.json for auto-updates
├── version.json               Auto-update manifest (host this publicly)
├── installer.iss              Windows Inno Setup installer script
├── install.sh                 macOS/Linux shell installer
├── planning.md                Feature planning notes
└── project_brain_map.md       Full architecture reference
```

---

## Config File Reference

Located at `%APPDATA%\ClaudeUsageUploader\config.json` (Windows) or `~/.config/ClaudeUsageUploader/config.json` (Mac/Linux):

```json
{
  "name": "Nishant_Jha",
  "lastUploadWeek": "2026-04-28"
}
```

To reset a developer (re-run setup), delete this file and run the binary again.
