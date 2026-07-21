const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGas() {
  const cache = new Map();
  const sandbox = {
    console, JSON, Date, Math, String, Number, Object, Array, RegExp,
    parseInt, isFinite,
    Utilities: {
      computeHmacSha256Signature(message, secret) {
        return [...crypto.createHmac('sha256', secret).update(message).digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => key === 'hmac_secret' ? sandbox.hmacOverride : null,
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: key => cache.get(key) || null,
        put: (key, value) => cache.set(key, value),
        remove: key => cache.delete(key),
      }),
    },
  };
  sandbox.hmacOverride = '';
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);
  sandbox.log_ = () => {};
  sandbox.__cache = cache;
  return sandbox;
}

function signedEvent(secret, body, tsOffset = 0) {
  const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { parameter: { _ts: ts, _sig: sig }, postData: { contents: body } };
}

test('GAS accepts the compiled fleet secret when a Script Properties override exists', () => {
  const gas = loadGas();
  gas.hmacOverride = 'new-rotated-secret-for-canary';
  const event = signedEvent(gas.WEBHOOK_HMAC_SECRET_DEFAULT, '{"name":"Existing_Client"}');
  assert.equal(gas.verifyWebhookSignature_(event), '');
});

test('GAS also accepts the rotated override during the migration window', () => {
  const gas = loadGas();
  gas.hmacOverride = 'new-rotated-secret-for-canary';
  const event = signedEvent(gas.hmacOverride, '{"name":"Canary_Client"}');
  assert.equal(gas.verifyWebhookSignature_(event), '');
});

test('GAS still blocks replayed signatures', () => {
  const gas = loadGas();
  const event = signedEvent(gas.WEBHOOK_HMAC_SECRET_DEFAULT, '{"name":"Replay_Test"}');
  assert.equal(gas.verifyWebhookSignature_(event), '');
  assert.equal(gas.verifyWebhookSignature_(event), 'replay_blocked');
});

test('v4 roster repair fixes corrupted headers and rejects status text as a heartbeat', () => {
  const gas = loadGas();
  const input = [
    ['Name', 'FirstSeenAt', 'Version', 'Status', 'LastPong', 'LastUpload', 'Version', 'NextPollAt', 'LastUpdateCheck'],
    ['Active_User', '2026-05-08T10:00:00.000Z', '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z', '', '2026-07-21T08:00:00.000Z', '2.0.1', '2026-07-21T10:01:00.000Z', ''],
    ['Legacy_User', '2026-05-08T10:00:00.000Z', '', 'Current', '', '', '', '', ''],
  ];
  let written;
  const sheet = {
    getDataRange: () => ({ getValues: () => input }),
    clearContents: () => {},
    getRange: (row, col, rows, cols) => ({
      setValues(values) { written = values; return this; },
      setFontWeight() { return this; },
    }),
  };
  assert.equal(gas.repairRegisteredDevelopersSchema_(sheet), true);
  assert.deepEqual([...written[0]], [...gas.REG_SHEET_HEADERS]);
  assert.equal(written[1][3], '2026-07-21T10:00:00.000Z');
  assert.equal(written[1][6], '2.0.1');
  assert.equal(written[2][3], '');
});
