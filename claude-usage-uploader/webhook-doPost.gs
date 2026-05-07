// ================================================================
// Claude Usage Uploader — Webhook Receiver (Google Apps Script)
// ================================================================
// Deploy as: Web App → Execute as Me → Anyone can access
// Accepts POST with JSON body: { name, status, message }
// Logs to a "ComplianceLog" sheet in the bound spreadsheet.
// ================================================================

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var name    = payload.name    || 'UNKNOWN';
    var status  = payload.status  || 'UNKNOWN';   // Accepts ANY status: SUCCESS, FAILURE, REGISTERED, UPDATED, etc.
    var message = payload.message || '';

    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('ComplianceLog');
    if (!sheet) {
      sheet = ss.insertSheet('ComplianceLog');
      sheet.appendRow(['Timestamp', 'Developer Name', 'Week Start Date', 'Status', 'Error Message']);
      sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    }

    // Calculate the Monday of the current week
    var now   = new Date();
    var day   = now.getDay();                       // 0=Sun … 6=Sat
    var diff  = (day === 0) ? -6 : 1 - day;        // offset to Monday
    var monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    var weekStart = Utilities.formatDate(monday, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    sheet.appendRow([
      new Date(),       // Timestamp
      name,             // Developer Name
      weekStart,        // Week Start Date (always the current Monday)
      status,           // Status — any string is accepted
      message           // Error Message (blank when not applicable)
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
