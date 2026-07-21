const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareVersions,
  uploadPeriodKey,
  isUploadDue,
  releaseBinaryName,
} = require('../claude-usage-uploader.js');

const base = { timeZone: 'Asia/Kolkata', time: '13:00' };

test('semantic version comparison handles patch upgrades', () => {
  assert.equal(compareVersions('2.0.4', '2.0.3'), 1);
  assert.equal(compareVersions('2.0.4', '2.0.4'), 0);
  assert.equal(compareVersions('1.9.3', '2.0.4'), -1);
});

test('daily schedule waits until configured local time and catches up yesterday', () => {
  const schedule = { ...base, frequency: 'daily' };
  assert.equal(uploadPeriodKey(new Date('2026-07-21T08:00:00Z'), schedule), 'daily:2026-07-21');
  assert.equal(uploadPeriodKey(new Date('2026-07-21T06:00:00Z'), schedule), 'daily:2026-07-20');
});

test('weekly schedule uses the most recent configured day and time', () => {
  const schedule = { ...base, frequency: 'weekly', day: 'Tuesday' };
  assert.equal(uploadPeriodKey(new Date('2026-07-21T08:00:00Z'), schedule), 'weekly:2026-07-21');
  assert.equal(uploadPeriodKey(new Date('2026-07-21T06:00:00Z'), schedule), 'weekly:2026-07-14');
  assert.equal(uploadPeriodKey(new Date('2026-07-23T08:00:00Z'), schedule), 'weekly:2026-07-21');
});

test('monthly schedule rolls to the previous month before its configured day', () => {
  const schedule = { ...base, frequency: 'monthly', monthDay: 15 };
  assert.equal(uploadPeriodKey(new Date('2026-07-21T08:00:00Z'), schedule), 'monthly:2026-07');
  assert.equal(uploadPeriodKey(new Date('2026-07-10T08:00:00Z'), schedule), 'monthly:2026-06');
});

test('due calculation compares explicit period keys without invalid Date parsing', () => {
  const now = new Date('2026-07-21T08:00:00Z');
  const schedule = { ...base, frequency: 'daily' };
  assert.equal(isUploadDue({ lastUploadPeriodKey: 'daily:2026-07-21' }, schedule, now), false);
  assert.equal(isUploadDue({ lastUploadPeriodKey: 'daily:2026-07-20' }, schedule, now), true);
  assert.equal(isUploadDue({ lastUploadDate: '2026-W30' }, schedule, now), true);
});

test('release names are versioned so Windows never overwrites a running executable', () => {
  assert.match(releaseBinaryName('2.0.4'), /^ClaudeUsageUploader_v2\.0\.4-/);
  assert.doesNotMatch(releaseBinaryName('2.0.4'), /^ClaudeUsageUploader\.exe$/);
});
