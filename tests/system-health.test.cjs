/* eslint @typescript-eslint/no-require-imports: off */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const typescript = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const {
  evaluateFirestoreHealth,
  evaluateOverallHealth,
  evaluateWorkerHealth,
  filterMonitoringErrors,
  isMonitoringDataStale,
  safeResponseCode,
} = require('../src/lib/system-health/model.ts');

function errorRow(overrides = {}) {
  return {
    id: 'firestore-unavailable',
    service: 'Firestore',
    severity: 'warning',
    errorType: 'Service unavailable',
    message: 'Firestore API returned service unavailable responses.',
    count: 2,
    firstOccurrence: '2026-10-06T10:00:00.000Z',
    lastOccurrence: '2026-10-06T10:05:00.000Z',
    status: 'Observed',
    ...overrides,
  };
}

test('all monitored sources healthy produces healthy state', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'healthy', 'healthy']), 'healthy');
});

test('one warning source produces warning state', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'warning', 'healthy']), 'warning');
  assert.equal(evaluateWorkerHealth(1_000, 11), 'warning');
  assert.equal(evaluateFirestoreHealth(1.2, 0, null), 'warning');
});

test('critical worker and database thresholds produce critical state', () => {
  assert.equal(evaluateWorkerHealth(1_000, 51), 'critical');
  assert.equal(evaluateFirestoreHealth(6, 0, null), 'critical');
  assert.equal(evaluateFirestoreHealth(null, 10, null), 'critical');
  assert.equal(evaluateFirestoreHealth(null, 0, 3_000), 'critical');
});

test('missing sources never produce healthy state', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'unavailable', 'healthy']), 'unavailable');
  assert.equal(evaluateWorkerHealth(null, null), 'unavailable');
  assert.equal(evaluateFirestoreHealth(null, null, null), 'unavailable');
});

test('stale or missing monitoring samples are unavailable', () => {
  const now = Date.parse('2026-10-06T10:10:00.000Z');
  assert.equal(isMonitoringDataStale('2026-10-06T10:00:00.000Z', now), false);
  assert.equal(isMonitoringDataStale('2026-10-06T09:59:00.000Z', now), true);
  assert.equal(isMonitoringDataStale(null, now), true);
  assert.equal(isMonitoringDataStale('invalid', now), true);
});

test('provider response codes are reduced to safe allowlisted labels', () => {
  assert.deepEqual(safeResponseCode('PERMISSION_DENIED'), {
    key: 'permission_denied',
    label: 'Permission denied',
    severity: 'warning',
  });
  const unknown = safeResponseCode('Bearer secret-token-value');
  assert.equal(unknown.label, 'Other response');
  assert.equal(unknown.key, 'other');
  assert.equal(JSON.stringify(unknown).includes('secret-token-value'), false);
});

test('recent error filters sort, filter, and cap results', () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const minute = String(5 + index).padStart(2, '0');
    return errorRow({
      id: `row-${index}`,
      lastOccurrence: `2026-10-06T10:${minute}:00.000Z`,
    });
  });
  rows.push(errorRow({
    id: 'critical',
    severity: 'critical',
    service: 'Student2Gate Worker',
    lastOccurrence: '2026-10-06T11:00:00.000Z',
  }));

  const filtered = filterMonitoringErrors(rows, 'Firestore', 'warning');
  assert.equal(filtered.length, 25);
  assert.ok(filtered.every((row) => row.service === 'Firestore' && row.severity === 'warning'));
  assert.equal(filtered[0].id, 'row-29');
  assert.equal(filtered.at(-1).id, 'row-5');
  assert.equal(filterMonitoringErrors(rows, 'Student2Gate Worker', 'critical')[0].id, 'critical');
});
