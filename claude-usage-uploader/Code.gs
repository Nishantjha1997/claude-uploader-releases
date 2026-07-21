// ================================================================
// Claude Usage Uploader — Compliance Dashboard (Google Apps Script)
// Code.gs (Server-side logic)
// ================================================================

// -------------------- WEBHOOK AUTH (v2) --------------------
// Default secret. v2: also reads `hmac_secret` from ScriptProperties when set,
// so the secret can be rotated without a code redeploy. Currently-deployed
// uploader binaries still sign with the constant — keeping it allows a
// rolling migration once binaries are redeployed.
var WEBHOOK_HMAC_SECRET_DEFAULT = 'ss-uploader-hmac-2026-b7f3a9c1d4e2';
var HMAC_STALE_SECS = 300;   // v2: tightened from 7200s (was a 2h replay window)
var HMAC_FUTURE_TOL = 300;   // Allow up to 5 minutes clock skew tolerance for drifted client machines

function getWebhookSecret_() {
  try {
    var override = PropertiesService.getScriptProperties().getProperty('hmac_secret');
    return (override && override.length > 8) ? override : WEBHOOK_HMAC_SECRET_DEFAULT;
  } catch (e) {
    return WEBHOOK_HMAC_SECRET_DEFAULT;
  }
}

// Accept both the Script Properties override and the compiled fleet secret
// during rolling upgrades. Previously, setting hmac_secret immediately
// invalidated every already-installed client and produced fleet-wide stalls.
function getWebhookSecrets_() {
  var secrets = [];
  try {
    var override = PropertiesService.getScriptProperties().getProperty('hmac_secret');
    if (override && override.length > 8) secrets.push(override);
  } catch (e) {}
  if (secrets.indexOf(WEBHOOK_HMAC_SECRET_DEFAULT) === -1) secrets.push(WEBHOOK_HMAC_SECRET_DEFAULT);
  return secrets;
}

function computeHmac256_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  return raw.map(function(b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

// v2: Constant-time string equality — avoids early-exit timing leaks even though
// the GAS sandbox makes this largely cosmetic; it's still good hygiene.
function safeEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// v2: Anti-replay nonce cache — signatures used within the staleness window
// are remembered for the full window length and can't be replayed.
function nonceSeen_(sig) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'nsig_' + sig.substring(0, 32);
    if (cache.get(key)) return true;
    cache.put(key, '1', HMAC_STALE_SECS + 30);
    return false;
  } catch (e) {
    return false; // fail-open on cache errors; tighter than crashing
  }
}

// Returns '' on success, or a short reason string on failure.
// v2: rejects future-dated timestamps, enforces a tight 5-min staleness
// window, and caches signatures to block replay within that window.
function verifyWebhookSignature_(e) {
  var ts  = (e.parameter && e.parameter._ts)  ? e.parameter._ts  : '';
  var sig = (e.parameter && e.parameter._sig) ? e.parameter._sig : '';
  if (!ts || !sig) return 'missing_params';
  var tsInt = parseInt(ts, 10);
  if (!isFinite(tsInt) || tsInt <= 0) return 'bad_ts';
  var now = Math.floor(Date.now() / 1000);
  var skew = now - tsInt; // positive = past, negative = future
  if (skew > HMAC_STALE_SECS) return 'stale_ts (' + skew + 's, limit ' + HMAC_STALE_SECS + 's)';
  if (skew < -HMAC_FUTURE_TOL) return 'future_ts (' + (-skew) + 's ahead of server)';
  var body = (e.postData && e.postData.contents) ? e.postData.contents : '';
  var secrets = getWebhookSecrets_();
  var matched = false;
  for (var i = 0; i < secrets.length; i++) {
    var expected = computeHmac256_(secrets[i], ts + '.' + body);
    if (safeEqual_(sig, expected)) matched = true;
  }
  if (!matched) return 'sig_mismatch';
  if (nonceSeen_(sig)) return 'replay_blocked';
  return '';
}

// -------------------- STATUS CONSTANTS --------------------
var STATUS = {
  REGISTERED:     'REGISTERED',
  HEARTBEAT:      'HEARTBEAT',
  WAITING:        'WAITING',
  PAUSED:         'PAUSED',
  WAITING_PAUSED: 'WAITING_PAUSED',
  PONG:           'PONG',
  POLLING_ACK:    'POLLING_ACK',
  GENERATE_START: 'GENERATE_START',
  GENERATE_DONE:  'GENERATE_DONE',
  UPLOAD_START:   'UPLOAD_START',
  UPLOAD_DONE:    'UPLOAD_DONE',
  SUCCESS:        'SUCCESS',
  FAILURE:        'FAILURE',
  UPDATED:        'UPDATED'
};

// Status types considered "noise" — v3: these update the developer's
// RegisteredDevelopers row in-place instead of appending log rows.
var NOISE_STATUSES = [STATUS.HEARTBEAT, STATUS.WAITING, STATUS.PONG, STATUS.PAUSED, STATUS.WAITING_PAUSED];

// -------------------- ADMIN ACCESS CONTROL (v2) --------------------
// v2: Admin allowlist is now backed by Script Properties (`admin_emails`,
// comma-separated). When the property is empty/unset, behaviour falls back to
// "no allowlist" (current pilot mode) so existing deployments keep working.
// Once the property is set, the gate is enforced strictly. Admins can edit
// the list from the Health page without redeploying.
var ADMIN_EMAILS = []; // legacy in-source fallback (still honoured if non-empty)

function getAdminAllowlist_() {
  var list = ADMIN_EMAILS.slice();
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('admin_emails') || '';
    raw.split(/[,\s;]+/).forEach(function(em) {
      em = em.trim().toLowerCase();
      if (em && list.indexOf(em) === -1) list.push(em);
    });
  } catch (e) {}
  return list;
}

function isAdmin_(email) {
  if (!email) return false;
  var list = getAdminAllowlist_();
  if (list.length === 0) return true; // pilot mode — anyone authenticated
  return list.indexOf(String(email).toLowerCase()) !== -1;
}

function requireAdmin_() {
  var list = getAdminAllowlist_();
  if (list.length === 0) return; // pilot mode (no allowlist configured)
  var email;
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  if (!email || list.indexOf(email.toLowerCase()) === -1) {
    throw new Error('Unauthorized: ' + (email || 'anonymous') + '. Configure admin_emails in Script Properties.');
  }
}

// v2: surface allowlist state to the client (for the Health page editor)
function getAdminAllowlistInfo() {
  var email;
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  var list = getAdminAllowlist_();
  return {
    currentUserEmail: email,
    allowlist: list,
    pilotMode: list.length === 0,
    isAdminCurrentUser: isAdmin_(email)
  };
}

function setAdminAllowlist(emailsCsv) {
  // First admin to set the list also becomes one of its members (bootstrap).
  var existing = getAdminAllowlist_();
  if (existing.length > 0) requireAdmin_();
  var clean = String(emailsCsv || '').split(/[,\s;]+/).map(function(e) { return e.trim().toLowerCase(); }).filter(Boolean);
  PropertiesService.getScriptProperties().setProperty('admin_emails', clean.join(','));
  return { success: true, allowlist: clean };
}

function doGet(e) {
  // API route: local uploader polls this to check for admin-queued triggers
  if (e && e.parameter && e.parameter.action === 'checkTrigger') {
    var name = e.parameter.name || '';
    var result = checkAndClearTrigger(name);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  maybeRunOneTimeInit_();
  return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('Compliance Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Runs sheet setup + trigger install only once per script version, not on every page load.
// Keyed by a version string — bump the value to force a re-run after major schema changes.
var INIT_VERSION = 'v4';
function maybeRunOneTimeInit_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('initDone') === INIT_VERSION) return; // already done
  ensureRegisteredDevelopersSheet();
  // v3: backfill the new roster activity columns from the legacy log sheets
  // BEFORE cleanupSheets_ deletes HeartbeatLog/ExpectedDevelopers.
  try { migrateRosterActivity_(); } catch (e) { log_('v3 migration error: ' + e.toString()); }
  installPruneTrigger();
  cleanupSheets_();
  invalidateCache_();
  props.setProperty('initDone', INIT_VERSION);
}

// v3 one-time migration: derive per-developer LastSeen / LastHeartbeat /
// LastPong / LastUpload / Version / NextPollAt / LastUpdateCheck from the
// legacy ComplianceLog + HeartbeatLog rows and write them into the roster.
// Developers seen in the logs but missing from the roster are appended so
// no one disappears from the dashboard after the cutover.
function migrateRosterActivity_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureRegisteredDevelopersSheet();
  var userMap = {};

  function scan(sheetName, maxRows) {
    var s = ss.getSheetByName(sheetName);
    if (!s) return;
    var data = getRecentLogRows_(s, maxRows);
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (!row[0] || !row[1]) continue;
      var ts = row[0];
      ts = (ts && typeof ts.getTime === 'function') ? ts.toISOString() : String(ts);
      var name = String(row[1]).trim();
      if (!name) continue;
      var status = String(row[3] || '').trim().toUpperCase();
      var key = name.toLowerCase();
      if (!userMap[key]) userMap[key] = { name: name, lastSeen: '', lastHeartbeat: '', lastPong: '', lastUpload: '', version: '', nextPollAt: '', lastUpdateCheck: '' };
      var u = userMap[key];
      var isNewer = !u.lastSeen || new Date(ts) > new Date(u.lastSeen);
      if (isNewer) u.lastSeen = ts;
      if (status === 'HEARTBEAT' || status === 'WAITING' || status === 'POLLING_ACK' || status === 'PAUSED' || status === 'WAITING_PAUSED') {
        if (!u.lastHeartbeat || new Date(ts) > new Date(u.lastHeartbeat)) u.lastHeartbeat = ts;
      }
      if (status === 'PONG' && (!u.lastPong || new Date(ts) > new Date(u.lastPong))) u.lastPong = ts;
      if (status === 'SUCCESS' && (!u.lastUpload || new Date(ts) > new Date(u.lastUpload))) {
        u.lastUpload = ts;
      }
      if (row[5] && isNewer) u.nextPollAt = String(row[5]).trim();
      if (row[6] && isNewer) u.version = String(row[6]).trim();
      if (row[7] && String(row[7]).trim() !== 'never' && isNewer) u.lastUpdateCheck = String(row[7]).trim();
    }
  }
  scan('ComplianceLog', 8000);
  scan('HeartbeatLog', 2000);

  var data = sheet.getDataRange().getValues();
  var rowByKey = {};
  for (var r = 1; r < data.length; r++) {
    if (data[r][0]) rowByKey[String(data[r][0]).trim().toLowerCase()] = r + 1;
  }
  var migrated = 0;
  Object.keys(userMap).forEach(function(key) {
    var u = userMap[key];
    var rowIdx = rowByKey[key];
    if (!rowIdx) {
      sheet.appendRow([u.name, u.lastSeen || new Date().toISOString(), u.lastSeen, u.lastHeartbeat, u.lastPong, u.lastUpload, u.version, u.nextPollAt, u.lastUpdateCheck]);
    } else {
      sheet.getRange(rowIdx, 3, 1, 7).setValues([[u.lastSeen, u.lastHeartbeat, u.lastPong, u.lastUpload, u.version, u.nextPollAt, u.lastUpdateCheck]]);
    }
    migrated++;
  });
  log_('v3 migration: backfilled roster activity for ' + migrated + ' developer(s)');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// -------------------- SHEET HELPERS --------------------

// v3: HeartbeatLog removed (noise pings now update RegisteredDevelopers
// in-place) and ExpectedDevelopers removed (roster consolidation — CSV
// reconciliation on the dashboard replaces the awaiting-onboarding list).
// cleanupSheets_() deletes both on the v3 one-time init.
var REQUIRED_SHEETS = [
  'ComplianceLog', 'RegisteredDevelopers', 'PausedDevelopers',
  'TriggerQueue', 'AppLog', 'Settings'
];

function cleanupSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var obsoleteNames = ['HeartbeatLog', 'ExpectedDevelopers'];
  var removed = 0;
  obsoleteNames.forEach(function(name) {
    var s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1) {
      try { ss.deleteSheet(s); removed++; } catch(e) {}
    }
  });
  if (removed > 0) { log_('Cleanup: removed ' + removed + ' known obsolete sheet(s)'); invalidateCache_(); }
}

// v3: the roster doubles as the live-activity database. Noise pings
// (heartbeats etc.) update these columns in-place instead of appending
// rows to a log sheet — keeps cell count flat regardless of fleet uptime.
// Columns: 1=Name 2=RegisteredAt 3=LastSeen 4=LastHeartbeat 5=LastPong
//          6=LastUpload 7=Version 8=NextPollAt 9=LastUpdateCheck
var REG_SHEET_HEADERS = ['Name', 'RegisteredAt', 'LastSeen', 'LastHeartbeat', 'LastPong', 'LastUpload', 'Version', 'NextPollAt', 'LastUpdateCheck'];

function looksLikeIsoDate_(value) {
  if (!value) return false;
  if (value && typeof value.getTime === 'function') return !isNaN(value.getTime());
  var text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(text) && !isNaN(new Date(text).getTime());
}

function looksLikeVersion_(value) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(value || '').trim());
}

function repairRegisteredDevelopersSchema_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (!data.length) data = [REG_SHEET_HEADERS];
  var headers = data[0].map(function(h) { return String(h || '').trim(); });
  var exact = headers.length >= REG_SHEET_HEADERS.length;
  for (var h = 0; h < REG_SHEET_HEADERS.length && exact; h++) exact = headers[h] === REG_SHEET_HEADERS[h];
  if (exact) return false;

  var repaired = [REG_SHEET_HEADERS.slice()];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var name = String(row[0] || '').trim();
    if (!name) continue;
    // The broken v3 migration wrote activity into positions C:I while leaving
    // the old Name/FirstSeenAt/Version/Status headers in A:D. Preserve only
    // values that are valid for their intended semantic type.
    var registeredAt = looksLikeIsoDate_(row[1]) ? row[1] : new Date().toISOString();
    var lastSeen = looksLikeIsoDate_(row[2]) ? row[2] : '';
    var lastHeartbeat = looksLikeIsoDate_(row[3]) ? row[3] : '';
    var lastPong = looksLikeIsoDate_(row[4]) ? row[4] : '';
    var lastUpload = looksLikeIsoDate_(row[5]) ? row[5] : '';
    var version = looksLikeVersion_(row[6]) ? String(row[6]).trim() : (looksLikeVersion_(row[2]) ? String(row[2]).trim() : '');
    var nextPollAt = looksLikeIsoDate_(row[7]) ? row[7] : '';
    var lastUpdateCheck = looksLikeIsoDate_(row[8]) ? row[8] : '';
    repaired.push([name, registeredAt, lastSeen, lastHeartbeat, lastPong, lastUpload, version, nextPollAt, lastUpdateCheck]);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, repaired.length, REG_SHEET_HEADERS.length).setValues(repaired);
  sheet.getRange(1, 1, 1, REG_SHEET_HEADERS.length).setFontWeight('bold');
  log_('v4 migration: repaired RegisteredDevelopers header/value mapping for ' + (repaired.length - 1) + ' row(s)');
  return true;
}

function ensureRegisteredDevelopersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('RegisteredDevelopers');
  if (!sheet) {
    sheet = ss.insertSheet('RegisteredDevelopers');
    sheet.appendRow(REG_SHEET_HEADERS);
    sheet.getRange(1, 1, 1, REG_SHEET_HEADERS.length).setFontWeight('bold');
  } else {
    if (repairRegisteredDevelopersSchema_(sheet)) return sheet;
    var lastCol = sheet.getLastColumn();
    if (lastCol < REG_SHEET_HEADERS.length) {
      // Upgrade pre-v3 sheets (Name, RegisteredAt only) in place
      var missing = REG_SHEET_HEADERS.slice(lastCol);
      sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  return sheet;
}

function ensurePausedDevelopersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('PausedDevelopers');
  if (!sheet) {
    sheet = ss.insertSheet('PausedDevelopers');
    sheet.appendRow(['Name', 'PausedAt', 'PausedBy']);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  }
  return sheet;
}

// v2: all week-math is anchored in the script timezone (typically Asia/Kolkata
// for Sigma Solve) AND traversed via the same Utilities.formatDate call so the
// header sequence can never drift on UTC offset boundaries. Previous version
// mixed script-tz (Monday calc) with UTC (decrement) — produced off-by-one
// dates for the older entries in the 8-week grid.
function getCurrentWeekStart_() {
  var tz = Session.getScriptTimeZone();
  var nowStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  // Reconstruct a Date that *represents* the same wall-clock time in tz
  var parts = nowStr.split(/[- :]/);
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1;
  var dayOfMonth = parseInt(parts[2], 10);
  // Day-of-week in script tz: format with EEE
  var dayName = Utilities.formatDate(new Date(), tz, 'EEE');
  var dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var dow = dayMap[dayName];
  var diff = (dow === 0) ? -6 : 1 - dow;
  // Build a fresh "Monday of this week, noon UTC" anchor that doesn't drift across DST
  var anchor = new Date(Date.UTC(year, month, dayOfMonth + diff, 12, 0, 0));
  return Utilities.formatDate(anchor, tz, 'yyyy-MM-dd');
}

function getWeekHeaders_(n) {
  var headers = [];
  var curr = getCurrentWeekStart_();
  var parts = curr.split('-');
  // Anchor at UTC noon to dodge DST boundary drift, then walk back 7 days at a
  // time using setUTCDate (safe arithmetic).
  var d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
  for (var i = 0; i < n; i++) {
    headers.push(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return headers;
}

function ensureTriggerQueue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TriggerQueue');
  if (!sheet) {
    sheet = ss.insertSheet('TriggerQueue');
    sheet.appendRow(['Name', 'QueuedAt', 'QueuedBy', 'Type', 'NotBefore']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  } else {
    var lastCol = sheet.getLastColumn();
    if (lastCol < 4) {
      sheet.getRange(1, 4).setValue('Type').setFontWeight('bold');
    }
    if (lastCol < 5) {
      sheet.getRange(1, 5).setValue('NotBefore').setFontWeight('bold');
    }
  }
  return sheet;
}

// -------------------- TRIGGER QUEUE --------------------

function adminQueueTrigger(name, type) {
  requireAdmin_();
  type = type || 'FORCE_RUN';
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ensureTriggerQueue();

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        return { success: false, error: 'A trigger is already queued for ' + name };
      }
    }

    var who = '';
    try { who = Session.getActiveUser().getEmail(); } catch (e) { who = 'admin'; }

    sheet.appendRow([name.trim(), new Date().toISOString(), who, type, new Date().toISOString()]);
    log_('TriggerQueue: queued ' + type + ' for ' + name + ' by ' + who);
    invalidateCache_();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// Bulk-queue FORCE_RUN for multiple developers in one lock acquisition.
// Skips names already in the queue. Returns { queued: [], skipped: [] }.
function adminQueueTriggerBatch(names) {
  requireAdmin_();
  if (!names || !names.length) return { queued: [], skipped: [] };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ensureTriggerQueue();
    var data = sheet.getDataRange().getValues();
    var alreadyQueued = {};
    for (var i = 1; i < data.length; i++) {
      if (data[i][0]) alreadyQueued[String(data[i][0]).trim().toLowerCase()] = true;
    }
    var who = '';
    try { who = Session.getActiveUser().getEmail(); } catch (e) { who = 'admin'; }
    var queued = [], skipped = [], baseTime = Date.now();
    names.forEach(function(name) {
      var key = String(name).trim().toLowerCase();
      if (alreadyQueued[key]) {
        skipped.push(name);
      } else {
        // Stagger each trigger by 60s to prevent simultaneous GAS executions
        var notBefore = new Date(baseTime + queued.length * 60000).toISOString();
        sheet.appendRow([name.trim(), new Date().toISOString(), who, 'FORCE_RUN', notBefore]);
        queued.push(name);
        alreadyQueued[key] = true;
      }
    });
    if (queued.length > 0) {
      log_('TriggerQueue: batch queued ' + queued.length + ' FORCE_RUN(s) by ' + who);
      invalidateCache_();
    }
    return { queued: queued, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// Queue a ping request — uploader responds with PONG status
function adminQueuePing(name) {
  requireAdmin_();
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ensureTriggerQueue();

    // Replace any existing queue entry for this user (ping supersedes nothing, but prevent dupe)
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        // If already a PING pending, don't add another
        if (String(data[i][3]).trim() === 'PING') {
          return { success: false, error: 'Ping already pending for ' + name };
        }
        // If a FORCE_RUN is pending, let it be — just add the ping on top (different rows)
      }
    }

    var who = '';
    try { who = Session.getActiveUser().getEmail(); } catch (e) { who = 'admin'; }

    sheet.appendRow([name.trim(), new Date().toISOString(), who, 'PING', new Date().toISOString()]);
    log_('TriggerQueue: queued PING for ' + name + ' by ' + who);
    invalidateCache_();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function checkAndClearTrigger(name) {
  if (!name) return { triggered: false, paused: false };

  // --- FAST PATH: serve all three pre-checks from CacheService.
  // 99% of calls (idle developers) take this branch with ZERO spreadsheet reads.
  var pausedSet       = getPausedSetCached_();
  var uploadFrequency = getSettingCached_('uploadFrequency', 'weekly');
  var uploadSchedule  = getUploadScheduleCached_();
  var paused          = !!pausedSet[name.trim().toLowerCase()];

  // Trigger-queue check — served from a 15-second cache.
  // Only a real trigger event (very rare) causes a cache miss here.
  var queueRows = getTriggerQueueRowsCached_();
  var now = new Date();
  var candidateFound = false;
  var nameLower = name.trim().toLowerCase();
  for (var k = 0; k < queueRows.length; k++) {
    if (queueRows[k].name.toLowerCase() === nameLower) {
      var nb = queueRows[k].notBefore;
      if (nb && new Date(nb) > now) continue; // not yet ready
      candidateFound = true;
      break;
    }
  }
  if (!candidateFound) {
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency, uploadSchedule: uploadSchedule };
  }

  // --- SAFE PATH (exclusive lock) ---
  // A row was spotted in cache; acquire the lock and re-read from the sheet before
  // mutating so concurrent requests cannot double-consume the same trigger entry.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName('TriggerQueue');
  if (!qSheet) return { triggered: false, paused: paused, uploadFrequency: uploadFrequency, uploadSchedule: uploadSchedule };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    log_('checkAndClearTrigger: lock timeout for ' + name);
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency, uploadSchedule: uploadSchedule };
  }
  try {
    var data = qSheet.getDataRange().getValues();
    var now2 = new Date();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === nameLower) {
        var nb2 = data[i][4] ? String(data[i][4]).trim() : '';
        if (nb2 && new Date(nb2) > now2) continue; // not yet ready
        var triggerType = data[i][3] ? String(data[i][3]).trim() : 'FORCE_RUN';
        qSheet.deleteRow(i + 1);
        SpreadsheetApp.flush();  // commit immediately so concurrent readers see it gone
        log_('TriggerQueue: consumed ' + triggerType + ' for ' + name);
        invalidateCache_();
        return { triggered: true, type: triggerType, paused: paused, uploadFrequency: uploadFrequency, uploadSchedule: uploadSchedule };
      }
    }
    // Trigger was claimed by a concurrent request between the cache-check and lock acquisition.
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency, uploadSchedule: uploadSchedule };
  } finally {
    lock.releaseLock();
  }
}

function adminGetTriggerQueue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TriggerQueue');
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      result.push({
        name: String(data[i][0]).trim(),
        queuedAt: data[i][1] ? String(data[i][1]) : '',
        queuedBy: data[i][2] ? String(data[i][2]) : '',
        type: data[i][3] ? String(data[i][3]).trim() : 'FORCE_RUN',
        notBefore: data[i][4] ? String(data[i][4]).trim() : ''
      });
    }
  }
  return result;
}

function adminCancelTrigger(name) {
  requireAdmin_();
  if (!name) return { success: false };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('TriggerQueue');
    if (!sheet) return { success: false };

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        invalidateCache_();
        return { success: true };
      }
    }
    return { success: false, error: 'No trigger found for ' + name };
  } finally {
    lock.releaseLock();
  }
}

// Wipes every queued trigger in one shot. Useful to clear stale rows that were
// never consumed because the agent was offline when the trigger was issued.
function adminClearAllTriggers() {
  requireAdmin_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('TriggerQueue');
    if (!sheet) return { success: true, cleared: 0 };

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: true, cleared: 0 };  // header only

    var numRows = lastRow - 1;
    sheet.deleteRows(2, numRows);  // delete all data rows in one API call
    SpreadsheetApp.flush();
    log_('TriggerQueue: cleared ' + numRows + ' stale trigger(s)');
    invalidateCache_();
    return { success: true, cleared: numRows };
  } finally {
    lock.releaseLock();
  }
}

// -------------------- DEVELOPER LOGS --------------------

// Returns the last `limit` log entries for a specific developer, newest first.
function getDeveloperLogs(name, limit) {
  requireAdmin_(); // v2: gate behind admin allowlist (soft — no-op in pilot mode)
  limit = limit || 25;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logs = [];
  
  function extractLogs(sheetName) {
    var logSheet = ss.getSheetByName(sheetName);
    if (!logSheet) return;
    var data = getRecentLogRows_(logSheet, 300);
    for (var i = data.length - 1; i >= 0; i--) {
      var row = data[i];
      if (!row[0]) continue;
      if (String(row[1]).trim().toLowerCase() !== name.trim().toLowerCase()) continue;

      var ts = row[0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts);

      logs.push({
        timestamp: ts,
        status: String(row[3]).trim().toUpperCase(),
        message: String(row[4] || '')
      });
    }
  }

  // v3: ComplianceLog only — heartbeat noise no longer produces log rows
  // (live presence is shown from the roster instead).
  extractLogs('ComplianceLog');

  // Sort by timestamp descending (newest first)
  logs.sort(function(a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  return logs.slice(0, limit);
}

// -------------------- ACTIVE USERS --------------------

// v3: reads per-developer activity straight from the RegisteredDevelopers
// roster (kept current in-place by doPost) — no log scanning. One sheet read
// of N rows replaces the old 2000-row ComplianceLog/HeartbeatLog sweep.
// Returns array of { name, lastSeen, lastHeartbeat, lastUpload, lastPong, ... }
function getActiveUsers() {
  requireAdmin_(); // v2: gate behind admin allowlist (soft — no-op in pilot mode)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureRegisteredDevelopersSheet();
  var sheet = ss.getSheetByName('RegisteredDevelopers');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();

  function isoStr(v) {
    if (!v) return null;
    if (typeof v.getTime === 'function') return v.toISOString();
    var s = String(v).trim();
    return s || null;
  }

  // Enrich with pending trigger info
  var triggerMap = {};
  var tSheet = ss.getSheetByName('TriggerQueue');
  if (tSheet) {
    var tData = tSheet.getDataRange().getValues();
    for (var j = 1; j < tData.length; j++) {
      if (tData[j][0]) {
        var tName = String(tData[j][0]).trim().toLowerCase();
        var tType = tData[j][3] ? String(tData[j][3]).trim() : 'FORCE_RUN';
        if (!triggerMap[tName]) triggerMap[tName] = {};
        triggerMap[tName][tType] = true;
      }
    }
  }

  // Check paused state for all users
  var pausedMap = getPausedDevelopersMap_();

  var users = [];
  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][0] || '').trim();
    if (!name) continue;
    var key = name.toLowerCase();
    users.push({
      name: name,
      registeredAt:        isoStr(data[i][1]),
      lastSeen:            isoStr(data[i][2]),
      lastHeartbeat:       isoStr(data[i][3]),
      lastPong:            isoStr(data[i][4]),
      lastUpload:          isoStr(data[i][5]),
      version:             data[i][6] ? String(data[i][6]).trim() : null,
      lastSuccessNextPoll: isoStr(data[i][7]),  // NextPollAt — feeds the Upload Summary "Next Up" cell
      lastUpdateCheck:     data[i][8] ? String(data[i][8]).trim() : null,
      pendingTrigger: !!(triggerMap[key] && triggerMap[key]['FORCE_RUN']),
      pendingPing:    !!(triggerMap[key] && triggerMap[key]['PING']),
      paused:         !!pausedMap[key],
      pausedAt:       pausedMap[key] ? pausedMap[key].pausedAt : null,
      pausedBy:       pausedMap[key] ? pausedMap[key].pausedBy : null
    });
  }
  return users.sort(function(a, b) {
    if (!a.lastSeen) return 1;
    if (!b.lastSeen) return -1;
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });
}

// -------------------- DASHBOARD DATA --------------------

// v2: full flush — used by admin mutations only (queueing triggers, paused
// state changes, settings edits, roster edits). Heavy and expensive.
function invalidateCache_() {
  var c = CacheService.getScriptCache();
  chunkedCacheRemove(c, 'dashboardData');
  c.remove('pausedSet');
  c.remove('triggerQueueRows');
  c.remove('setting_uploadFrequency');
  c.remove('upload_schedule_json');
  c.remove('latest_uploader_version_gist');
  c.put('lastModified', String(Date.now()), 3600);
}

// v2: light flush — used by the webhook path on every ComplianceLog /
// HeartbeatLog append. Only invalidates the dashboard payload itself; the
// trigger-queue cache is left alone because heartbeat writes never mutate it,
// and at fleet scale (50 devs × 12 pings/hr = 600 writes/hr) the previous
// behaviour effectively disabled trigger-queue caching.
function bumpLastModified_() {
  try {
    var c = CacheService.getScriptCache();
    chunkedCacheRemove(c, 'dashboardData');
    c.put('lastModified', String(Date.now()), 3600);
  } catch (e) { /* fail-open */ }
}

// -------------------- CACHED FAST-READ HELPERS --------------------
// These replace direct sheet reads in the hot path (checkAndClearTrigger).
// Every mutation calls invalidateCache_() which flushes these keys immediately.

var CACHE_TTL_SETTINGS     = 600;  // settings change rarely — 10 min
var CACHE_TTL_PAUSED       = 120;  // paused state — 2 min
var CACHE_TTL_TRIGGERQUEUE = 15;   // trigger queue — 15 seconds (must stay fresh)

function getSettingCached_(key, defaultVal) {
  var c = CacheService.getScriptCache();
  var cacheKey = 'setting_' + key;
  var cached = c.get(cacheKey);
  if (cached !== null) return cached;
  
  var lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try {
      cached = c.get(cacheKey);
      if (cached !== null) return cached;
      var val = getSetting_(key, defaultVal);
      c.put(cacheKey, String(val), CACHE_TTL_SETTINGS);
      return val;
    } finally {
      lock.releaseLock();
    }
  }
  return defaultVal;
}

// Returns a plain set {lowerCaseName: true} for O(1) lookup.
function getPausedSetCached_() {
  var c = CacheService.getScriptCache();
  var cached = c.get('pausedSet');
  if (cached !== null) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  var lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try {
      cached = c.get('pausedSet');
      if (cached !== null) {
        try { return JSON.parse(cached); } catch(e) {}
      }
      var map = getPausedDevelopersMap_();
      var set = {};
      Object.keys(map).forEach(function(k) { set[k] = true; });
      try { c.put('pausedSet', JSON.stringify(set), CACHE_TTL_PAUSED); } catch(e) {}
      return set;
    } finally {
      lock.releaseLock();
    }
  }
  return {};
}

// Returns serialised trigger-queue rows so doGet/checkAndClearTrigger
// can check for pending triggers without opening the spreadsheet at all.
function getTriggerQueueRowsCached_() {
  var c = CacheService.getScriptCache();
  var cached = c.get('triggerQueueRows');
  if (cached !== null) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  var lock = LockService.getScriptLock();
  if (lock.tryLock(5000)) {
    try {
      cached = c.get('triggerQueueRows');
      if (cached !== null) {
        try { return JSON.parse(cached); } catch(e) {}
      }
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var sheet = ss.getSheetByName('TriggerQueue');
      if (!sheet) {
        try { c.put('triggerQueueRows', '[]', CACHE_TTL_TRIGGERQUEUE); } catch(e) {}
        return [];
      }
      var data = sheet.getDataRange().getValues();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        if (data[i][0]) rows.push({
          name:      String(data[i][0]).trim(),
          type:      data[i][3] ? String(data[i][3]).trim() : 'FORCE_RUN',
          notBefore: data[i][4] ? String(data[i][4]).trim() : ''
        });
      }
      try { c.put('triggerQueueRows', JSON.stringify(rows), CACHE_TTL_TRIGGERQUEUE); } catch(e) {}
      return rows;
    } finally {
      lock.releaseLock();
    }
  }
  return [];
}

// Lightweight endpoint — returns only a change timestamp.
// The dashboard polls this every 5s so new registrations surface immediately
// without doing a full getDashboardData fetch every 5s.
function getLastModified() {
  var ts = CacheService.getScriptCache().get('lastModified');
  return { ts: ts ? parseInt(ts, 10) : 0 };
}

function chunkedCachePut(cache, key, stringData, expiration) {
  var MAX_CHUNK_SIZE = 50000;
  var chunks = Math.ceil(stringData.length / MAX_CHUNK_SIZE);
  if (chunks > 1) {
    for (var i = 0; i < chunks; i++) {
      cache.put(key + '_chunk_' + i, stringData.substring(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE), expiration);
    }
    cache.put(key + '_chunks', String(chunks), expiration);
  } else {
    cache.put(key, stringData, expiration);
    cache.remove(key + '_chunks');
  }
}

function chunkedCacheGet(cache, key) {
  var chunksStr = cache.get(key + '_chunks');
  if (chunksStr) {
    var numChunks = parseInt(chunksStr, 10);
    var data = '';
    for (var i = 0; i < numChunks; i++) {
      var chunk = cache.get(key + '_chunk_' + i);
      if (!chunk) return null; // Incomplete
      data += chunk;
    }
    return data;
  }
  return cache.get(key);
}

function chunkedCacheRemove(cache, key) {
  var chunksStr = cache.get(key + '_chunks');
  if (chunksStr) {
    var numChunks = parseInt(chunksStr, 10);
    for (var i = 0; i < numChunks; i++) {
      cache.remove(key + '_chunk_' + i);
    }
    cache.remove(key + '_chunks');
  }
  cache.remove(key);
}

function getDashboardData() {
  requireAdmin_(); // v2: gate behind admin allowlist (soft — no-op in pilot mode)
  var cache = CacheService.getScriptCache();
  var cached = chunkedCacheGet(cache, 'dashboardData');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    lock.waitLock(10000);
    locked = true;
  } catch (e) {
    throw new Error("Server is generating dashboard data. Please retry in a few moments.");
  }
  
  try {
    cached = chunkedCacheGet(cache, 'dashboardData');
    if (cached) {
      try { return JSON.parse(cached); } catch(e) {}
    }
    
    var data = getDashboardData_uncached_();
    try {
      chunkedCachePut(cache, 'dashboardData', JSON.stringify(data), 300); // 5 mins
    } catch(e) {
      log_('Cache skip: data too large (' + e.message + ')');
    }
    return data;
  } finally {
    if (locked) lock.releaseLock();
  }
}

function getDashboardData_uncached_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Registered Developers (active — compliance is tracked against this list)
  ensureRegisteredDevelopersSheet();
  var regSheet_ = ss.getSheetByName('RegisteredDevelopers');
  var regData_ = regSheet_ ? regSheet_.getDataRange().getValues() : [];
  var registeredNames = [];
  for (var ri_ = 1; ri_ < regData_.length; ri_++) {
    if (regData_[ri_][0]) registeredNames.push(String(regData_[ri_][0]).trim());
  }

  // 2. Compliance Logs — read all but only keep recent weeks to stay under size limit
  var logSheet = ss.getSheetByName('ComplianceLog');
  var allLogs = [];
  var registeredMap = {};

  // 2a. Compliance grid accumulators (8-week history per registered developer)
  var weekHeaders = getWeekHeaders_(8);
  var weekHeaderSet = {};
  weekHeaders.forEach(function(w) { weekHeaderSet[w] = true; });
  var complianceGrid = {};
  registeredNames.forEach(function(n) { complianceGrid[n] = {}; });
  var recentUploadsAll = [];
  var STATUS_RANK = { 'SUCCESS': 2, 'FAILURE': 1 };

  if (logSheet) {
    // v2: bumped from 3000 → 8000 rows so 90-day compliance windows resolve
    // correctly at 50-dev fleet scale. The Trend chart needs at least 12 weeks
    // of SUCCESS/FAILURE history, which 3000 rows didn't cover.
    var logData = getRecentLogRows_(logSheet, 8000);
    for (var i = 0; i < logData.length; i++) {
      var row = logData[i];
      if (!row[0]) continue;

      var ts = row[0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts);

      var ws = row[2];
      if (ws && typeof ws.getTime === 'function') {
        ws = Utilities.formatDate(ws, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        ws = String(ws);
      }

      var name = String(row[1]).trim();
      var status = String(row[3]).trim().toUpperCase();
      var errMsg = String(row[4] || '');
      // Truncate long error messages to save space
      if (errMsg.length > 120) errMsg = errMsg.substring(0, 120) + '...';

      allLogs.push({
        timestamp: ts,
        name: name,
        weekStart: ws,
        status: status,
        error: errMsg
      });

      // 8-week compliance grid (SUCCESS > FAILURE > null precedence)
      if (weekHeaderSet[ws]) {
        if (!complianceGrid[name]) complianceGrid[name] = {};
        var existingStatus = complianceGrid[name][ws];
        var incomingRank = STATUS_RANK[status] || 0;
        var existingRank = STATUS_RANK[existingStatus] || 0;
        if (incomingRank > existingRank) {
          complianceGrid[name][ws] = status;
        } else if (!existingStatus) {
          complianceGrid[name][ws] = null;
        }
      }

      // Recent uploads log (SUCCESS and FAILURE only)
      if (status === 'SUCCESS' || status === 'FAILURE') {
        recentUploadsAll.push({
          name: name,
          timestamp: ts,
          weekStart: ws,
          status: status,
          version: row[6] ? String(row[6]).trim() : '',
          message: errMsg
        });
      }

      // Track registered developers across ALL logs (not just recent)
      if (status === 'REGISTERED') {
        if (!registeredMap[name] || new Date(ts) < new Date(registeredMap[name])) {
          registeredMap[name] = ts;
        }
      }
    }
  }

  // 2b. Sort recentUploads newest-first, keep top 30
  recentUploadsAll.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
  var recentUploads = recentUploadsAll.slice(0, 30);

  // 3. Distinct weeks (newest first) — keep only most recent 8 weeks for dashboard
  var weeksMap = {};
  allLogs.forEach(function(log) { if (log.weekStart) weeksMap[log.weekStart] = true; });
  var weeks = Object.keys(weeksMap).sort().reverse().slice(0, 8);
  var recentWeeksSet = {};
  weeks.forEach(function(w) { recentWeeksSet[w] = true; });

  // 4. Calculate complianceByWeek based on RegisteredDevelopers (active users)
  var complianceByWeek = {};
  weeks.forEach(function(w) {
    complianceByWeek[w] = { expected: 0, reported: 0, failed: 0, pending: 0, details: [] };
    var devStatus = {};
    registeredNames.forEach(function(n) { devStatus[n] = null; });
    
    var weekLogs = allLogs.filter(function(l) { return l.weekStart === w; });
    weekLogs.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

    weekLogs.forEach(function(l) {
      if (devStatus[l.name] === undefined) return;
      if (devStatus[l.name] === null) devStatus[l.name] = l;
    });

    Object.keys(devStatus).forEach(function(dev) {
      var l = devStatus[dev];
      complianceByWeek[w].expected++;
      if (!l) {
         complianceByWeek[w].pending++;
         complianceByWeek[w].details.push({ name: dev, status: 'PENDING', ping: '' });
      } else if (['SUCCESS', 'REPORTED', 'COMPLIANT'].indexOf(l.status) !== -1) {
         complianceByWeek[w].reported++;
         complianceByWeek[w].details.push({ name: dev, status: l.status, ping: l.timestamp });
      } else if (['FAILURE', 'ERROR'].indexOf(l.status) !== -1) {
         complianceByWeek[w].failed++;
         complianceByWeek[w].details.push({ name: dev, status: l.status, ping: l.timestamp });
      } else {
         complianceByWeek[w].pending++;
         complianceByWeek[w].details.push({ name: dev, status: l.status, ping: l.timestamp });
      }
    });
  });

  // 5. Registered developers list (from RegisteredDevelopers sheet, with registration date)
  var registeredDevelopers = regData_.slice(1).filter(function(r){ return r[0]; }).map(function(r) {
    return { name: String(r[0]).trim(), registeredAt: r[1] ? String(r[1]).trim() : '' };
  });

  // 6. Active users with heartbeat / last-seen / pong data
  var activeUsers = getActiveUsers();

  // 7. Pending trigger queue
  var triggerQueue = adminGetTriggerQueue();

  // 8. Paused developers
  var pausedDevelopers = getPausedDevelopersList();

  return {
    methodologyVersion: 'v2.0',
    schemaVersion: SHEET_SCHEMA_VERSION,
    latestVersion: getLatestVersion(),
    registeredDevelopers: registeredDevelopers,
    weeks: weeks,
    complianceByWeek: complianceByWeek,
    activeUsers: activeUsers,
    triggerQueue: triggerQueue,
    currentWeek: getCurrentWeekStart_(),
    pausedDevelopers: pausedDevelopers,
    uploadFrequency: getSetting_('uploadFrequency', 'weekly'),
    uploadSchedule: getUploadSchedule_(),
    complianceGrid: complianceGrid,
    recentUploads: recentUploads,
    weekHeaders: weekHeaders,
    generatedAt: new Date().toISOString()
  };
}

// v2: latest binary version source — replaces the hardcoded LATEST_VERSION
// constant on the client. Reads from Script Properties (admin-editable) and
// falls back to a sensible default for first-deploy compatibility.
function getLatestVersion() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('latest_uploader_version_gist');
  if (cached && cached.length > 0) {
    return cached.trim();
  }

  // Fallback to script property or code default
  var fallback = '2.0.2';
  try {
    var v = PropertiesService.getScriptProperties().getProperty('latest_uploader_version');
    if (v && v.length > 0) fallback = v.trim();
  } catch (e) {}

  // Gist URL containing the version manifest
  var gistUrl = 'https://gist.githubusercontent.com/Nishantjha1997/ad763c62484a3ea70e7507bf671df0bb/raw/version.json';
  try {
    var response = UrlFetchApp.fetch(gistUrl, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      var json = JSON.parse(response.getContentText());
      if (json && json.latestVersion) {
        var ver = String(json.latestVersion).trim();
        cache.put('latest_uploader_version_gist', ver, 3600); // Cache for 1 hour
        return ver;
      }
    }
  } catch (e) {
    log_('getLatestVersion: Failed to fetch from gist: ' + e.toString());
  }

  return fallback;
}

function setLatestVersion(version) {
  requireAdmin_();
  if (!version) return { success: false, error: 'version required' };
  PropertiesService.getScriptProperties().setProperty('latest_uploader_version', String(version).trim());
  try {
    CacheService.getScriptCache().remove('latest_uploader_version_gist');
  } catch (e) {}
  return { success: true, latestVersion: getLatestVersion() };
}

// -------------------- CSV LOG EXPORT --------------------
// Returns the full ComplianceLog as a raw CSV string.
// Only SUCCESS and FAILURE rows are exported (all weeks, not just recent).
function getComplianceLogCSV() {
  requireAdmin_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ComplianceLog');
  if (!sheet) return 'Timestamp,Developer Name,Week Start,Status,Error Message,Version\n';

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 'Timestamp,Developer Name,Week Start,Status,Error Message,Version\n';

  var data = sheet.getRange(1, 1, lastRow, Math.max(sheet.getLastColumn(), 8)).getValues();
  var lines = ['Timestamp,Developer Name,Week Start,Status,Error Message,Version'];

  function csvCell(val) {
    var s = String(val === null || val === undefined ? '' : val);
    // Dates
    if (val && typeof val.toISOString === 'function') s = val.toISOString();
    // v2: CSV-injection guard — prefix cells beginning with =, +, -, @, or
    // tab/cr so Excel/Sheets treats them as literal text, not formulas.
    if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) {
      s = "'" + s;
    }
    // Escape quotes and wrap in quotes if necessary
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var status = String(row[3] || '').trim().toUpperCase();
    // Export all meaningful events — SUCCESS, FAILURE, GENERATE_START, UPLOAD_START, etc.
    // Skip pure noise (HEARTBEAT / WAITING) to keep the CSV manageable
    if (status === 'HEARTBEAT' || status === 'WAITING') continue;
    lines.push([
      csvCell(row[0]),
      csvCell(row[1]),
      csvCell(row[2]),
      csvCell(row[3]),
      csvCell(row[4]),
      csvCell(row[6]) // Version column
    ].join(','));
  }
  return lines.join('\r\n');
}

// -------------------- GLOBAL QUEUE STATUS --------------------
// Returns a summary of pending + in-progress runs for the dashboard status bar.
// Designed to be lightweight — does NOT do a full getDashboardData rebuild.
function getGlobalQueueStatus() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Pending triggers
  var pending = adminGetTriggerQueue();

  // 2. Currently in-progress (last 30 min, terminal not yet received)
  var pendingNames = {};
  pending.forEach(function(p) { pendingNames[p.name.toLowerCase()] = true; });
  var inProgress = getInProgressRuns_(ss, pendingNames);

  // 3. Completed runs this session — scan last 30 min of ComplianceLog for SUCCESS/FAILURE
  var logSheet = ss.getSheetByName('ComplianceLog');
  var recentCompleted = [];
  if (logSheet) {
    var cutoff = new Date(Date.now() - 30 * 60 * 1000);
    var rows = getRecentLogRows_(logSheet, 300);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;
      var ts = row[0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString(); else ts = String(ts);
      if (new Date(ts) < cutoff) continue;
      var status = String(row[3] || '').trim().toUpperCase();
      if (status !== 'SUCCESS' && status !== 'FAILURE') continue;
      var name = String(row[1] || '').trim();
      if (!name) continue;
      recentCompleted.push({
        name: name,
        status: status,
        message: String(row[4] || ''),
        timestamp: ts
      });
    }
    // Deduplicate: keep only the most recent terminal result per developer
    var seenNames = {};
    recentCompleted = recentCompleted.reverse().filter(function(r) {
      if (seenNames[r.name.toLowerCase()]) return false;
      seenNames[r.name.toLowerCase()] = true;
      return true;
    }).reverse();
  }

  return {
    pending: pending,
    inProgress: inProgress.map(function(r) { return { name: r.name }; }),
    recentCompleted: recentCompleted,
    totalQueued: pending.length,
    inProgressCount: inProgress.length,
    completedCount: recentCompleted.length
  };
}

// -------------------- SMART RETRY (SERVER-SIDE) --------------------
// Called from doPost() on every HEARTBEAT/WAITING ping.
// Guards:
//   1. User must have a FAILURE this week with no subsequent SUCCESS.
//   2. No trigger already queued for this user.
//   3. At least 4 hours since last smart retry (PropertiesService cooldown key).
//   4. At most 3 smart retries per user per week (weekly counter in Properties).
function checkAndTriggerSmartRetry_(name) {
  if (!name || name === 'UNKNOWN') return;

  // Guard 1: skip if already queued (fast path via cached queue rows)
  var queueRows = getTriggerQueueRowsCached_();
  var nameLower = name.trim().toLowerCase();
  for (var q = 0; q < queueRows.length; q++) {
    if (queueRows[q].name.toLowerCase() === nameLower) return; // already pending
  }

  // Guard 2: Check cooldown + weekly cap via PropertiesService
  var props = PropertiesService.getScriptProperties();
  var weekKey = getCurrentWeekStart_();
  var cooldownPropKey  = 'smartRetry_cooldown_'  + nameLower;
  var counterPropKey   = 'smartRetry_count_'     + nameLower + '_' + weekKey;

  var lastRetryStr = props.getProperty(cooldownPropKey);
  if (lastRetryStr) {
    var msSince = Date.now() - parseInt(lastRetryStr, 10);
    if (msSince < 4 * 60 * 60 * 1000) return; // < 4 hours — still in cooldown
  }

  var retryCountStr = props.getProperty(counterPropKey);
  var retryCount = retryCountStr ? parseInt(retryCountStr, 10) : 0;
  if (retryCount >= 3) return; // hit weekly cap

  // Guard 3: Confirm there is an actual FAILURE this week with no later SUCCESS.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logSheet = ss.getSheetByName('ComplianceLog');
  if (!logSheet) return;

  var logData = getRecentLogRows_(logSheet, 500);
  var latestFailureTs = null;
  var latestSuccessTs = null;

  for (var i = 0; i < logData.length; i++) {
    var row = logData[i];
    if (!row[0]) continue;
    var rName = String(row[1] || '').trim().toLowerCase();
    if (rName !== nameLower) continue;

    var ws = row[2];
    if (ws && typeof ws.getTime === 'function') ws = Utilities.formatDate(ws, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    else ws = String(ws || '');
    if (ws !== weekKey) continue; // only check this week

    var status = String(row[3] || '').trim().toUpperCase();
    var ts = row[0];
    if (ts && typeof ts.getTime === 'function') ts = ts.toISOString(); else ts = String(ts);

    if (status === 'FAILURE') {
      if (!latestFailureTs || new Date(ts) > new Date(latestFailureTs)) latestFailureTs = ts;
    }
    if (status === 'SUCCESS') {
      if (!latestSuccessTs || new Date(ts) > new Date(latestSuccessTs)) latestSuccessTs = ts;
    }
  }

  // Condition: had a FAILURE this week, and no SUCCESS after it
  if (!latestFailureTs) return; // no failure this week
  if (latestSuccessTs && new Date(latestSuccessTs) > new Date(latestFailureTs)) return; // already succeeded

  // All guards passed — queue the smart retry
  var who = 'system:smartRetry';
  var qSheet = ensureTriggerQueue();
  // Double-check under lock that nobody else queued in the meantime
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var freshData = qSheet.getDataRange().getValues();
    for (var j = 1; j < freshData.length; j++) {
      if (String(freshData[j][0]).trim().toLowerCase() === nameLower) return; // raced — already queued
    }
    var notBefore = new Date().toISOString();
    qSheet.appendRow([name.trim(), new Date().toISOString(), who, 'FORCE_RUN', notBefore]);
    SpreadsheetApp.flush();

    // Update cooldown + counter
    props.setProperty(cooldownPropKey,  String(Date.now()));
    props.setProperty(counterPropKey,   String(retryCount + 1));

    log_('SmartRetry: queued FORCE_RUN for ' + name +
         ' (attempt ' + (retryCount + 1) + '/3 this week, failure at ' + latestFailureTs + ')');
    invalidateCache_();
  } finally {
    lock.releaseLock();
  }
}

// -------------------- DAILY AUTO-GENERATE (v2) --------------------
// For every developer that pings online, the FIRST time they're seen each
// day, wait 10 minutes (so they're stable / not mid-boot) and then queue a
// FORCE_RUN so reports get generated + uploaded that day automatically.
// Skips users that are paused, already have a pending trigger, or have
// already successfully uploaded today.
//
// State lives entirely in CacheService (auto-expires at 24h), so there's no
// permanent state to clean up and no risk of bloating Script Properties.

var AUTOGEN_DELAY_MS = 10 * 60 * 1000;  // 10 minutes after first heartbeat of the day
var AUTOGEN_DEDUP_TTL_S = 23 * 3600;    // cache TTL just under 24h so a new day re-fires

function getAutoGenerateEnabled_() {
  try {
    // Default = ON. Admin can disable via Script Properties: autogen_daily_enabled=0
    var v = PropertiesService.getScriptProperties().getProperty('autogen_daily_enabled');
    return v !== '0' && v !== 'false';
  } catch (e) { return true; }
}

function setAutoGenerateEnabled(enabled) {
  requireAdmin_();
  PropertiesService.getScriptProperties().setProperty('autogen_daily_enabled', enabled ? '1' : '0');
  return { success: true, enabled: !!enabled };
}

function getAutoGenerateStatus() {
  return {
    enabled: getAutoGenerateEnabled_(),
    delayMinutes: Math.round(AUTOGEN_DELAY_MS / 60000),
    description: 'When a developer is first seen online each day, a FORCE_RUN is queued 10 min later so their report uploads automatically.'
  };
}

function maybeQueueDailyAutoGenerate_(name) {
  if (!getAutoGenerateEnabled_()) return;
  if (!name || name === 'UNKNOWN') return;

  var cache = CacheService.getScriptCache();
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lower = name.trim().toLowerCase();
  var firstSeenKey = 'autogen_firstseen_' + today + '_' + lower;
  var queuedKey    = 'autogen_queued_'    + today + '_' + lower;

  // Already queued today? — nothing to do
  if (cache.get(queuedKey)) return;

  var now = Date.now();
  var firstSeenStr = cache.get(firstSeenKey);
  if (!firstSeenStr) {
    // First heartbeat we've observed today for this user — record and wait
    cache.put(firstSeenKey, String(now), AUTOGEN_DEDUP_TTL_S);
    return;
  }
  var firstSeen = parseInt(firstSeenStr, 10);
  if (!isFinite(firstSeen) || now - firstSeen < AUTOGEN_DELAY_MS) return; // still within the 10-min stabilisation window

  // Cheap pre-checks before grabbing the script lock
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (isDeveloperPaused_(ss, name)) {
    cache.put(queuedKey, '1', AUTOGEN_DEDUP_TTL_S); // mark so we don't re-check each heartbeat
    return;
  }

  // Skip if a trigger of any type is already pending for this user
  var queueRows = getTriggerQueueRowsCached_();
  for (var q = 0; q < queueRows.length; q++) {
    if (queueRows[q].name.toLowerCase() === lower) {
      cache.put(queuedKey, '1', AUTOGEN_DEDUP_TTL_S);
      return;
    }
  }

  // Skip if developer already uploaded successfully today (avoids duplicate runs)
  var logSheet = ss.getSheetByName('ComplianceLog');
  if (logSheet) {
    var logData = getRecentLogRows_(logSheet, 200);
    var todayPrefix = today; // YYYY-MM-DD
    for (var i = 0; i < logData.length; i++) {
      var row = logData[i];
      if (!row[0]) continue;
      var rName = String(row[1] || '').trim().toLowerCase();
      if (rName !== lower) continue;
      var status = String(row[3] || '').trim().toUpperCase();
      if (status !== 'SUCCESS') continue;
      var ts = row[0];
      var tsStr = (ts && typeof ts.toISOString === 'function')
        ? Utilities.formatDate(ts, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(ts).substring(0, 10);
      if (tsStr === todayPrefix) {
        // Already uploaded today — mark queued so we don't re-check until tomorrow
        cache.put(queuedKey, '1', AUTOGEN_DEDUP_TTL_S);
        return;
      }
    }
  }

  // Queue the trigger under lock (race-safe — same pattern as SmartRetry)
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    // Re-check queue inside the lock
    var qSheet = ensureTriggerQueue();
    var freshData = qSheet.getDataRange().getValues();
    for (var j = 1; j < freshData.length; j++) {
      if (String(freshData[j][0]).trim().toLowerCase() === lower) {
        cache.put(queuedKey, '1', AUTOGEN_DEDUP_TTL_S);
        return;
      }
    }
    var who = 'system:autoDaily';
    var notBefore = new Date().toISOString();
    qSheet.appendRow([name.trim(), new Date().toISOString(), who, 'FORCE_RUN', notBefore]);
    SpreadsheetApp.flush();
    cache.put(queuedKey, '1', AUTOGEN_DEDUP_TTL_S);
    log_('AutoDaily: queued FORCE_RUN for ' + name + ' (first online today ' + Math.round((now - firstSeen) / 60000) + ' min ago)');
    invalidateCache_();
  } finally {
    lock.releaseLock();
  }
}

// -------------------- WEBHOOK (POST) --------------------

// v3: single write path for live developer activity. Locates (or registers)
// the developer's row in RegisteredDevelopers and updates the activity
// columns (3–9) with ONE setValues call. Returns nothing; errors propagate
// to doPost's catch. Concurrency note: Sheets cell writes are atomic and
// each developer only ever touches their own row, so no ScriptLock is taken
// (a lock here would starve getDashboardData, same rationale as doPost).
function upsertRosterActivity_(name, status, version, nextPollAt, lastUpdateCheck) {
  var sheet = ensureRegisteredDevelopersSheet();
  var data = sheet.getDataRange().getValues();
  var nameLower = name.trim().toLowerCase();
  var rowIdx = -1;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]).trim().toLowerCase() === nameLower) { rowIdx = r + 1; break; }
  }

  var nowIso = new Date().toISOString();
  if (rowIdx === -1) {
    // First ping — auto-register
    sheet.appendRow([name.trim(), nowIso, nowIso, '', '', '', version || '', nextPollAt || '', lastUpdateCheck || '']);
    log_('Registered new developer: ' + name);
    invalidateCache_(); // roster mutation — full flush
    return;
  }

  // Existing row: merge updates into current values, write cols 3–9 in one call
  var cur = data[rowIdx - 1]; // 0-based row from the same read
  var vals = [
    nowIso,                                                   // 3 LastSeen
    cur[3] ? String(cur[3]) : '',                             // 4 LastHeartbeat
    cur[4] ? String(cur[4]) : '',                             // 5 LastPong
    cur[5] ? String(cur[5]) : '',                             // 6 LastUpload
    version ? String(version) : (cur[6] ? String(cur[6]) : ''), // 7 Version
    nextPollAt ? String(nextPollAt) : (cur[7] ? String(cur[7]) : ''), // 8 NextPollAt
    (lastUpdateCheck && lastUpdateCheck !== 'never') ? String(lastUpdateCheck) : (cur[8] ? String(cur[8]) : '') // 9 LastUpdateCheck
  ];
  if (status === STATUS.HEARTBEAT || status === STATUS.WAITING || status === STATUS.POLLING_ACK ||
      status === STATUS.PAUSED || status === STATUS.WAITING_PAUSED) {
    vals[1] = nowIso; // LastHeartbeat
  }
  if (status === STATUS.PONG)    vals[2] = nowIso; // LastPong
  if (status === STATUS.SUCCESS) vals[3] = nowIso; // LastUpload
  sheet.getRange(rowIdx, 3, 1, 7).setValues([vals]);
}

function doPost(e) {
  var sigErr = verifyWebhookSignature_(e);
  if (sigErr) {
    // Parse name for the log if we can (best-effort — body may be malformed)
    var rejName = 'unknown';
    try { rejName = JSON.parse(e.postData.contents).name || rejName; } catch (_) {}
    
    // Throttle signature rejection logging per developer to once every 10 minutes
    var cache = CacheService.getScriptCache();
    var cacheKey = 'log_sig_rej_' + rejName.replace(/\s+/g, '_') + '_' + sigErr.substring(0, 10).replace(/[^a-zA-Z0-9]/g, '');
    if (!cache.get(cacheKey)) {
      log_('doPost: signature rejected for "' + rejName + '" — ' + sigErr);
      cache.put(cacheKey, '1', 600); // 10 minutes cooldown
    }
    
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', error: 'invalid_signature', reason: sigErr }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // Note: No ScriptLock here — Sheet.appendRow() is atomic in GAS and safe under concurrency.
  // A ScriptLock would starve getDashboardData and other concurrent GAS executions.
  try {
    var payload = JSON.parse(e.postData.contents);
    var name            = payload.name            || 'UNKNOWN';
    var status          = payload.status          || 'UNKNOWN';
    var message         = payload.message         || '';
    var nextPollAt      = payload.nextPollAt      || '';
    var version         = payload.version         || '';
    var lastUpdateCheck = payload.lastUpdateCheck || '';

    var ss    = SpreadsheetApp.getActiveSpreadsheet();

    var isNoise = NOISE_STATUSES.indexOf(status) !== -1;

    // v3: noise pings (heartbeats, pause/idle pings, pongs) no longer append
    // log rows. They update the developer's RegisteredDevelopers row in-place,
    // which keeps the spreadsheet cell count flat. Repetitive keep-alive
    // statuses are throttled to one roster write per developer per 60s —
    // PONG is exempt because it answers an explicit admin Ping test and a
    // dropped PONG would read as "no response" on the dashboard.
    if (name && name !== 'UNKNOWN') {
      var throttleActive = false;
      if (isNoise && status !== STATUS.PONG) {
        var cache = CacheService.getScriptCache();
        var throttleKey = 'hb_throttle_' + name.trim().toLowerCase();
        if (cache.get(throttleKey)) {
          throttleActive = true;
        } else {
          cache.put(throttleKey, 'true', 60);
        }
      }
      if (!throttleActive) {
        upsertRosterActivity_(name, status, version, nextPollAt, lastUpdateCheck);
      }
    }

    if (!isNoise) {
      // Lifecycle + terminal events still append to ComplianceLog — the Queue
      // page (in-progress detection), progress rows, Smart Retry, compliance
      // grid and CSV export all derive from these rows.
      var sheet = ss.getSheetByName('ComplianceLog');
      if (!sheet) {
        sheet = ss.insertSheet('ComplianceLog');
        sheet.appendRow(['Timestamp', 'Developer Name', 'Week Start Date', 'Status', 'Error Message', 'NextPollAt', 'Version', 'LastUpdateCheck']);
        sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
      }
      var weekStart = getCurrentWeekStart_();
      sheet.appendRow([new Date(), name, weekStart, status, message, nextPollAt, version, lastUpdateCheck]);
      bumpLastModified_();
    } else {
      // Noise events do not update lastModified, avoiding frequent background client-side auto-refreshes.
    }

    // Smart Retry: whenever a developer is seen online (heartbeat/ping), check if they
    // have a failed upload this week and no trigger queued — if so, auto-queue one.
    // This is throttled by a 4-hour cooldown and a max of 3 retries per week per user.
    // We only fire this on HEARTBEAT/WAITING (the most frequent noise events) so it
    // runs in the background without adding latency to important lifecycle events.
    if ((status === 'HEARTBEAT' || status === 'WAITING') && name && name !== 'UNKNOWN') {
      var cache = CacheService.getScriptCache();
      var checkCacheKey = 'heavy_checks_cooldown_' + name.trim().toLowerCase();
      if (!cache.get(checkCacheKey)) {
        cache.put(checkCacheKey, '1', 180); // 3-minute cooldown
        try { checkAndTriggerSmartRetry_(name); } catch (retryErr) {
          log_('SmartRetry error for ' + name + ': ' + retryErr.message);
        }
        // v2: daily auto-generate — first heartbeat each day records firstSeen,
        // subsequent heartbeats after the 10-min stabilisation window queue a
        // FORCE_RUN (deduped per dev per day, paused/already-queued/already-uploaded skipped)
        try { maybeQueueDailyAutoGenerate_(name); } catch (autoErr) {
          log_('AutoDaily error for ' + name + ': ' + autoErr.message);
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ result: 'ok' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: 'error', error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}

function simulatePing(name, status, message) {
  requireAdmin_();
  var body = JSON.stringify({ name: name, status: status, message: message });
  var ts   = Math.floor(Date.now() / 1000).toString();
  var sig  = computeHmac256_(getWebhookSecret_(), ts + '.' + body);
  var e = {
    postData:  { contents: body },
    parameter: { _ts: ts, _sig: sig }
  };
  doPost(e);
  return { result: 'ok' };
}

// -------------------- PROGRESS STATUS (for live tracker) --------------------

// Read only the last maxRows rows from a sheet (bottom-N slice).
// Much faster than getDataRange() on sheets with thousands of rows.
function getRecentLogRows_(sheet, maxRows) {
  var last = sheet.getLastRow();
  if (last <= 1) return [];
  var start = Math.max(2, last - maxRows + 1);
  return sheet.getRange(start, 1, last - start + 1, sheet.getLastColumn()).getValues();
}

// Returns current pipeline state for a named developer.
// hasTrigger=true means a FORCE_RUN is still pending in the queue (not yet consumed).
// recentLogs is the last 15 entries so the client can derive the current phase.
// lastNextPollAt: most recent nextPollAt value received from the client.
function getDeveloperProgressStatus(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var nameLower = name.trim().toLowerCase();

  var hasTrigger = false;
  var tSheet = ss.getSheetByName('TriggerQueue');
  if (tSheet) {
    var tData = tSheet.getDataRange().getValues();
    for (var i = 1; i < tData.length; i++) {
      var rowName = String(tData[i][0]).trim().toLowerCase();
      var rowType = tData[i][3] ? String(tData[i][3]).trim() : 'FORCE_RUN';
      if (rowName === nameLower && rowType === 'FORCE_RUN') {
        hasTrigger = true;
        break;
      }
    }
  }

  var recentLogs = getDeveloperLogs(name, 15);

  // v3: nextPollAt comes from the roster's NextPollAt column (kept fresh by
  // doPost on every ping that carries one) — HeartbeatLog no longer exists.
  var lastNextPollAt = '';
  var regSheet = ss.getSheetByName('RegisteredDevelopers');
  if (regSheet) {
    var regData = regSheet.getDataRange().getValues();
    for (var j = 1; j < regData.length; j++) {
      if (String(regData[j][0]).trim().toLowerCase() === nameLower) {
        var np = regData[j][7];
        if (np && typeof np.getTime === 'function') np = np.toISOString();
        lastNextPollAt = np ? String(np).trim() : '';
        break;
      }
    }
  }

  return { hasTrigger: hasTrigger, recentLogs: recentLogs, lastNextPollAt: lastNextPollAt };
}

// Optimised batch version: opens each sheet ONCE for all names in a single pass.
// Previously called getDeveloperProgressStatus(n) per name, which opened 3 sheets each time.
function getDeveloperProgressStatusBatch(names) {
  if (!names || !names.length) return {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Build a lookup set of lowercase names for O(1) membership tests.
  var nameLowerMap = {}; // lowerName -> originalName
  names.forEach(function(n) { nameLowerMap[n.trim().toLowerCase()] = n; });

  // 1. Read TriggerQueue ONCE — find FORCE_RUN entries for any of our names.
  var triggerMap = {};
  var tSheet = ss.getSheetByName('TriggerQueue');
  if (tSheet) {
    var tData = tSheet.getDataRange().getValues();
    for (var i = 1; i < tData.length; i++) {
      var rName = String(tData[i][0] || '').trim().toLowerCase();
      if (!nameLowerMap[rName]) continue;
      var rType = tData[i][3] ? String(tData[i][3]).trim() : 'FORCE_RUN';
      if (rType === 'FORCE_RUN') triggerMap[rName] = true;
    }
  }

  // 2. Read the roster ONCE — NextPollAt column (col 8) per developer.
  var nextPollMap = {};
  var regSheet = ss.getSheetByName('RegisteredDevelopers');
  if (regSheet) {
    var regRows = regSheet.getDataRange().getValues();
    for (var j = 1; j < regRows.length; j++) {
      var rName = String(regRows[j][0] || '').trim().toLowerCase();
      if (!nameLowerMap[rName]) continue;
      var np = regRows[j][7];
      if (np && typeof np.getTime === 'function') np = np.toISOString();
      if (np) nextPollMap[rName] = String(np).trim();
    }
  }

  // 3. Read ComplianceLog ONCE — collect logs for all names.
  var recentLogsMap = {};
  names.forEach(function(n) { recentLogsMap[n.trim().toLowerCase()] = []; });

  function collectLogs(sheetName) {
    var logSheet = ss.getSheetByName(sheetName);
    if (!logSheet) return;
    var data = getRecentLogRows_(logSheet, 300);
    for (var k = 0; k < data.length; k++) {
      var row = data[k];
      if (!row[0]) continue;
      var rn = String(row[1] || '').trim().toLowerCase();
      if (!recentLogsMap.hasOwnProperty(rn)) continue;
      var ts = row[0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString(); else ts = String(ts);
      recentLogsMap[rn].push({
        timestamp: ts,
        status:    String(row[3] || '').trim().toUpperCase(),
        message:   String(row[4] || '')
      });
    }
  }
  collectLogs('ComplianceLog');

  // 4. Sort each developer's logs and build the result object.
  var result = {};
  names.forEach(function(n) {
    var nl = n.trim().toLowerCase();
    var logs = recentLogsMap[nl] || [];
    logs.sort(function(a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    result[n] = {
      hasTrigger:     !!triggerMap[nl],
      recentLogs:     logs.slice(0, 15),
      lastNextPollAt: nextPollMap[nl] || ''
    };
  });
  return result;
}

// Returns pending triggers + currently-in-progress pipelines for the Queue page.
function getQueuePageData() {
  requireAdmin_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Pending triggers (with notBefore for countdown display)
  var pending = adminGetTriggerQueue();

  // 2. In-progress runs: recent log entries showing active pipeline stages
  var pendingNames = {};
  pending.forEach(function(p) { pendingNames[p.name.toLowerCase()] = true; });
  var inProgress = getInProgressRuns_(ss, pendingNames);

  return { pending: pending, inProgress: inProgress };
}

// Scans the last 30 minutes of ComplianceLog for developers with an active pipeline
// (have GENERATE_START or UPLOAD_START but no terminal SUCCESS/FAILURE yet).
// excludeNames: object keyed by lowercase names to skip (already pending in TriggerQueue).
function getInProgressRuns_(ss, excludeNames) {
  var logSheet = ss.getSheetByName('ComplianceLog');
  if (!logSheet) return [];

  var rows = getRecentLogRows_(logSheet, 500);
  var cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
  var devState = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[0]) continue;
    var ts = row[0];
    if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
    else ts = String(ts);
    if (new Date(ts) < cutoff) continue;

    var name = String(row[1]).trim();
    var status = String(row[3]).trim().toUpperCase();
    var key = name.toLowerCase();
    if (excludeNames[key]) continue;

    if (!devState[key]) devState[key] = { name: name, terminal: false, active: false };
    if (status === 'SUCCESS' || status === 'FAILURE' || status === 'ERROR' || status === 'UPDATED') {
      devState[key].terminal = true;
    }
    if (status === 'GENERATE_START' || status === 'UPLOAD_START' || status === 'GENERATE_DONE' || status === 'UPDATE_START') {
      devState[key].active = true;
    }
  }

  var result = [];
  Object.keys(devState).forEach(function(key) {
    var d = devState[key];
    if (d.active && !d.terminal) {
      result.push(getDeveloperProgressStatus(d.name));
      result[result.length - 1].name = d.name;
    }
  });
  return result;
}

// -------------------- REGISTERED DEVELOPERS MANAGEMENT --------------------
// v3: the ExpectedDevelopers list (and its CRUD endpoints) was removed.
// Onboarding gaps are now surfaced by the dashboard's CSV Roster
// Reconciliation card, which compares an uploaded HR roster against
// RegisteredDevelopers client-side.

function getRegisteredDevelopersList() {
  requireAdmin_();
  ensureRegisteredDevelopersSheet();
  var data = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName('RegisteredDevelopers').getDataRange().getValues();
  return data.slice(1).filter(function(r){ return r[0]; }).map(function(r) {
    return { name: String(r[0]).trim(), registeredAt: r[1] ? String(r[1]).trim() : '' };
  });
}

function removeRegisteredDeveloper(name) {
  requireAdmin_();
  if (!name) return { success: false, error: 'Name is required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var found = false;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('RegisteredDevelopers');
    if (!sheet) return { success: false, error: 'Sheet not found' };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        found = true;
        break;
      }
    }
    if (!found) return { success: false, error: name + ' not found in RegisteredDevelopers' };

    // v3: a deleted developer must not linger in PausedDevelopers
    var pausedSheet = ss.getSheetByName('PausedDevelopers');
    if (pausedSheet) {
      var pData = pausedSheet.getDataRange().getValues();
      for (var pIdx = 1; pIdx < pData.length; pIdx++) {
        if (String(pData[pIdx][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
          pausedSheet.deleteRow(pIdx + 1);
          break;
        }
      }
    }
    invalidateCache_();
    log_('Removed registered developer: ' + name);
  } finally {
    lock.releaseLock();
  }
  // v3: outside the lock — trash their report files in the shared folder
  var deleted = deleteUploaderDriveFiles_(name);
  return { success: true, driveFilesDeleted: deleted };
}

function addRegisteredDeveloper(name) {
  requireAdmin_();
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  name = name.trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = ensureRegisteredDevelopersSheet();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.toLowerCase()) {
        return { success: false, error: name + ' is already registered' };
      }
    }
    sheet.appendRow([name, new Date().toISOString()]);
    invalidateCache_();
    log_('Admin manually registered: ' + name);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function log_(msg) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('AppLog');
    if (!sheet) { sheet = ss.insertSheet('AppLog'); sheet.appendRow(['Timestamp', 'Message']); }
    sheet.appendRow([new Date(), msg]);
  } catch (e) {
    // Silence logging errors
  }
}

// v3: HeartbeatLog no longer exists (noise pings update the roster
// in-place). Function name retained because the daily time-based trigger
// is installed against 'pruneHeartbeatLog' and survives redeploys.
function pruneHeartbeatLog() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    // 1. AppLog: max 1000 rows
    fastPruneLogSheet_(
      'AppLog',
      1000,
      ['Timestamp', 'Message']
    );

    // 2. ComplianceLog: max 5000 rows
    fastPruneLogSheet_(
      'ComplianceLog',
      5000,
      ['Timestamp', 'Developer Name', 'Week Start Date', 'Status', 'Error Message', 'NextPollAt', 'Version', 'LastUpdateCheck']
    );
  } catch(e) {
    log_('Prune error: ' + e.toString());
  } finally {
    lock.releaseLock();
  }
}

function fastPruneLogSheet_(sheetName, maxRows, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  
  var lastRow = sheet.getLastRow();
  if (lastRow <= maxRows + 100) return; // not enough rows to prune yet
  
  var keepRows = getRecentLogRows_(sheet, maxRows);
  
  // Clear the entire sheet (values and formatting)
  sheet.clear();
  
  // Write headers
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  
  // Write kept rows
  if (keepRows.length > 0) {
    var numCols = Math.min(headers.length, keepRows[0].length);
    var cleanKeepRows = keepRows.map(function(row) {
      return row.slice(0, numCols);
    });
    sheet.getRange(2, 1, cleanKeepRows.length, numCols).setValues(cleanKeepRows);
  }
  
  // Shrink the sheet to fit the data plus a small buffer of 50 empty rows
  var currentMaxRows = sheet.getMaxRows();
  var desiredRows = sheet.getLastRow() + 50;
  if (currentMaxRows > desiredRows) {
    sheet.deleteRows(desiredRows + 1, currentMaxRows - desiredRows);
  }
  
  log_('Fast-pruned ' + (lastRow - keepRows.length - 1) + ' rows from ' + sheetName);
}

function adminForcePrune() {
  requireAdmin_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, error: 'Could not get lock to prune' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      var s = sheets[i];
      var name = s.getName();
      // Delete excessive empty columns (anything beyond column 15)
      var maxCols = s.getMaxColumns();
      if (maxCols > 15) {
        s.deleteColumns(16, maxCols - 15);
      }
      
      // Prune rows if it's a log sheet
      if (name === 'AppLog') {
        var lr = s.getLastRow();
        if (lr > 1000) s.deleteRows(2, lr - 1000);
      } else if (name === 'ComplianceLog') {
        var lr = s.getLastRow();
        if (lr > 3000) s.deleteRows(2, lr - 3000);
      }
      
      // Delete excessive blank rows below data in ALL sheets
      var lr = s.getLastRow();
      var maxRows = s.getMaxRows();
      if (maxRows > lr && (maxRows - Math.max(lr, 1)) > 100) {
        // Keep a buffer of 100 empty rows, delete the rest
        s.deleteRows(Math.max(lr, 1) + 100, maxRows - Math.max(lr, 1) - 100);
      }
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

function installPruneTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i=0; i<triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'pruneHeartbeatLog') return;
  }
  ScriptApp.newTrigger('pruneHeartbeatLog').timeBased().everyDays(1).create();
}

// -------------------- AUTO-STALL ALERT (v2) --------------------
// Scheduled trigger that scans registered developers for stalled services
// (no heartbeat for ≥ stallHoursThreshold) and emails the admin once per
// stall cycle. Cycle = the contiguous staleness window; alerts are deduped
// per developer until they ping again, then a new cycle can fire.

function getStallThresholdHours_() {
  try {
    var v = parseInt(PropertiesService.getScriptProperties().getProperty('stall_threshold_hours') || '24', 10);
    if (isFinite(v) && v >= 1 && v <= 168) return v;
  } catch (e) {}
  return 24;
}

function setStallThresholdHours(hours) {
  requireAdmin_();
  var h = parseInt(hours, 10);
  if (!isFinite(h) || h < 1 || h > 168) return { success: false, error: 'hours must be between 1 and 168' };
  PropertiesService.getScriptProperties().setProperty('stall_threshold_hours', String(h));
  return { success: true, stallThresholdHours: h };
}

function runStallScan() {
  // Designed to be called both manually and from a time-driven trigger.
  // Public (no requireAdmin_) so the scheduler can run it.
  // v3: piggyback the hourly Drive sweep for paused developers' files.
  cleanupPausedDevelopersFiles();
  var threshold = getStallThresholdHours_();
  var thresholdMs = threshold * 3600 * 1000;
  var now = Date.now();
  var users = [];
  try { users = getActiveUsers_internal_(); } catch (e) {
    // Internal call must skip the admin gate.
    users = [];
  }
  var stalled = [];
  users.forEach(function(u) {
    if (!u.lastHeartbeat && !u.lastPong) return; // never pinged — handled by onboarding strip, not stall alert
    var keepAliveMs = 0;
    if (u.lastHeartbeat) keepAliveMs = Math.max(keepAliveMs, new Date(u.lastHeartbeat).getTime());
    if (u.lastPong)      keepAliveMs = Math.max(keepAliveMs, new Date(u.lastPong).getTime());
    if (!keepAliveMs) return;
    var age = now - keepAliveMs;
    if (age >= thresholdMs) stalled.push({ name: u.name, ageHours: Math.round(age / 3600000), lastSeen: new Date(keepAliveMs).toISOString() });
  });

  // Per-developer dedup — only alert once per stall cycle
  var props = PropertiesService.getScriptProperties();
  var alerted = {};
  try { alerted = JSON.parse(props.getProperty('stall_alerted') || '{}'); } catch (e) {}

  // Clear dedup entries for devs that are no longer stalled (so next stall fires)
  var stillStalledNames = {};
  stalled.forEach(function(s) { stillStalledNames[s.name] = true; });
  var newAlerted = {};
  Object.keys(alerted).forEach(function(n) { if (stillStalledNames[n]) newAlerted[n] = alerted[n]; });
  alerted = newAlerted;

  var newlyStalled = stalled.filter(function(s) { return !alerted[s.name]; });

  // Compose + send (one email, all newly-stalled devs)
  if (newlyStalled.length > 0) {
    var allowlist = getAdminAllowlist_();
    if (allowlist.length === 0) {
      log_('AutoStall: ' + newlyStalled.length + ' newly-stalled dev(s), but admin_emails is empty — skipping email');
    } else {
      var subject = '[Claude Usage] ' + newlyStalled.length + ' developer(s) stalled (>' + threshold + 'h)';
      var lines = ['The following developers have not heartbeated in the last ' + threshold + ' hour(s):', ''];
      newlyStalled.forEach(function(s) { lines.push('  • ' + s.name + ' — last seen ' + s.ageHours + 'h ago (' + s.lastSeen + ')'); });
      lines.push('');
      lines.push('Open the Compliance Dashboard → Queue tab to force-run, or check the developer\'s machine.');
      try {
        GmailApp.sendEmail(allowlist.join(','), subject, lines.join('\n'));
        newlyStalled.forEach(function(s) { alerted[s.name] = new Date().toISOString(); });
        log_('AutoStall: alerted on ' + newlyStalled.length + ' dev(s)');
      } catch (e) {
        log_('AutoStall: email send failed: ' + e.toString());
      }
    }
  }
  props.setProperty('stall_alerted', JSON.stringify(alerted));
  return {
    success: true,
    stalledCount: stalled.length,
    newlyAlerted: newlyStalled.length,
    stalled: stalled,
    thresholdHours: threshold
  };
}

// Internal getActiveUsers — same logic without the admin gate, so the
// scheduled stall scan can run without an active user session.
function getActiveUsers_internal_() {
  var oldRequireAdmin = requireAdmin_;
  // Temporarily replace with a no-op (safe — we restore in finally)
  requireAdmin_ = function() {};
  try {
    return getActiveUsers();
  } finally {
    requireAdmin_ = oldRequireAdmin;
  }
}

function installStallTrigger() {
  requireAdmin_();
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runStallScan') return { success: true, message: 'Already installed' };
  }
  ScriptApp.newTrigger('runStallScan').timeBased().everyHours(1).create();
  return { success: true, message: 'Stall scan trigger installed (hourly)' };
}

function uninstallStallTrigger() {
  requireAdmin_();
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runStallScan') {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }
  return { success: true, removed: removed };
}

function isStallTriggerInstalled() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'runStallScan') return true;
  }
  return false;
}

// v2: signature-rejection log (recent N entries) — surfaced on Health page.
// Reads AppLog rows starting with the prefix we use in doPost.
function getRecentSignatureRejections(limit) {
  requireAdmin_();
  limit = Math.min(limit || 50, 200);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('AppLog');
  if (!sheet) return [];
  var rows = getRecentLogRows_(sheet, 1000);
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    var msg = String(rows[i][1] || '');
    if (msg.indexOf('doPost: signature rejected') === 0) {
      var ts = rows[i][0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts);
      out.push({ timestamp: ts, message: msg });
    }
  }
  return out;
}

// v2: bulk cancel pending triggers by name. Used by the new bulk-select UI.
function adminCancelTriggerBatch(names) {
  requireAdmin_();
  if (!Array.isArray(names) || names.length === 0) return { success: false, error: 'No names provided' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TriggerQueue');
  if (!sheet) return { success: true, cancelled: 0 };
  var lr = sheet.getLastRow();
  if (lr <= 1) return { success: true, cancelled: 0 };
  var nameSet = {};
  names.forEach(function(n) { nameSet[String(n).trim().toLowerCase()] = true; });
  var data = sheet.getDataRange().getValues();
  var removed = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    var n = String(data[i][0] || '').trim().toLowerCase();
    if (nameSet[n]) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  invalidateCache_();
  return { success: true, cancelled: removed };
}

// -------------------- COMPLIANCE REMINDERS --------------------

function sendComplianceReminders(force) {
  requireAdmin_();
  var adminEmail = Session.getActiveUser().getEmail();
  if (!adminEmail) return { success: false, error: 'Could not determine admin email. Ensure the web app runs as "User accessing the web app".' };

  var data = getDashboardData_uncached_();
  var currentWeek = data.currentWeek || '';
  var weekData = (data.complianceByWeek && data.complianceByWeek[currentWeek]) ? data.complianceByWeek[currentWeek] : { details: [] };
  var details = weekData.details || [];

  var nonCompliant = details.filter(function(d) {
    return ['SUCCESS', 'REPORTED', 'COMPLIANT'].indexOf(d.status) === -1;
  });

  if (nonCompliant.length === 0) {
    return { success: true, message: 'All developers compliant for ' + currentWeek + '. No reminders needed.' };
  }

  // v2: throttle — at most one reminder per admin per week per current-week,
  // unless explicitly forced. Prevents accidental spam from repeated clicks.
  var throttleKey = 'reminderSent_' + currentWeek + '_' + adminEmail.toLowerCase();
  if (!force) {
    var props = PropertiesService.getScriptProperties();
    var lastSent = props.getProperty(throttleKey);
    if (lastSent) {
      var ageMins = Math.round((Date.now() - parseInt(lastSent, 10)) / 60000);
      return {
        success: false,
        throttled: true,
        sentAt: lastSent,
        message: 'A reminder for week ' + currentWeek + ' was already sent to ' + adminEmail + ' (' + ageMins + ' min ago). Use force=true to override.'
      };
    }
  }

  // Separate failures from pending
  var failed  = nonCompliant.filter(function(d) { return d.status === 'FAILURE' || d.status === 'ERROR'; });
  var pending = nonCompliant.filter(function(d) { return failed.indexOf(d) === -1; });

  var subject = '[Claude Usage] Non-compliant developers — ' + currentWeek;
  var lines = ['The following developers have not submitted Claude usage data for week ' + currentWeek + ':\n'];
  if (failed.length > 0) {
    lines.push('UPLOAD FAILED (' + failed.length + '):');
    failed.forEach(function(d) { lines.push('  • ' + d.name + ' — ' + (d.status || 'FAILURE')); });
    lines.push('');
  }
  if (pending.length > 0) {
    lines.push('PENDING / NOT YET UPLOADED (' + pending.length + '):');
    pending.forEach(function(d) { lines.push('  • ' + d.name); });
    lines.push('');
  }
  lines.push('You can trigger a force-run for any developer from the Compliance Dashboard.');
  lines.push('\nThis message was generated by the Claude Usage Uploader Dashboard.');

  GmailApp.sendEmail(adminEmail, subject, lines.join('\n'));
  // v2: record send timestamp so the per-week throttle works
  try {
    PropertiesService.getScriptProperties().setProperty(throttleKey, String(Date.now()));
  } catch (e) { /* throttle is best-effort */ }
  return { success: true, message: 'Reminder sent to ' + adminEmail + ' for ' + nonCompliant.length + ' non-compliant developer(s).' };
}

// -------------------- DRIVE FILE CLEANUP (v3) --------------------
// Uploaders write <Name_with_underscores>_claude_daily.json and
// _claude_session.json into this shared Drive folder (same ID as the
// uploader's DRIVE_FOLDER_ID). Pausing or deleting a developer trashes
// their files; an hourly sweep inside runStallScan() catches anything a
// paused uploader managed to re-upload before it saw paused=true.
// NOTE: the script's executing account needs Content Manager (or higher)
// on the shared drive — failures are logged, never thrown.
var SHARED_DRIVE_FOLDER_ID = '0AMXBcPT9R10cUk9PVA';

function uploaderFileNamesFor_(name) {
  var prefix = String(name || '').trim().replace(/\s+/g, '_');
  return [prefix + '_claude_daily.json', prefix + '_claude_session.json'];
}

function deleteUploaderDriveFiles_(name) {
  if (!name) return 0;
  var deletedCount = 0;
  try {
    var wanted = {};
    uploaderFileNamesFor_(name).forEach(function(f) { wanted[f] = true; });
    var folder = DriveApp.getFolderById(SHARED_DRIVE_FOLDER_ID);
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (file.isTrashed()) continue;
      if (wanted[file.getName()]) {
        file.setTrashed(true);
        deletedCount++;
      }
    }
    log_('DriveApp: deleted ' + deletedCount + ' file(s) for ' + name);
  } catch (e) {
    log_('DriveApp: error deleting files for ' + name + ': ' + e.toString());
  }
  return deletedCount;
}

// Hourly sweep (called from runStallScan): trash report files belonging to
// any currently-paused developer. Single folder iteration for all names.
function cleanupPausedDevelopersFiles() {
  try {
    var paused = getPausedDevelopersList();
    if (paused.length === 0) return;

    var wanted = {};
    paused.forEach(function(p) {
      uploaderFileNamesFor_(p.name).forEach(function(f) { wanted[f] = true; });
    });

    var folder = DriveApp.getFolderById(SHARED_DRIVE_FOLDER_ID);
    var files = folder.getFiles();
    var deletedCount = 0;
    while (files.hasNext()) {
      var file = files.next();
      if (file.isTrashed()) continue;
      if (wanted[file.getName()]) {
        file.setTrashed(true);
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      log_('DriveApp: auto-cleanup trashed ' + deletedCount + ' file(s) for paused developers');
    }
  } catch (e) {
    log_('DriveApp: auto-cleanup failed: ' + e.toString());
  }
}

// -------------------- PAUSE / RESUME --------------------

function isDeveloperPaused_(ss, name) {
  var sheet = ss.getSheetByName('PausedDevelopers');
  if (!sheet) return false;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
      return true;
    }
  }
  return false;
}

function getPausedDevelopersMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('PausedDevelopers');
  var map = {};
  if (!sheet) return map;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      var n = String(data[i][0]).trim().toLowerCase();
      var ts = data[i][1];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts || '');
      map[n] = { pausedAt: ts, pausedBy: String(data[i][2] || '') };
    }
  }
  return map;
}

function getPausedDevelopersList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('PausedDevelopers');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      var ts = data[i][1];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts || '');
      result.push({
        name: String(data[i][0]).trim(),
        pausedAt: ts,
        pausedBy: String(data[i][2] || '')
      });
    }
  }
  return result;
}

function adminPauseDeveloper(name) {
  requireAdmin_();
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  name = name.trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensurePausedDevelopersSheet_();
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.toLowerCase()) {
        return { success: false, error: name + ' is already paused' };
      }
    }

    var who = '';
    try { who = Session.getActiveUser().getEmail(); } catch (e) { who = 'admin'; }

    sheet.appendRow([name, new Date().toISOString(), who]);
    log_('PausedDevelopers: paused ' + name + ' by ' + who);
    invalidateCache_();
  } finally {
    lock.releaseLock();
  }
  // v3: outside the lock — Drive iteration is slow and must not starve
  // other executions waiting on the script lock.
  var deleted = deleteUploaderDriveFiles_(name);
  return { success: true, driveFilesDeleted: deleted };
}

function adminResumeDeveloper(name) {
  requireAdmin_();
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('PausedDevelopers');
    if (!sheet) return { success: false, error: name + ' is not paused' };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        log_('PausedDevelopers: resumed ' + name);
        invalidateCache_();
        return { success: true };
      }
    }
    return { success: false, error: name + ' is not paused' };
  } finally {
    lock.releaseLock();
  }
}

// -------------------- SETTINGS --------------------

// v2: schema version this code expects. Bump when ComplianceLog / HeartbeatLog
// / TriggerQueue / RegisteredDevelopers columns are added or changed. The
// `getSchemaInfo` endpoint surfaces this on the Health page.
var SHEET_SCHEMA_VERSION = 'v4.0';

function ensureSettingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Settings');
  if (!sheet) {
    sheet = ss.insertSheet('Settings');
    sheet.appendRow(['Key', 'Value']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.appendRow(['uploadFrequency', 'weekly']);
  }
  // v2: record the schema version on every doGet so a freshly cloned sheet
  // gets stamped automatically. Idempotent — only writes if missing/older.
  try {
    var data = sheet.getDataRange().getValues();
    var schemaRowIdx = -1;
    var currentVer = '';
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === 'schemaVersion') { schemaRowIdx = i + 1; currentVer = String(data[i][1]).trim(); break; }
    }
    if (schemaRowIdx === -1) {
      sheet.appendRow(['schemaVersion', SHEET_SCHEMA_VERSION]);
    } else if (currentVer !== SHEET_SCHEMA_VERSION) {
      sheet.getRange(schemaRowIdx, 2).setValue(SHEET_SCHEMA_VERSION);
    }
  } catch (e) { /* non-fatal */ }
  return sheet;
}

// v2: expose schema state to the dashboard Health page
function getSchemaInfo() {
  ensureSettingsSheet_();
  return {
    expectedVersion: SHEET_SCHEMA_VERSION,
    storedVersion: getSetting_('schemaVersion', ''),
    methodologyVersion: 'v2.0'
  };
}

function getSetting_(key, defaultVal) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Settings');
  if (!sheet) return defaultVal;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) return String(data[i][1]).trim();
  }
  return defaultVal;
}

function getUploadFrequency() {
  return getSetting_('uploadFrequency', 'weekly');
}

function normalizeUploadTime_(raw) {
  var text = String(raw == null ? '' : raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) {
    var bits = text.split(':');
    var hh = Math.max(0, Math.min(23, parseInt(bits[0], 10)));
    var mm = Math.max(0, Math.min(59, parseInt(bits[1], 10)));
    return ('0' + hh).slice(-2) + ':' + ('0' + mm).slice(-2);
  }
  var serial = Number(text);
  if (isFinite(serial) && serial >= 0 && serial < 1) {
    var total = Math.round(serial * 24 * 60) % (24 * 60);
    return ('0' + Math.floor(total / 60)).slice(-2) + ':' + ('0' + (total % 60)).slice(-2);
  }
  return '13:00';
}

function getUploadSchedule_() {
  var frequency = getSetting_('uploadFrequency', 'weekly');
  if (['daily', 'weekly', 'monthly'].indexOf(frequency) === -1) frequency = 'weekly';
  var day = getSetting_('globalUploadDay', 'Tuesday');
  var monthDay = parseInt(getSetting_('globalUploadMonthDay', '1'), 10);
  if (!isFinite(monthDay) || monthDay < 1 || monthDay > 31) monthDay = 1;
  return {
    frequency: frequency,
    time: normalizeUploadTime_(getSetting_('globalUploadTime', '13:00')),
    day: day,
    monthDay: monthDay,
    timeZone: Session.getScriptTimeZone() || 'Asia/Kolkata'
  };
}

function getUploadScheduleCached_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('upload_schedule_json');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var schedule = getUploadSchedule_();
  cache.put('upload_schedule_json', JSON.stringify(schedule), 300);
  return schedule;
}

function setSettingValue_(sheet, key, value) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function setUploadSchedule(schedule) {
  requireAdmin_();
  schedule = schedule || {};
  var frequency = String(schedule.frequency || '').trim();
  if (['daily', 'weekly', 'monthly'].indexOf(frequency) === -1) return { success: false, error: 'Invalid frequency' };
  var time = normalizeUploadTime_(schedule.time);
  var validDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var day = String(schedule.day || 'Tuesday');
  if (validDays.indexOf(day) === -1) return { success: false, error: 'Invalid weekly day' };
  var monthDay = parseInt(schedule.monthDay, 10) || 1;
  if (monthDay < 1 || monthDay > 31) return { success: false, error: 'Monthly day must be 1-31' };

  var sheet = ensureSettingsSheet_();
  setSettingValue_(sheet, 'uploadFrequency', frequency);
  setSettingValue_(sheet, 'globalUploadTime', time);
  setSettingValue_(sheet, 'globalUploadDay', day);
  setSettingValue_(sheet, 'globalUploadMonthDay', monthDay);
  invalidateCache_();
  log_('Settings: upload schedule set to ' + JSON.stringify(getUploadSchedule_()));
  return { success: true, schedule: getUploadSchedule_() };
}

function setUploadFrequency(freq) {
  requireAdmin_();
  var valid = ['daily', 'weekly', 'monthly'];
  if (valid.indexOf(freq) === -1) return { success: false, error: 'Invalid frequency. Must be daily, weekly, or monthly.' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSettingsSheet_();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === 'uploadFrequency') {
      sheet.getRange(i + 1, 2).setValue(freq);
      log_('Settings: uploadFrequency changed to ' + freq);
      invalidateCache_();
      return { success: true };
    }
  }
  sheet.appendRow(['uploadFrequency', freq]);
  log_('Settings: uploadFrequency set to ' + freq);
  invalidateCache_();
  return { success: true };
}

function forceSendUpdateTrigger(name) {
  requireAdmin_(); // v2: was unguarded — allowed any web-app caller to push UPDATE triggers
  if (!name) return { success: false, error: 'No name provided' };
  return adminQueueTrigger(name, 'UPDATE');
}

// v2: bulk-force-update — used by the Version Drift card to upgrade every
// developer whose reported version is behind the latest manifest.
function forceSendUpdateBatch(names) {
  requireAdmin_();
  if (!Array.isArray(names) || names.length === 0) return { success: false, error: 'No names provided' };
  var ok = 0, fail = 0, errors = [];
  names.forEach(function(n) {
    try {
      var r = adminQueueTrigger(n, 'UPDATE');
      if (r && r.success) ok++; else { fail++; errors.push(n + ': ' + (r && r.error || 'unknown')); }
    } catch (e) {
      fail++; errors.push(n + ': ' + e.toString());
    }
  });
  return { success: fail === 0, queued: ok, failed: fail, errors: errors };
}
