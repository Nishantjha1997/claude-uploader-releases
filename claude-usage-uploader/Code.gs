// ================================================================
// Claude Usage Uploader — Compliance Dashboard (Google Apps Script)
// Code.gs (Server-side logic)
// ================================================================

// -------------------- WEBHOOK AUTH --------------------
var WEBHOOK_HMAC_SECRET = 'ss-uploader-hmac-2026-b7f3a9c1d4e2';
var HMAC_STALE_SECS = 7200;  // tolerate up to 2 hours of system clock drift

function computeHmac256_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  return raw.map(function(b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

// Returns '' on success, or a short reason string on failure.
function verifyWebhookSignature_(e) {
  var ts  = (e.parameter && e.parameter._ts)  ? e.parameter._ts  : '';
  var sig = (e.parameter && e.parameter._sig) ? e.parameter._sig : '';
  if (!ts || !sig) return 'missing_params';
  var now = Math.floor(Date.now() / 1000);
  var age = Math.abs(now - parseInt(ts, 10));
  if (age > HMAC_STALE_SECS) return 'stale_ts (' + age + 's, limit ' + HMAC_STALE_SECS + 's)';
  var body = (e.postData && e.postData.contents) ? e.postData.contents : '';
  var expected = computeHmac256_(WEBHOOK_HMAC_SECRET, ts + '.' + body);
  if (sig !== expected) return 'sig_mismatch';
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

// Status types considered "noise" — routed to HeartbeatLog instead of ComplianceLog.
var NOISE_STATUSES = [STATUS.HEARTBEAT, STATUS.WAITING, STATUS.PONG, STATUS.PAUSED, STATUS.WAITING_PAUSED];

// -------------------- ADMIN ACCESS CONTROL --------------------
// Add admin emails here. Empty array means "no allowlist" — anyone with web app access can mutate.
// Set this BEFORE deploying publicly.
var ADMIN_EMAILS = [
  // 'admin@example.com',
];

function requireAdmin_() {
  if (ADMIN_EMAILS.length === 0) return;  // allowlist disabled
  var email;
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  if (!email || ADMIN_EMAILS.indexOf(email) === -1) {
    throw new Error('Unauthorized: ' + (email || 'anonymous'));
  }
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
var INIT_VERSION = 'v2';
function maybeRunOneTimeInit_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('initDone') === INIT_VERSION) return; // already done
  ensureExpectedDevelopersSheet();
  ensureRegisteredDevelopersSheet();
  installPruneTrigger();
  cleanupSheets_();
  props.setProperty('initDone', INIT_VERSION);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// -------------------- SHEET HELPERS --------------------

var REQUIRED_SHEETS = [
  'ComplianceLog', 'HeartbeatLog', 'ExpectedDevelopers',
  'RegisteredDevelopers', 'PausedDevelopers', 'TriggerQueue',
  'AppLog', 'Settings'
];

function cleanupSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var all = ss.getSheets();
  var removed = 0;
  all.forEach(function(s) {
    if (REQUIRED_SHEETS.indexOf(s.getName()) === -1) {
      if (ss.getSheets().length > 1) {
        try { ss.deleteSheet(s); removed++; } catch(e) {}
      }
    }
  });
  if (removed > 0) { log_('Cleanup: removed ' + removed + ' unused sheet(s)'); invalidateCache_(); }
}

function ensureRegisteredDevelopersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('RegisteredDevelopers');
  if (!sheet) {
    sheet = ss.insertSheet('RegisteredDevelopers');
    sheet.appendRow(['Name', 'RegisteredAt']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
  }
  return sheet;
}

function ensureExpectedDevelopersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('ExpectedDevelopers');
  if (!sheet) {
    sheet = ss.insertSheet('ExpectedDevelopers');
    sheet.appendRow(['Name']);
    sheet.getRange(1, 1, 1, 1).setFontWeight('bold');
  }
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

function getCurrentWeekStart_() {
  var now = new Date();
  var day = now.getDay();
  var diff = (day === 0) ? -6 : 1 - day;
  var monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return Utilities.formatDate(monday, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getWeekHeaders_(n) {
  var headers = [];
  var curr = getCurrentWeekStart_();
  for (var i = 0; i < n; i++) {
    headers.push(curr);
    var d = new Date(curr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    curr = Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
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
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency };
  }

  // --- SAFE PATH (exclusive lock) ---
  // A row was spotted in cache; acquire the lock and re-read from the sheet before
  // mutating so concurrent requests cannot double-consume the same trigger entry.
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var qSheet = ss.getSheetByName('TriggerQueue');
  if (!qSheet) return { triggered: false, paused: paused, uploadFrequency: uploadFrequency };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    log_('checkAndClearTrigger: lock timeout for ' + name);
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency };
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
        return { triggered: true, type: triggerType, paused: paused, uploadFrequency: uploadFrequency };
      }
    }
    // Trigger was claimed by a concurrent request between the cache-check and lock acquisition.
    return { triggered: false, paused: paused, uploadFrequency: uploadFrequency };
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

  extractLogs('ComplianceLog');
  extractLogs('HeartbeatLog');

  // Sort by timestamp descending (newest first)
  logs.sort(function(a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  return logs.slice(0, limit);
}

// -------------------- ACTIVE USERS --------------------

// Derives per-developer activity from ComplianceLog.
// Returns array of { name, lastSeen, lastHeartbeat, lastUpload, lastPong, pendingTrigger }
function getActiveUsers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userMap = {};
  
  function processSheet(sheetName, boundedRecent) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    var maxRows = boundedRecent ? 500 : 1500;
    var data = getRecentLogRows_(sheet, maxRows);
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      if (!row[0]) continue;

      var ts = row[0];
      if (ts && typeof ts.getTime === 'function') ts = ts.toISOString();
      else ts = String(ts);

      var name = String(row[1]).trim();
      var status = String(row[3]).trim().toUpperCase();

      if (!name) continue;
      if (!userMap[name]) userMap[name] = {
        name: name,
        lastSeen: null,
        lastHeartbeat: null,
        lastUpload: null,
        lastPong: null,
        lastSuccessNextPoll: null,
        version: null,
        lastUpdateCheck: null
      };

      var u = userMap[name];
      var isNewer = !u.lastSeen || new Date(ts) > new Date(u.lastSeen);
      if (isNewer) u.lastSeen = ts;

      if (status === 'HEARTBEAT' || status === 'WAITING' || status === 'POLLING_ACK' || status === 'PAUSED' || status === 'WAITING_PAUSED') {
        if (!u.lastHeartbeat || new Date(ts) > new Date(u.lastHeartbeat)) u.lastHeartbeat = ts;
      }
      if (status === 'SUCCESS') {
        if (!u.lastUpload || new Date(ts) > new Date(u.lastUpload)) {
          u.lastUpload = ts;
          u.lastSuccessNextPoll = row[5] ? String(row[5]).trim() : ''; // For summary dashboard
        }
      }
      if (status === 'PONG') {
        if (!u.lastPong || new Date(ts) > new Date(u.lastPong)) u.lastPong = ts;
      }

      // Track version and last update check (columns 7 and 8)
      var rowVersion = row[6] ? String(row[6]).trim() : '';
      var rowUpdateCheck = row[7] ? String(row[7]).trim() : '';
      if (rowVersion && (!u.version || isNewer)) {
        u.version = rowVersion;
      }
      if (rowUpdateCheck && rowUpdateCheck !== 'never' && (!u.lastUpdateCheck || isNewer)) {
        u.lastUpdateCheck = rowUpdateCheck;
      }
    }
  }

  processSheet('ComplianceLog', false);
  processSheet('HeartbeatLog', true);

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

  return Object.values(userMap).map(function(u) {
    var key = u.name.toLowerCase();
    u.pendingTrigger = !!(triggerMap[key] && triggerMap[key]['FORCE_RUN']);
    u.pendingPing    = !!(triggerMap[key] && triggerMap[key]['PING']);
    u.paused         = !!pausedMap[key];
    u.pausedAt       = pausedMap[key] ? pausedMap[key].pausedAt : null;
    u.pausedBy       = pausedMap[key] ? pausedMap[key].pausedBy : null;
    return u;
  }).sort(function(a, b) {
    if (!a.lastSeen) return 1;
    if (!b.lastSeen) return -1;
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });
}

// -------------------- DASHBOARD DATA --------------------

function invalidateCache_() {
  var c = CacheService.getScriptCache();
  chunkedCacheRemove(c, 'dashboardData');
  c.remove('pausedSet');
  c.remove('triggerQueueRows');
  c.remove('setting_uploadFrequency');
  c.put('lastModified', String(Date.now()), 3600);
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

  // 1. Expected Developers (pending onboarding — haven't registered yet)
  var expectedSheet = ss.getSheetByName('ExpectedDevelopers');
  var expectedData = expectedSheet ? expectedSheet.getDataRange().getValues() : [];
  var expectedDevelopers = [];
  for (var i = 1; i < expectedData.length; i++) {
    if (expectedData[i][0]) expectedDevelopers.push(String(expectedData[i][0]).trim());
  }

  // 1b. Registered Developers (active — compliance is tracked against this list)
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
    var logData = getRecentLogRows_(logSheet, 3000);
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
    expectedDevelopers: expectedDevelopers,
    registeredDevelopers: registeredDevelopers,
    weeks: weeks,
    complianceByWeek: complianceByWeek,
    activeUsers: activeUsers,
    triggerQueue: triggerQueue,
    currentWeek: getCurrentWeekStart_(),
    pausedDevelopers: pausedDevelopers,
    uploadFrequency: getSetting_('uploadFrequency', 'weekly'),
    complianceGrid: complianceGrid,
    recentUploads: recentUploads,
    weekHeaders: weekHeaders
  };
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

// -------------------- WEBHOOK (POST) --------------------

function doPost(e) {
  var sigErr = verifyWebhookSignature_(e);
  if (sigErr) {
    // Parse name for the log if we can (best-effort — body may be malformed)
    var rejName = 'unknown';
    try { rejName = JSON.parse(e.postData.contents).name || rejName; } catch (_) {}
    log_('doPost: signature rejected for "' + rejName + '" — ' + sigErr);
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

    // On first ping: add to RegisteredDevelopers; remove from ExpectedDevelopers if present.
    if (name && name !== 'UNKNOWN') {
      var cache = CacheService.getScriptCache();
      var regCacheKey = 'regDevs_' + name.trim().toLowerCase();
      var alreadyRegistered = cache.get(regCacheKey);
      
      if (!alreadyRegistered) {
        var regSheet = ensureRegisteredDevelopersSheet();
        var regData = regSheet.getDataRange().getValues();
        for (var ri = 1; ri < regData.length; ri++) {
          if (String(regData[ri][0]).trim().toLowerCase() === name.trim().toLowerCase()) { alreadyRegistered = true; break; }
        }
        if (alreadyRegistered) {
          cache.put(regCacheKey, 'true', 3600);
        } else {
          regSheet.appendRow([name.trim(), new Date().toISOString()]);
          cache.put(regCacheKey, 'true', 3600);
          log_('Registered new developer: ' + name);
          // Remove from ExpectedDevelopers if present
          var expSheet2 = ss.getSheetByName('ExpectedDevelopers');
          if (expSheet2) {
            var expData2 = expSheet2.getDataRange().getValues();
            for (var ei2 = expData2.length - 1; ei2 >= 1; ei2--) {
              if (String(expData2[ei2][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
                expSheet2.deleteRow(ei2 + 1);
                log_('Moved ' + name + ' from Expected to Registered');
                break;
              }
            }
          }
          invalidateCache_();
        }
      }
    }

    var isNoise = NOISE_STATUSES.indexOf(status) !== -1;
    var sheetName = isNoise ? 'HeartbeatLog' : 'ComplianceLog';
    var sheet = ss.getSheetByName(sheetName);
    
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['Timestamp', 'Developer Name', 'Week Start Date', 'Status', 'Error Message', 'NextPollAt', 'Version', 'LastUpdateCheck']);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    } else {
      var cache = CacheService.getScriptCache();
      var upgradeCacheKey = 'sheetUpgraded_' + sheetName;
      var upgraded = cache.get(upgradeCacheKey);
      if (!upgraded) {
        var lastCol = sheet.getLastColumn();
        if (lastCol < 6) { sheet.getRange(1, 6).setValue('NextPollAt').setFontWeight('bold'); }
        if (lastCol < 7) { sheet.getRange(1, 7).setValue('Version').setFontWeight('bold'); }
        if (lastCol < 8) { sheet.getRange(1, 8).setValue('LastUpdateCheck').setFontWeight('bold'); }
        cache.put(upgradeCacheKey, 'true', 21600);
      }
    }

    var weekStart = getCurrentWeekStart_();

    sheet.appendRow([new Date(), name, weekStart, status, message, nextPollAt, version, lastUpdateCheck]);
    if (!isNoise) {
      invalidateCache_();
    }

    // Smart Retry: whenever a developer is seen online (heartbeat/ping), check if they
    // have a failed upload this week and no trigger queued — if so, auto-queue one.
    // This is throttled by a 4-hour cooldown and a max of 3 retries per week per user.
    // We only fire this on HEARTBEAT/WAITING (the most frequent noise events) so it
    // runs in the background without adding latency to important lifecycle events.
    if ((status === 'HEARTBEAT' || status === 'WAITING') && name && name !== 'UNKNOWN') {
      try { checkAndTriggerSmartRetry_(name); } catch (retryErr) {
        log_('SmartRetry error for ' + name + ': ' + retryErr.message);
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
  var sig  = computeHmac256_(WEBHOOK_HMAC_SECRET, ts + '.' + body);
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

  // Find the most recent nextPollAt stamp — scan only recent HeartbeatLog rows
  var lastNextPollAt = '';
  var hbSheet = ss.getSheetByName('HeartbeatLog');
  if (hbSheet) {
    var hbRows = getRecentLogRows_(hbSheet, 200);
    for (var j = hbRows.length - 1; j >= 0; j--) {
      var rowStatus = String(hbRows[j][3]).trim().toUpperCase();
      if ((rowStatus === 'WAITING' || rowStatus === 'POLLING_ACK' || rowStatus === 'PONG')
          && String(hbRows[j][1]).trim().toLowerCase() === nameLower) {
        var np = hbRows[j][5] ? String(hbRows[j][5]).trim() : '';
        if (np) { lastNextPollAt = np; break; }
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

  // 2. Read HeartbeatLog ONCE — find last nextPollAt per developer.
  var nextPollMap = {};
  var hbSheet = ss.getSheetByName('HeartbeatLog');
  if (hbSheet) {
    var hbRows = getRecentLogRows_(hbSheet, 300);
    for (var j = hbRows.length - 1; j >= 0; j--) {
      var hbName = String(hbRows[j][1] || '').trim().toLowerCase();
      if (!nameLowerMap[hbName] || nextPollMap[hbName]) continue;
      var hbStatus = String(hbRows[j][3] || '').trim().toUpperCase();
      if ((hbStatus === 'WAITING' || hbStatus === 'POLLING_ACK' || hbStatus === 'PONG') && hbRows[j][5]) {
        nextPollMap[hbName] = String(hbRows[j][5]).trim();
      }
    }
  }

  // 3. Read ComplianceLog + HeartbeatLog ONCE each — collect logs for all names.
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
  collectLogs('HeartbeatLog');

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

// -------------------- EXPECTED DEVELOPERS MANAGEMENT --------------------

function getExpectedDevelopersList() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureExpectedDevelopersSheet();
  var sheet = ss.getSheetByName('ExpectedDevelopers');
  var data = sheet.getDataRange().getValues();
  var result = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) result.push(String(data[i][0]).trim());
  }
  return result;
}

function addExpectedDeveloper(name) {
  requireAdmin_();
  if (!name || !name.trim()) return { success: false, error: 'Name is required' };
  name = name.trim();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureExpectedDevelopersSheet();
    var sheet = ss.getSheetByName('ExpectedDevelopers');
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.toLowerCase()) {
        return { success: false, error: name + ' is already in the list' };
      }
    }
    sheet.appendRow([name]);
    invalidateCache_();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function removeExpectedDeveloper(name) {
  requireAdmin_();
  if (!name) return { success: false, error: 'Name is required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ExpectedDevelopers');
    if (!sheet) return { success: false, error: 'Sheet not found' };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        invalidateCache_();
        return { success: true };
      }
    }
    return { success: false, error: name + ' not found' };
  } finally {
    lock.releaseLock();
  }
}

// Bulk-add all active developers (anyone who has ever sent a ping) to ExpectedDevelopers.
// Useful for seeding the roster from historical log data. Returns { added: [] }.
function adminSyncActiveToExpected() {
  requireAdmin_();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    ensureExpectedDevelopersSheet();
    var expSheet = ss.getSheetByName('ExpectedDevelopers');
    var expData = expSheet.getDataRange().getValues();
    var existing = {};
    for (var i = 1; i < expData.length; i++) {
      if (expData[i][0]) existing[String(expData[i][0]).trim().toLowerCase()] = true;
    }
    var added = [];
    getActiveUsers().forEach(function(u) {
      if (!u.name) return;
      var key = u.name.trim().toLowerCase();
      if (!existing[key]) {
        expSheet.appendRow([u.name.trim()]);
        existing[key] = true;
        added.push(u.name.trim());
      }
    });
    if (added.length > 0) {
      log_('adminSyncActiveToExpected: added ' + added.length + ' developer(s): ' + added.join(', '));
      invalidateCache_();
    }
    return { added: added };
  } finally {
    lock.releaseLock();
  }
}

// -------------------- REGISTERED DEVELOPERS MANAGEMENT --------------------

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
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('RegisteredDevelopers');
    if (!sheet) return { success: false, error: 'Sheet not found' };
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        sheet.deleteRow(i + 1);
        invalidateCache_();
        log_('Removed registered developer: ' + name);
        return { success: true };
      }
    }
    return { success: false, error: name + ' not found in RegisteredDevelopers' };
  } finally {
    lock.releaseLock();
  }
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

function pruneHeartbeatLog() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. HeartbeatLog: max 2000 rows
    var hbSheet = ss.getSheetByName('HeartbeatLog');
    if (hbSheet) {
      var maxHB = 2000;
      var lastHB = hbSheet.getLastRow();
      if (lastHB > maxHB + 500) {
        var numToDelete = lastHB - maxHB;
        hbSheet.deleteRows(2, numToDelete);
        log_('Pruned ' + numToDelete + ' rows from HeartbeatLog');
      }
    }
    
    // 2. AppLog: max 1000 rows
    var appSheet = ss.getSheetByName('AppLog');
    if (appSheet) {
      var maxApp = 1000;
      var lastApp = appSheet.getLastRow();
      if (lastApp > maxApp + 200) {
        var numToDelete = lastApp - maxApp;
        appSheet.deleteRows(2, numToDelete);
        log_('Pruned ' + numToDelete + ' rows from AppLog');
      }
    }
    
    // 3. ComplianceLog: max 5000 rows (covers ~1 year of compliance history)
    var compSheet = ss.getSheetByName('ComplianceLog');
    if (compSheet) {
      var maxComp = 5000;
      var lastComp = compSheet.getLastRow();
      if (lastComp > maxComp + 1000) {
        var numToDelete = lastComp - maxComp;
        compSheet.deleteRows(2, numToDelete);
        log_('Pruned ' + numToDelete + ' rows from ComplianceLog');
      }
    }
  } catch(e) {
    log_('Prune error: ' + e.toString());
  } finally {
    lock.releaseLock();
  }
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
      if (name === 'HeartbeatLog') {
        var lr = s.getLastRow();
        if (lr > 2000) s.deleteRows(2, lr - 2000);
      } else if (name === 'AppLog') {
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

// -------------------- COMPLIANCE REMINDERS --------------------

function sendComplianceReminders() {
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
  return { success: true, message: 'Reminder sent to ' + adminEmail + ' for ' + nonCompliant.length + ' non-compliant developer(s).' };
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
    return { success: true };
  } finally {
    lock.releaseLock();
  }
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

function ensureSettingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Settings');
  if (!sheet) {
    sheet = ss.insertSheet('Settings');
    sheet.appendRow(['Key', 'Value']);
    sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
    sheet.appendRow(['uploadFrequency', 'weekly']);
  }
  return sheet;
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
  if (!name) return { success: false, error: 'No name provided' };
  return adminQueueTrigger(name, 'UPDATE');
}
