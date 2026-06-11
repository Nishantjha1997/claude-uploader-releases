# Compliance Dashboard Overhaul — Background Refresh, Unified Scrolling, Registered Users Roster, & Drive Cleanup (v2 — ENHANCED)

This implementation plan details the changes required for the **Compliance Operations Center** dashboard (`claude-usage-uploader/` GAS project) and client-side uploader to improve responsiveness, reduce server-side script executions, optimize database size, manage shared Google Drive files, and unify UI scrolling behaviors.

> **Revision note (v2):** This plan was audited against the live codebase. The original draft had 9 defects that would have broken the Queue page, progress rows, Ping test, dashboard cache, and the Run All button. All are corrected below and marked with `[FIX]`.

## User Review Required

> [!IMPORTANT]
> **Consolidation of User Lists:** The "Expected Developers" (Awaiting Onboarding) list is removed entirely — sheet, server functions, and UI. Registration is handled by a manual add box on the "Registered Users" page, automatically on first uploader ping, or via the new CSV Reconciliation card. `[FIX]` Consumers of `expectedDevelopers` (`runAll()`, `renderExceptions()`, `renderHeadlineInsight()`, `complianceTrend` roster size) are switched to `registeredDevelopers`.

> [!WARNING]
> **Drive File Deletion is Destructive:** When a developer is paused or deleted, their `<Name>_claude_daily.json` / `<Name>_claude_session.json` files are trashed in shared Drive folder `0AMXBcPT9R10cUk9PVA` (matches uploader `DRIVE_FOLDER_ID`). Shared-drive trash auto-purges after ~30 days. The Apps Script executing account must have **Content Manager** (or higher) access to the shared drive or deletion will silently log-and-skip.

> [!NOTE]
> **Poll latency tradeoff:** Raising the uploader poll from 5s → 60s cuts `doGet` webhook executions by ~91.6%, but Generate/Ping/Update triggers now take up to **60s** to be picked up. Already-deployed binaries keep polling at 5s until they self-update; the server-side savings phase in as the fleet upgrades.

---

## Proposed Changes

### Component 1: Background Silent Refresh & 120s Auto-Refresh (JavaScript.html)

- Auto-refresh countdown becomes **120 seconds on all pages** (currently 10s on Compliance, 30s elsewhere).
- `fetchData(isSilent)`:
  - Silent: no refresh-button spinner, no full-screen loader, DOM updated **in-place** (`updateDashboardInPlace()`) so expanded progress rows, search filters, and scroll positions survive.
  - Manual (button) refresh keeps the loading state and full re-render.
  - `[FIX]` The 10s `getLastModified` poll also triggers **silent** refreshes (it previously caused loud full re-renders).
- `updateDashboardInPlace(data)`:
  - Rows in `activeUsersTbody` / `devRosterTbody` carry `data-user="<name>"`; the updater patches Status, Last Seen, Last Pong, Last Upload, Version, and action-button states cell-by-cell.
  - KPI strips re-render wholesale (no interaction state to preserve).
  - If the row *set* changed (dev added/removed), fall back to a full `renderDashboard()`.

### Component 2: Unified Smart Scrollbars & Sticky Headers (Stylesheet.html)

- `[FIX]` Sticky `thead th` and thin themed scrollbars **already exist** (commit aa0651b). Remaining work:
  - `.table-wrap`: `max-height: 68vh` → `480px`, plus border/background framing.
  - Add `.upload-zone` styles (hover/dragover) and `.recon-tabs` active-state styles for Component 4.

### Component 3: Single Registered Users Roster & Action Buttons (Index.html & JavaScript.html)

- Rename "Developers" nav/tab to **"Registered Users"**. `[FIX]` Keep emoji nav icons (`&#9989;`) — the project does not load FontAwesome.
- Remove the "Registration" (`page-roster`) tab, nav item, `pageTitles.roster`, `renderPageData` branch, and `renderRosterKpis()`.
- `[FIX]` Move the `onboardingStrip` (new-hire strip) into `page-developers` — it reads `registeredDevelopers` and stays useful.
- Move the manual "Register New Developer" input to the top of the Registered Users page (reuses `addRegisteredDeveloperManual()` / `newRegDevName` — already exist).
- Registered Users table columns: Name | Live Presence | Last Active | Last Upload | Version | Actions (Generate, Pause/Resume, Delete, Logs). Rows carry `data-user`.
- `[FIX]` Delete confirmation: replace the persistent `confirmOkBtn` listener + `devToDelete` global (Expected-list legacy — would double-fire alongside any `onclick` override) with a generic `showConfirm(message, okLabel, onOk)` helper.
- Remove dead Expected-roster JS: `loadExpectedDevelopers()`, `addDeveloper()`, `syncActiveToExpected()`, `confirmDeleteDev()`, `js-remove-dev` branch.
- `[FIX]` `runAll()` queues for `registeredDevelopers` (was `expectedDevelopers` — would be empty after removal). `renderExceptions()` and `renderHeadlineInsight()` likewise.

### Component 4: CSV Roster Reconciliation (Index.html & JavaScript.html)

- CSV/TXT drag-drop card on the Registered Users page; one name per line (first CSV column used; `name` header row skipped).
- Compares normalized names (case/space/underscore/hyphen-insensitive) against `registeredDevelopers`:
  - **Awaiting Onboarding** — in CSV, not registered → "+ Register" button.
  - **Out of Sync / To Pause** — registered, not in CSV → Pause/Resume + Delete buttons.
- `[FIX]` Buttons use `data-name` attributes + the existing delegated click listener (no inline `onclick` quote-escaping).
- `[FIX]` Reconciliation re-runs after the dashboard data actually refreshes (hooked into `renderDashboard`), not synchronously after `fetchData()` is *queued* (stale-data race).

### Component 5: GAS Execution & Database Optimization (Code.gs & claude-usage-uploader.js)

1. **Uploader Polling Throttle:** `POLL_INTERVAL_MS` 5s → **60s**; bump `VERSION` to `2.1.0` (requires manual binary rebuild — Sophos blocks shell from Claude Code — plus Gist manifest update).
2. **In-place roster updates replacing HeartbeatLog:**
   - `RegisteredDevelopers` schema (9 cols): `Name, RegisteredAt, LastSeen, LastHeartbeat, LastPong, LastUpload, Version, NextPollAt, LastUpdateCheck`.
   - `[FIX]` `ensureRegisteredDevelopersSheet()` **upgrades existing 2-col sheets in place** (header backfill, same pattern as `ensureTriggerQueue`).
   - `doPost`: **only noise statuses** (`HEARTBEAT, WAITING, PONG, PAUSED, WAITING_PAUSED`) switch from append-rows to in-place roster cell updates. `[FIX]` All other statuses (`GENERATE_START, UPLOAD_START, GENERATE_DONE, UPDATE_START, UPDATED, POLLING_ACK, SUCCESS, FAILURE`) continue appending to ComplianceLog — the Queue page (`getInProgressRuns_`), progress rows, Smart Retry, and CSV export depend on them.
   - `[FIX]` Throttle (60s/dev cache) applies to `HEARTBEAT/WAITING/PAUSED/WAITING_PAUSED` only — **never PONG**, or admin Ping tests would be silently swallowed.
   - `[FIX]` Noise pings must **not** call `bumpLastModified_()` (it flushes the dashboardData cache → every heartbeat would force a full rebuild). They only refresh the `lastModified` cache value, exactly as today. SUCCESS/FAILURE keep the full `bumpLastModified_()`.
   - `[FIX]` Roster cell updates are written as **one `setValues` range write** (cols 3–9), not 3–4 separate `setValue` calls.
   - SUCCESS also stamps `LastUpload` (col 6) in the roster.
   - `getActiveUsers()` reads the roster directly (no log scans). `[FIX]` Keeps `lastSuccessNextPoll` (from `NextPollAt`) — Upload Summary's "Next Up" cell uses it — and `lastUpdateCheck`.
   - `[FIX]` `getDeveloperLogs`, `getDeveloperProgressStatus`, `getDeveloperProgressStatusBatch` stop reading HeartbeatLog; `lastNextPollAt` comes from the roster's `NextPollAt` column.
   - `[FIX]` One-time migration: bump `INIT_VERSION` `'v2'` → `'v3'`; `maybeRunOneTimeInit_` backfills the new roster columns from existing ComplianceLog + HeartbeatLog rows **before** `cleanupSheets_()` deletes `HeartbeatLog` and `ExpectedDevelopers` (both removed from `REQUIRED_SHEETS`).
   - `pruneHeartbeatLog()` drops its HeartbeatLog entry (sheet gone); keeps AppLog + ComplianceLog pruning. Same for `adminForcePrune()`.
3. **Expected Developers full removal (server):** delete `ensureExpectedDevelopersSheet`, `getExpectedDevelopersList`, `addExpectedDeveloper`, `removeExpectedDeveloper`, `adminSyncActiveToExpected`, the doPost "remove from Expected on first ping" block, and `expectedDevelopers` from the dashboard payload. `complianceTrend`'s `expectedRosterSize` becomes the registered count.

### Component 6: Drive File Deletion & Auto-Cleanup (Code.gs)

- `SHARED_DRIVE_FOLDER_ID = '0AMXBcPT9R10cUk9PVA'` + `deleteUploaderDriveFiles_(name)` — exact-name match on `<Name_with_underscores>_claude_daily.json` / `_claude_session.json`, `setTrashed(true)`, errors logged not thrown.
- `cleanupPausedDevelopersFiles()` — single folder iteration against all paused prefixes; invoked at the top of `runStallScan()` (hourly trigger).
- `adminPauseDeveloper(name)` calls `deleteUploaderDriveFiles_(name)` after the roster append (outside the lock-sensitive path).
- `removeRegisteredDeveloper(name)` also removes the dev's PausedDevelopers row and deletes Drive files.
- Note: paused uploaders idle client-side (no uploads) once they see `paused:true` on their next poll (≤60s); the hourly sweep is the backstop for anything uploaded in that window or while the server can't reach the client.

---

## Verification Plan (manual — GAS deploy required)

1. **Silent refresh:** leave dashboard open 120s → data updates without button spinner/loader; expanded progress rows stay expanded.
2. **Scrolling:** all `.table-wrap` tables cap at 480px, sticky headers, themed scrollbars.
3. **Register:** manual add on Registered Users page works; first-ping auto-registration still works.
4. **CSV reconciliation:** upload CSV → unregistered names show under Awaiting Onboarding with working "+ Register"; missing-from-CSV devs show under Out of Sync with working Pause/Delete.
5. **Pause:** Drive JSONs trashed immediately; status flips to Paused; uploader idles within 60s.
6. **Hourly sweep:** file uploaded for a paused dev is trashed on next `runStallScan()`.
7. **Delete:** confirm modal warns about Drive deletion; dev removed from Registered + Paused sheets; files trashed.
8. **Queue page regression:** Generate a run → POLLING_ACK/GENERATE_START/UPLOAD_START still appear in progress rows and Queue page (ComplianceLog lifecycle events intact).
9. **Ping test regression:** Ping → PONG lands (may take up to 60s with new binaries) and Last Pong updates.
10. **Migration:** after first page load post-deploy (INIT v3), HeartbeatLog + ExpectedDevelopers sheets are gone, roster has 9 columns with backfilled LastSeen/Version data.
