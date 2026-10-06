/* eslint @typescript-eslint/no-require-imports: off */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  evaluateMonitoringSampleHealth,
  evaluateWorkerHealth,
  filterMonitoringErrors,
  isMonitoringDataStale,
  safeResponseCode,
} = require('../src/lib/system-health/model.ts');

const {
  buildCloudMonitoringParams,
  queryCloudflareWorker,
  queryVercelProductionDeployment,
} = require('../src/lib/system-health/providers.ts');

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

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('Cloudflare Worker Analytics request scopes account, Worker, metrics, and UTC interval', async () => {
  const start = '2026-10-06T10:00:00.000Z';
  const end = '2026-10-06T10:05:00.000Z';
  let request;
  const result = await queryCloudflareWorker({
    start, end, accountId: 'account-id', workerName: 'student2gate-api',
    token: 'server-only-token',
    fetcher: async (url, init) => {
      request = { url: String(url), init };
      return mockResponse({
        data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{
          sum: { requests: 12, errors: 1 },
          dimensions: { datetime: '2026-10-06T10:04:00.000Z', scriptName: 'student2gate-api', status: 'scriptThrewException' },
        }] }] } },
      });
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.rows[0].sum.requests, 12);
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(request.init.headers.Authorization, 'Bearer server-only-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.variables.accountTag, 'account-id');
  assert.equal(body.variables.scriptName, 'student2gate-api');
  assert.equal(body.variables.start, start);
  assert.equal(body.variables.end, end);
  assert.match(body.query, /workersInvocationsAdaptive/);
  assert.match(body.query, /sum \{ requests errors \}/);
  assert.match(body.query, /dimensions \{ datetime scriptName status \}/);
  assert.match(body.query, /datetime_lt: \$end/);
});

test('Cloudflare HTTP 200 GraphQL errors are unavailable and sanitized', async () => {
  const result = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z',
    end: '2026-10-06T10:05:00Z',
    accountId: 'account-id',
    token: 'must-not-leak',
    fetcher: async () => mockResponse({ data: null, errors: [{ message: 'must-not-leak' }] }),
  });
  assert.equal(result.rows.length, 0);
  assert.match(result.error, /rejected/);
  assert.equal(result.error.includes('must-not-leak'), false);
});

test('Cloudflare successful empty result is zero recent traffic, not provider outage', async () => {
  const result = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z',
    end: '2026-10-06T10:05:00Z',
    accountId: 'account-id',
    token: 'server-only-token',
    fetcher: async () => mockResponse({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } },
    }),
  });
  assert.deepEqual(result, { rows: [], error: null });
  assert.equal(evaluateWorkerHealth(0, 0), 'healthy');
});

test('Cloudflare stale samples remain unavailable', () => {
  const now = Date.parse('2026-10-06T10:10:00.000Z');
  assert.equal(evaluateMonitoringSampleHealth('2026-10-06T09:59:00.000Z', now), 'unavailable');
});

test('Firestore query uses Database resource, default database, UTC interval, and DELTA SUM aggregation', () => {
  const start = '2026-10-06T09:55:00.000Z';
  const end = '2026-10-06T10:00:00.000Z';
  const params = buildCloudMonitoringParams(
    'firestore.googleapis.com/api/request_count', start, end, 60, true,
  );
  assert.match(params.get('filter'), /firestore.googleapis.com\/Database/);
  assert.match(params.get('filter'), /resource.labels.database_id = "\(default\)"/);
  assert.match(params.get('filter'), /firestore.googleapis.com\/api\/request_count/);
  assert.equal(params.get('interval.startTime'), start);
  assert.equal(params.get('interval.endTime'), end);
  assert.equal(params.get('aggregation.alignmentPeriod'), '60s');
  assert.equal(params.get('aggregation.perSeriesAligner'), 'ALIGN_SUM');
  assert.equal(params.get('aggregation.crossSeriesReducer'), 'REDUCE_SUM');
  assert.equal(params.get('aggregation.groupByFields'), 'metric.labels.response_code');
});

test('Firestore latency query preserves percentile aggregation', () => {
  const params = buildCloudMonitoringParams(
    'firestore.googleapis.com/api/request_latencies',
    '2026-10-06T09:55:00Z',
    '2026-10-06T10:00:00Z',
    60,
  );
  assert.equal(params.get('aggregation.perSeriesAligner'), 'ALIGN_PERCENTILE_95');
  assert.equal(params.get('aggregation.crossSeriesReducer'), 'REDUCE_PERCENTILE_95');
});

test('Firestore fresh, delayed, stale, and zero-traffic samples are distinct', () => {
  const now = Date.parse('2026-10-06T10:10:00.000Z');
  assert.equal(evaluateMonitoringSampleHealth('2026-10-06T10:06:00.000Z', now), 'healthy');
  assert.equal(evaluateMonitoringSampleHealth('2026-10-06T10:04:00.000Z', now), 'warning');
  assert.equal(evaluateMonitoringSampleHealth('2026-10-06T09:59:00.000Z', now), 'unavailable');
  assert.equal(evaluateMonitoringSampleHealth(null, now, true), 'healthy');
  assert.equal(evaluateMonitoringSampleHealth(null, now, false), 'unavailable');
});

test('Vercel provider returns only safe production deployment fields server-side', async () => {
  let request;
  const result = await queryVercelProductionDeployment({
    token: 'server-only-token',
    projectId: 'configured-project-id',
    teamId: 'configured-team-id',
    fetcher: async (url, init) => {
      request = { url: new URL(String(url)), init };
      return mockResponse({ deployments: [{
        uid: 'dpl_safe-id',
        readyState: 'READY',
        createdAt: Date.parse('2026-10-06T10:00:00Z'),
        target: 'production',
        url: 'student2gate-dashboard.vercel.app',
        meta: { githubCommitSha: 'a'.repeat(40) },
      }] });
    },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.deployment, {
    deploymentId: 'dpl_safe-id',
    state: 'READY',
    commit: 'a'.repeat(40),
    createdAt: '2026-10-06T10:00:00.000Z',
    target: 'production',
    url: 'https://student2gate-dashboard.vercel.app',
  });
  assert.equal(request.url.searchParams.get('projectId'), 'configured-project-id');
  assert.equal(request.url.searchParams.get('teamId'), 'configured-team-id');
  assert.equal(request.url.searchParams.get('target'), 'production');
  assert.equal(request.url.searchParams.get('limit'), '1');
  assert.equal(request.init.headers.Authorization, 'Bearer server-only-token');
  assert.equal(JSON.stringify(result).includes('server-only-token'), false);
});

test('missing Vercel credential and provider API failures are sanitized', async () => {
  const missing = await queryVercelProductionDeployment({ projectId: 'configured-project-id' });
  assert.equal(missing.deployment, null);
  assert.match(missing.error, /VERCEL_ACCESS_TOKEN/);
  const failed = await queryVercelProductionDeployment({
    token: 'must-not-leak',
    projectId: 'configured-project-id',
    fetcher: async () => mockResponse({}, 403),
  });
  assert.equal(failed.deployment, null);
  assert.match(failed.error, /HTTP 403/);
  assert.equal(failed.error.includes('must-not-leak'), false);
});

test('provider loss remains unavailable even when another provider is healthy', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'unavailable']), 'unavailable');
  assert.equal(evaluateOverallHealth(['healthy', 'healthy']), 'healthy');
});

test('client page and public response types never contain provider credentials', () => {
  const page = fs.readFileSync(require.resolve('../src/app/dashboard/system-health/page.tsx'), 'utf8');
  const types = fs.readFileSync(require.resolve('../src/lib/system-health/types.ts'), 'utf8');
  assert.doesNotMatch(page, /VERCEL_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(types, /token\??:|apiKey\??:/i);

  const clientAssets = path.resolve(__dirname, '../.next/static');
  if (fs.existsSync(clientAssets)) {
    const pending = [clientAssets];
    const bundles = [];
    while (pending.length > 0) {
      for (const entry of fs.readdirSync(pending.pop(), { withFileTypes: true })) {
        const entryPath = path.join(entry.parentPath ?? clientAssets, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) bundles.push(entryPath);
      }
    }
    for (const bundle of bundles) {
      const source = fs.readFileSync(bundle, 'utf8');
      assert.doesNotMatch(source, /VERCEL_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|FIREBASE_SERVICE_ACCOUNT_JSON/);
    }
  }
});
