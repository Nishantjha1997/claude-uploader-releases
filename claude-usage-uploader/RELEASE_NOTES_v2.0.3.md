# Claude Usage Uploader v2.0.3

Compliance dashboard overhaul + uploader efficiency release.

## Uploader (client)

- **Trigger polling reduced from every 5s to every 60s** — cuts background webhook requests by ~91.6% and eliminates Google Apps Script concurrent-execution warnings at fleet scale. Admin-triggered Generate/Ping actions are now picked up within 60 seconds (previously 5).

## Dashboard (Google Apps Script)

- **Silent background refresh** — auto-refresh now runs every 120s and patches the page in place: no loader flash, no collapsing of expanded progress rows. Manual Refresh keeps the loading indicator.
- **Registered Users roster** — the Developers and Registration pages are consolidated into a single "Registered Users" page with manual registration, live presence, last active / last upload, version, and per-developer Generate / Pause / Resume / Delete / Logs actions.
- **CSV Roster Reconciliation** — drag-and-drop a CSV of expected developers to instantly see who is *Awaiting Onboarding* (one-click register) and who is *Out of Sync / To Pause* (one-click pause or delete).
- **Flat-database storage** — heartbeat noise no longer appends log rows; live activity is stored in-place on the developer's roster row. The HeartbeatLog and ExpectedDevelopers sheets are removed automatically by a one-time migration (existing activity is backfilled). Keeps the spreadsheet far away from the 5-million-cell limit.
- **Drive cleanup** — pausing or deleting a developer trashes their `*_claude_daily.json` / `*_claude_session.json` files in the shared Drive folder; an hourly sweep removes files for paused developers as a backstop.
- **Unified table scrolling** — all tables share a capped 480px scroll area with sticky headers and themed scrollbars.
- Fixed: Health-page test ping was broken by an undefined HMAC constant.

## Upgrade notes

- Deploy the updated `Code.gs` / `Index.html` / `JavaScript.html` / `Stylesheet.html` to Apps Script and redeploy the web app. The first page load runs the v3 sheet migration.
- Update the version Gist (`version.json`) so existing clients self-update.
- Existing clients keep polling at 5s until they self-update to 2.0.3.

## Checksums (SHA-256)

| Asset | Checksum |
|---|---|
| `ClaudeUsageUploader.exe` (Windows x64) | `fefff4552beb8700b02f3b3caa1601ffa7fc609b5b393eae6a9406bec03db8e7` |
| `ClaudeUsageUploader-mac-arm64` (macOS arm64) | `e6f3c49390fd5b68de8883c098caee2686445c85c449083a0fb7f47f5d650131` |
| `ClaudeUsageUploader-mac-x64` (macOS x64) | `0aad01a4af5c98d445b5ab9244548d9512c0e5ea7203b07fc8f1a6bae1adf706` |
| `ClaudeUsageUploader-linux-x64` (Linux x64) | `1ff52833c9e8181362e8b8810b97e83566c79afb480ef90bd38b7ab0c8b79b77` |
