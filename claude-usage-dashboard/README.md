# Claude Usage Analytics & ROI Dashboard

This is a standalone Google Apps Script Web Application designed for Sigma Solve management. It reads per-developer Claude Code usage reports (`_claude_daily.json` and `_claude_session.json` files) directly from Google Drive, aggregates the metrics, and presents an interactive glassmorphic executive dashboard to track API-equivalent value ROI, license utilization, and automated reclamation candidates.

## Directory Structure
```text
├── Code.gs             # Server-side GAS logic: parses JSONs, calculates scores, manages script cache
├── Index.html          # WebApp shell: sidebar, tab panels, modals, and skeleton loaders
├── Stylesheet.html     # Premium UI styling: glassmorphism, flex grids, and HSL dark theme variables
├── JavaScript.html     # Client-side hooks: routing, sort/filter, CSV export, pure responsive SVG charts
├── appsscript.json     # Manifest file specifying timezones, execution scopes, and webapp permissions
└── .clasp.json         # CLASP tool config for easy deployment from terminal
```

---

## 🚀 Step-by-Step Deployment Guide

### Option 1: Quick Deployment using clasp (Recommended)

1. Open your terminal and navigate to this folder:
   ```bash
   cd c:\Users\ADMIN\Desktop\CLaudeCodeUsageAutoUploader\claude-usage-dashboard
   ```
2. Log in to your clasp tool (if not already logged in):
   ```bash
   npx clasp login
   ```
3. Create a new Google Apps Script project bound to this directory:
   ```bash
   npx clasp create --title "Claude Usage Analytics & ROI Dashboard" --type webapp
   ```
   *(This will create a new script in your Google Drive and automatically update `.clasp.json` with the new `scriptId`)*.
4. Push the local files to the created script:
   ```bash
   npx clasp push
   ```
5. Open the script in your browser to verify:
   ```bash
   npx clasp open
   ```

---

### Option 2: Manual Copy-Paste Deployment

If you prefer to deploy manually via the web browser:
1. Go to [script.google.com](https://script.google.com/) and click **New Project**.
2. Rename the project to `Claude Usage Analytics & ROI Dashboard`.
3. In the left panel, click on **Project Settings** (gear icon) and check the box **"Show 'appsscript.json' manifest file in editor"**.
4. Go back to the **Editor** (code icon) and copy-paste the contents of each local file into the corresponding online files:
   * Copy `Code.gs` into `Code.gs`
   * Copy `appsscript.json` into `appsscript.json`
   * Create an HTML file named `Index` and copy `Index.html` into it.
   * Create an HTML file named `Stylesheet` and copy `Stylesheet.html` into it.
   * Create an HTML file named `JavaScript` and copy `JavaScript.html` into it.
5. Save the project (`Ctrl + S` or `Cmd + S`).

---

## 🌐 Deploying the Web App

Once the files are pushed or pasted:
1. Click the **Deploy** button at the top-right of the Apps Script Editor, and select **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Configure the deployment settings:
   * **Description:** `Production Release v1.0.0`
   * **Execute as:** `User accessing the web app` (or `Me` to run with your admin credentials which have access to the Shared Drive). **Me** is recommended if you want to allow managers without direct Drive folder permissions to access the report data safely through the Web App.
   * **Who has access:** `Anyone` (or `Anyone with Google account` if you want to restrict it to company personnel).
4. Click **Deploy**.
5. Copy the **Web app URL** provided. This is your live dashboard link!

---

## 🛠 Business & Calculation Logic

*   **API Cost:** Direct, commercial, pay-as-you-go API-equivalent cost computed by `ccusage` for all models (Sonnet, Opus, Haiku) and stored in daily JSONs.
*   **Active Days:** Total distinct dates where the developer committed Code usage.
*   **Value Score (0-100):** Combines the Code Score (token volume + active days + project count + efficiency relative to the team's top performer) and Chat Score (synthetic score from interactive CLI shell sessions) with a $10\%$ bonus for developers utilizing both channels.
*   **Removal Protection Guard:** A user is automatically protected and never recommended for removal if their Code equivalent cost is $\ge$ \$10.00 OR if they have $\ge$ 3 active days, preventing flagging active developers who code silently.
