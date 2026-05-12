// Manual scratch tests for isoWeekKey / isUploadDue.
// Run: node claude-usage-uploader/test/test-iso-week.js
// All lines should print PASS.

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: got "${actual}" expected "${expected}"`);
  if (!ok) process.exitCode = 1;
}

// Standard cases
check('2026-01-01 (Thu) → W01',      isoWeekKey(new Date('2026-01-01T12:00:00Z')), '2026-W01');
check('2026-01-05 (Mon) → W02',      isoWeekKey(new Date('2026-01-05T12:00:00Z')), '2026-W02');
check('2026-12-28 (Mon) → W53',      isoWeekKey(new Date('2026-12-28T12:00:00Z')), '2026-W53');

// Year-boundary: Dec 29 2025 (Mon) belongs to 2026-W01
check('2025-12-29 (Mon) → 2026-W01', isoWeekKey(new Date('2025-12-29T12:00:00Z')), '2026-W01');
check('2025-12-28 (Sun) → 2025-W52', isoWeekKey(new Date('2025-12-28T12:00:00Z')), '2025-W52');

// Year-boundary: Dec 31 2024 (Tue) belongs to 2025-W01
check('2024-12-31 (Tue) → 2025-W01', isoWeekKey(new Date('2024-12-31T12:00:00Z')), '2025-W01');

// DST boundary (US spring-forward 2026-03-08 02:00 local — UTC is unaffected)
check('2026-03-08 01:59 UTC → W10',  isoWeekKey(new Date('2026-03-08T01:59:00Z')), '2026-W10');
check('2026-03-08 03:00 UTC → W10',  isoWeekKey(new Date('2026-03-08T03:00:00Z')), '2026-W10');

// Legacy YYYY-MM-DD migration check (simulates isUploadDue legacy path)
function legacyToWeekKey(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? isoWeekKey(new Date(s)) : s;
}
check('legacy 2026-04-27 → 2026-W18', legacyToWeekKey('2026-04-27'), '2026-W18');
check('legacy 2026-01-05 → 2026-W02', legacyToWeekKey('2026-01-05'), '2026-W02');
check('key passthrough 2026-W19',      legacyToWeekKey('2026-W19'),  '2026-W19');

console.log('\nDone.');
