# Claude Usage Auto-Uploader - Project Handover

## 1. Project Overview
The Claude Usage Auto-Uploader is a background service (v1.3.1) that collects Claude AI usage data (`ccusage`) from developer machines on a weekly basis and automatically uploads it to a shared Google Drive folder. 
It consists of two main components:
1. **Client Service (Node.js)**: Packaged into standalone binaries (Windows, macOS, Linux) that developers run once. It registers itself to run silently in the background (e.g., via Task Scheduler on Windows, LaunchAgent on macOS, `@reboot` cron on Linux).
2. **Admin Dashboard (Google Apps Script)**: A Google Sheets-backed web application that serves as the admin interface to monitor active users, trigger force-runs, and view compliance logs.

## 2. Tech Stack
- **Frontend / Dashboard**: Google Apps Script (GAS) serving HTML/CSS/JS (`Index.html`, `JavaScript.html`, `Stylesheet.html`).
- **Backend / Client**: Node.js (`claude-usage-uploader.js`).
- **Packaging**: `pkg` library to compile the Node.js script into executable binaries for Windows, macOS, and Linux (targeting `node16`).
- **Database / Storage**: 
  - Google Drive (Shared Drive) for storing the JSON usage logs.
  - Google Sheets (via GAS) for compliance and heartbeat logging.
- **Key Dependencies**: `googleapis` (Drive API), `node-fetch`, `pkg`.
- **System Integration**: VBScript/Batch (Windows), `schtasks` (Windows), `crontab` (Linux), `LaunchAgent` (macOS).

## 3. Prerequisites
To develop and build this project, you will need:
- **Node.js** (v16 or higher is recommended, though `pkg` explicitly targets `node16` for output).
- **npm** (Node Package Manager).
- **Google Cloud Platform (GCP) Project**: Specifically a Service Account with a generated `service-account-key.json` file.
- **Google Apps Script / Clasp** (Optional, for deploying the dashboard via CLI, though copy-pasting into the GAS editor is supported).
- **ccusage**: The `ccusage` npm package is installed globally by the client automatically, but requires `npm` on the developer machine.

## 4. Local Setup & Installation

### Client Application (Uploader)
1. Navigate to the client directory: `cd claude-usage-uploader`
2. Install dependencies: `npm install`
3. Ensure you have the `service-account-key.json` in the same directory (this is required to authenticate with Google Drive API).
4. (Optional) Edit `claude-usage-uploader.js` to change the hardcoded Google Drive Folder ID (`0AMXBcPT9R10cUk9PVA`) or the `WEBHOOK_URL` to point to your new GAS dashboard deployment.

### Admin Dashboard (GAS)
1. Open a new Google Sheet and click **Extensions -> Apps Script**.
2. Copy the contents of the files in `claude-usage-dashboard/` (`Code.gs`, `Index.html`, `JavaScript.html`, `Stylesheet.html`) into the Apps Script editor.
3. Deploy as a **Web app**, executing as **Me**, with access set to **Anyone within [your domain]**.
4. Copy the resulting Web App URL and update the `WEBHOOK_URL` in `claude-usage-uploader.js`.

## 5. Database Setup (Infrastructure)
There is no traditional relational database or Prisma schema. Storage relies on Google ecosystem:
1. **Google Drive Shared Folder**: Create a shared folder. Get the Folder ID and hardcode it in `claude-usage-uploader.js`.
2. **Service Account Access**: Share the Google Drive folder with the service account email (e.g., `claude-uploader@claude-usage-auto-uploader.iam.gserviceaccount.com`) and grant it **Contributor** access.
3. **Google Sheet**: The GAS script automatically creates necessary tabs (like `ExpectedDevelopers`) on its first run. Add developer names exactly as they will type them into the client app to track compliance.

## 6. Roles & Access Control
- **Admin**: Has access to the Google Apps Script deployment, the Google Sheet, and the GCP Service Account. 
- **Developer**: Only needs to run the compiled binary on their local machine once. They do not need Google credentials; the binary bundles/uses the `service-account-key.json`. Authentication to Claude is handled by their local `ccusage` session.

## 7. Running & Building the App
To compile the Node.js script into binaries for developers to download, run these scripts from the `claude-usage-uploader` directory:

```bash
# Windows
npm run build-win

# macOS Intel
npm run build-mac-x64

# macOS Apple Silicon
npm run build-mac-arm64

# Linux x64
npm run build-linux
```
The resulting binaries (`ClaudeUsageUploader.exe`, `ClaudeUsageUploader-mac-x64`, etc.) must be distributed *alongside* the `service-account-key.json` file.

## 8. Important Notes & Gotchas
- **Windows Antivirus/Defender False Positives**: Because the `.exe` registers a background scheduled task and runs a hidden VBS script (`launcher.vbs`), Windows Defender often flags it with a heuristic warning (e.g., `Behavior:Win32/Persistence.A!ml`). Admins will need to whitelist the installation folder (e.g., `C:\ClaudeUploader`).
- **File Naming & Overwrites**: The uploader uses a PATCH method to Google Drive. It searches for files matching `FirstName_LastName_claude_daily.json` and patches them rather than duplicating files.
- **Hidden Execution**: The Windows service runs completely hidden with no console window (`Window Title: N/A`). It uses a single-instance lock (`service.lock` in `%APPDATA%\ClaudeUsageUploader`) to prevent multiple instances from running.
- **Auto-restart Mechanisms**: If the app fails or the computer restarts, `schtasks` (Win), `LaunchAgent` (Mac), or `cron @reboot` (Linux) will automatically bring it back up.
- **Expected Developers Sync**: The GAS dashboard only knows a developer is expected if they are listed in the `ExpectedDevelopers` tab of the Google Sheet.
- **macOS Code Signing**: On Apple Silicon, the binary requires ad-hoc codesigning on a real Mac before its first use (`codesign --sign - ClaudeUsageUploader-mac-arm64`).
