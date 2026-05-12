// ================================================================
// Claude Usage Uploader — Compliance Dashboard (Google Apps Script)
// Code.gs (Server-side logic)
// ================================================================

// -------------------- WEBHOOK AUTH --------------------
var WEBHOOK_HMAC_SECRET = 'ss-uploader-hmac-2026-b7f3a9c1d4e2';
var HMAC_STALE_SECS = 300;  // reject requests older than 5 minutes

function computeHmac256_(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  return raw.map(function(b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

function verifyWebhookSignature_(e) {
  var ts  = (e.parameter && e.parameter._ts)  ? e.parameter._ts  : '';
  var sig = (e.parameter && e.parameter._sig) ? e.parameter._sig : '';
  if (!ts || !sig) return false;
  var now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > HMAC_STALE_SECS) return false;
  var body = (e.postData && e.postData.contents) ? e.postData.contents : '';
  var expected = computeHmac256_(WEBHOOK_HMAC_SECRET, ts + '.' + body);
  return sig === expected;
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
var NOISE_STATUSES = [STATUS.HEARTBEAT, STATUS.WAITING, STATUS.PONG, STATUS.POLLING_ACK, STATUS.PAUSED, STATUS.WAITING_PAUSED];

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

  ensureExpectedDevelopersSheet();
  return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('Compliance Dashboard')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// -------------------- SHEET HELPERS --------------------

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

function ensureTriggerQueue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('TriggerQueue');
  if (!sheet) {
    sheet = ss.insertSheet('TriggerQueue');
    sheet.appendRow(['Name', 'QueuedAt', 'QueuedBy', 'Type']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  } else {
    // Upgrade: add Type column if missing
    var lastCol = sheet.getLastColumn();
    if (lastCol < 4) {
      sheet.getRange(1, 4).setValue('Type');
      sheet.getRange(1, 4).setFontWeight('bold');
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

    sheet.appendRow([name.trim(), new Date().toISOString(), who, type]);
    log_('TriggerQueue: queued ' + type + ' for ' + name + ' by ' + who);
    invalidateCache_();
    return { success: true };
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

    sheet.appendRow([name.trim(), new Date().toISOString(), who, 'PING']);
    log_('TriggerQueue: queued PING for ' + name + ' by ' + who);
    invalidateCache_();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function checkAndClearTrigger(name) {
  if (!name) return { triggered: false, paused: false };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    log_('checkAndClearTrigger: lock timeout for ' + name);
    return { triggered: false, paused: false };
  }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Check pause state
    var paused = isDeveloperPaused_(ss, name);
    var uploadFrequency = getSetting_('uploadFrequency', 'weekly');

    var base = { paused: paused, uploadFrequency: uploadFrequency };

    var sheet = ss.getSheetByName('TriggerQueue');
    if (!sheet) return { triggered: false, paused: paused, uploadFrequency: uploadFrequency };

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) {
        var triggerType = data[i][3] ? String(data[i][3]).trim() : 'FORCE_RUN';
        sheet.deleteRow(i + 1);
        log_('TriggerQueue: consumed ' + triggerType + ' for ' + name);
        return { triggered: true, type: triggerType, paused: paused, uploadFrequency: uploadFrequency };
      }
    }
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
        type: data[i][3] ? String(data[i][3]).trim() : 'FORCE_RUN'
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

// -------------------- DEVELOPER LOGS --------------------

// Returns the last `limit` log entries for a specific developer, newest first.
function getDeveloperLogs(name, limit) {
  limit = limit || 25;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var logs = [];
  
  function extractLogs(sheetName) {
    var logSheet = ss.getSheetByName(sheetName);
    if (!logSheet) return;
    var data = logSheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
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
    var data = sheet.getDataRange().getValues();
    var startIndex = 1;
    if (boundedRecent && data.length > 500) {
      startIndex = data.length - 500;
    }
    for (var i = startIndex; i < data.length; i++) {
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
      if (!u.lastSeen || new Date(ts) > new Date(u.lastSeen)) u.lastSeen = ts;

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
      if (rowVersion && (!u.version || new Date(ts) > new Date(u.lastSeen || 0))) {
        u.version = rowVersion;
      }
      if (rowUpdateCheck && rowUpdateCheck !== 'never' && (!u.lastUpdateCheck || new Date(ts) > new Date(u.lastSeen || 0))) {
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
  CacheService.getScriptCache().remove('dashboardData');
}

function getDashboardData() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('dashboardData');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }
  var data = getDashboardData_uncached_();
  try {
    cache.put('dashboardData', JSON.stringify(data), 300); // 5 mins
  } catch(e) {
    // Data too large for cache — skip caching, return fresh each time
    log_('Cache skip: data too large (' + e.message + ')');
  }
  return data;
}

function getDashboardData_uncached_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Expected Developers
  var expectedSheet = ss.getSheetByName('ExpectedDevelopers');
  var expectedData = expectedSheet ? expectedSheet.getDataRange().getValues() : [];
  var expectedDevelopers = [];
  for (var i = 1; i < expectedData.length; i++) {
    if (expectedData[i][0]) expectedDevelopers.push(String(expectedData[i][0]).trim());
  }

  // 2. Compliance Logs — read all but only keep recent weeks to stay under size limit
  var logSheet = ss.getSheetByName('ComplianceLog');
  var allLogs = [];
  var registeredMap = {};
  if (logSheet) {
    var logData = logSheet.getDataRange().getValues();
    for (var i = 1; i < logData.length; i++) {
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

      // Track registered developers across ALL logs (not just recent)
      if (status === 'REGISTERED') {
        if (!registeredMap[name] || new Date(ts) < new Date(registeredMap[name])) {
          registeredMap[name] = ts;
        }
      }
    }
  }

  // 3. Distinct weeks (newest first) — keep only most recent 8 weeks for dashboard
  var weeksMap = {};
  allLogs.forEach(function(log) { if (log.weekStart) weeksMap[log.weekStart] = true; });
  var weeks = Object.keys(weeksMap).sort().reverse().slice(0, 8);
  var recentWeeksSet = {};
  weeks.forEach(function(w) { recentWeeksSet[w] = true; });

  // 4. Calculate complianceByWeek on the server to avoid sending all logs
  var complianceByWeek = {};
  weeks.forEach(function(w) {
    complianceByWeek[w] = { expected: 0, reported: 0, failed: 0, pending: 0, details: [] };
    var devStatus = {};
    expectedDevelopers.forEach(function(n) { devStatus[n] = null; });
    
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

  // 5. Registered developers
  var registeredDevelopers = Object.keys(registeredMap).map(function(name) {
    return { name: name, date: registeredMap[name] };
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
    uploadFrequency: getSetting_('uploadFrequency', 'weekly')
  };
}

// -------------------- WEBHOOK (POST) --------------------

function doPost(e) {
  if (!verifyWebhookSignature_(e)) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', error: 'invalid_signature' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
    var sheetName = isNoise ? 'HeartbeatLog' : 'ComplianceLog';
    var sheet = ss.getSheetByName(sheetName);
    
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['Timestamp', 'Developer Name', 'Week Start Date', 'Status', 'Error Message', 'NextPollAt', 'Version', 'LastUpdateCheck']);
      sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    } else {
      // Auto-upgrade existing sheets to add new columns
      var lastCol = sheet.getLastColumn();
      if (lastCol < 6) {
        sheet.getRange(1, 6).setValue('NextPollAt').setFontWeight('bold');
      }
      if (lastCol < 7) {
        sheet.getRange(1, 7).setValue('Version').setFontWeight('bold');
      }
      if (lastCol < 8) {
        sheet.getRange(1, 8).setValue('LastUpdateCheck').setFontWeight('bold');
      }
    }

    var weekStart = getCurrentWeekStart_();

    sheet.appendRow([new Date(), name, weekStart, status, message, nextPollAt, version, lastUpdateCheck]);
    invalidateCache_();

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

// Returns current pipeline state for a named developer.
// hasTrigger=true means a FORCE_RUN is still pending in the queue (not yet consumed).
// recentLogs is the last 15 entries so the client can derive the current phase.
// lastNextPollAt: most recent nextPollAt value received from the client.
function getDeveloperProgressStatus(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var hasTrigger = false;
  var tSheet = ss.getSheetByName('TriggerQueue');
  if (tSheet) {
    var tData = tSheet.getDataRange().getValues();
    for (var i = 1; i < tData.length; i++) {
      var rowName = String(tData[i][0]).trim().toLowerCase();
      var rowType = tData[i][3] ? String(tData[i][3]).trim() : 'FORCE_RUN';
      if (rowName === name.trim().toLowerCase() && rowType === 'FORCE_RUN') {
        hasTrigger = true;
        break;
      }
    }
  }

  var recentLogs = getDeveloperLogs(name, 15);

  // Find the most recent nextPollAt stamp from WAITING, POLLING_ACK or PONG entries
  var lastNextPollAt = '';
  var hbSheet = ss.getSheetByName('HeartbeatLog');
  if (hbSheet) {
    var data = hbSheet.getDataRange().getValues();
    for (var j = data.length - 1; j >= 1; j--) {
      var rowStatus = String(data[j][3]).trim().toUpperCase();
      if ((rowStatus === 'WAITING' || rowStatus === 'POLLING_ACK' || rowStatus === 'PONG')
          && String(data[j][1]).trim().toLowerCase() === name.trim().toLowerCase()) {
        var np = data[j][5] ? String(data[j][5]).trim() : '';
        if (np) { lastNextPollAt = np; break; }
      }
    }
  }

  return { hasTrigger: hasTrigger, recentLogs: recentLogs, lastNextPollAt: lastNextPollAt };
}

function getDeveloperProgressStatusBatch(names) {
  if (!names || !names.length) return {};
  var result = {};
  names.forEach(function(n) {
    result[n] = getDeveloperProgressStatus(n);
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
    var sheet = ss.getSheetByName('HeartbeatLog');
    if (!sheet) return;
    var maxRows = 2000;
    var lastRow = sheet.getLastRow();
    if (lastRow > maxRows + 500) {
      var numToDelete = lastRow - maxRows;
      sheet.deleteRows(2, numToDelete);
      log_('Pruned ' + numToDelete + ' rows from HeartbeatLog');
    }
  } catch(e) {
    log_('Prune error: ' + e.toString());
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
