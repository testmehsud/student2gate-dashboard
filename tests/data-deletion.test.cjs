/* eslint @typescript-eslint/no-require-imports: off */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(output, filename);
};
const model = require('../src/lib/data-deletion.ts');
const repoRoot = path.resolve(__dirname, '..');

class Snapshot {
  constructor(id, value) { this.id = id; this.value = value; this.exists = value !== undefined; }
  data() { return this.value; }
  get(field) { return this.value?.[field]; }
}
class MemoryQuery {
  constructor(db, collection, filters = [], sort = null, max = Infinity) {
    this.db = db; this.collection = collection; this.filters = filters; this.sort = sort; this.max = max;
  }
  where(field, operator, value) { return new MemoryQuery(this.db, this.collection, [...this.filters, [field, operator, value]], this.sort, this.max); }
  orderBy(field, direction = 'asc') { return new MemoryQuery(this.db, this.collection, this.filters, [field, direction], this.max); }
  limit(max) { return new MemoryQuery(this.db, this.collection, this.filters, this.sort, max); }
  async get() {
    let rows = this.db.entries(this.collection).filter(([, value]) => this.filters.every(([field, operator, expected]) => operator === '==' && value[field] === expected));
    if (this.sort) rows.sort((a, b) => {
      const av = a[1][this.sort[0]] instanceof Date ? a[1][this.sort[0]].getTime() : 0;
      const bv = b[1][this.sort[0]] instanceof Date ? b[1][this.sort[0]].getTime() : 0;
      return this.sort[1] === 'desc' ? bv - av : av - bv;
    });
    rows = rows.slice(0, this.max);
    return { docs: rows.map(([id, value]) => new Snapshot(id.split('/').at(-1), value)) };
  }
}
class MemoryRef {
  constructor(db, collection, id) { this.db = db; this.collectionName = collection; this.id = id; this.path = collection + '/' + id; }
  collection(name) { return new MemoryCollection(this.db, this.path + '/' + name); }
  async get() { return new Snapshot(this.id, this.db.data.get(this.path)); }
}
class MemoryCollection {
  constructor(db, name) { this.db = db; this.name = name; }
  doc(id = 'generated-' + (++this.db.sequence)) { return new MemoryRef(this.db, this.name, id); }
  where(field, operator, value) { return new MemoryQuery(this.db, this.name).where(field, operator, value); }
  orderBy(field, direction) { return new MemoryQuery(this.db, this.name).orderBy(field, direction); }
}
class MemoryDb {
  constructor() { this.data = new Map(); this.sequence = 0; }
  collection(name) { return new MemoryCollection(this, name); }
  entries(collection) {
    const prefix = collection + '/';
    return [...this.data.entries()].filter(([key]) => key.startsWith(prefix) && key.slice(prefix.length).split('/').length === 1);
  }
  seed(collection, id, value) { this.data.set(collection + '/' + id, value); }
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: async (target) => target instanceof MemoryQuery ? target.get() : target.get(),
      set: (ref, value) => writes.push(['set', ref, value]),
      create: (ref, value) => writes.push(['create', ref, value]),
      update: (ref, value) => writes.push(['update', ref, value]),
    };
    const result = await callback(transaction);
    for (const [kind, ref, value] of writes) {
      const prior = this.data.get(ref.path);
      if (kind === 'create' && prior !== undefined) throw new Error('already exists');
      if (kind === 'update' && prior === undefined) throw new Error('missing');
      this.data.set(ref.path, kind === 'set' || kind === 'create' ? value : { ...prior, ...value });
    }
    return result;
  }
}
function loadRoute(relativePath, mocks) {
  const absolute = path.resolve(repoRoot, relativePath);
  delete require.cache[absolute];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(absolute); } finally { Module._load = originalLoad; }
}
function publicRoute(db) {
  return loadRoute('src/app/api/public/data-deletion-requests/route.ts', {
    '@/lib/firebase-admin': { getAdminDb: () => db },
    '@/lib/data-deletion': model,
    'firebase-admin/firestore': {
      FieldValue: { serverTimestamp: () => new Date('2026-10-10T12:00:00.000Z') },
      Timestamp: { fromMillis: (value) => ({ toMillis: () => value }) },
    },
  });
}
function request(body, overrides = {}) {
  return new Request('https://student2gate-dashboard.vercel.app/api/public/data-deletion-requests', {
    method: 'POST',
    headers: {
      origin: 'https://student2gate-website.vercel.app',
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.10',
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

 test('intake normalizes email/school and stores only the required identifiers', async () => {
  const db = new MemoryDb();
  const response = await publicRoute(db).POST(request({ email: ' Person@Example.com ', accountRole: 'PARENT_GUARDIAN', school: '  North   School ' }));
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.requestReference, /^DR-[A-F0-9]{12}$/);
  const rows = db.entries('dataDeletionRequests');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0][1]).sort(), ['accountRole', 'email', 'requestReference', 'school', 'status', 'submittedAt', 'updatedAt'].sort());
  assert.equal(rows[0][1].email, 'person@example.com');
  assert.equal(rows[0][1].school, 'North School');
  assert.equal(rows[0][1].status, 'RECEIVED');
  assert.equal(db.entries(rows[0][0] + '/statusEvents').length, 1);
  assert.equal(JSON.stringify(result).includes('person@example.com'), false);
});

test('invalid role/email, a filled honeypot, and an unapproved origin are rejected without storing a request', async () => {
  const db = new MemoryDb();
  const route = publicRoute(db);
  assert.equal((await route.POST(request({ email: 'not-email', accountRole: 'PARENT_GUARDIAN', school: '' }))).status, 400);
  assert.equal((await route.POST(request({ email: 'a@example.com', accountRole: 'ADMIN', school: '' }))).status, 400);
  assert.equal((await route.POST(request({ email: 'a@example.com', accountRole: 'OTHER', school: '', website: 'spam' }))).status, 400);
  assert.equal((await route.POST(request({ email: 'a@example.com', accountRole: 'OTHER', school: '' }, { origin: 'https://attacker.example' }))).status, 403);
  assert.equal(db.entries('dataDeletionRequests').length, 0);
  assert.equal(db.entries('dataDeletionIntakeLimits').length, 0);
});

test('duplicate submissions reuse one open request reference', async () => {
  const db = new MemoryDb();
  const route = publicRoute(db);
  const body = { email: 'parent@example.com', accountRole: 'PARENT_GUARDIAN', school: 'North School' };
  const first = await route.POST(request(body));
  const second = await route.POST(request(body));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await first.json()).requestReference, (await second.json()).requestReference);
  assert.equal(db.entries('dataDeletionRequests').length, 1);
});

test('intake applies a durable network rate limit and does not return request details', async () => {
  const db = new MemoryDb();
  const route = publicRoute(db);
  for (let index = 0; index < 5; index += 1) {
    const response = await route.POST(request({ email: 'person' + index + '@example.com', accountRole: 'OTHER', school: '' }));
    assert.equal(response.status, 201);
  }
  const limited = await route.POST(request({ email: 'sixth@example.com', accountRole: 'OTHER', school: '' }));
  assert.equal(limited.status, 429);
  assert.doesNotMatch(JSON.stringify(await limited.json()), /sixth@example\.com/);
  assert.equal(db.entries('dataDeletionRequests').length, 5);
});

test('only the server-side Platform Owner gate can read requests or change status', async () => {
  let databaseCalls = 0;
  const mocks = {
    '@/lib/firebase-admin': { getAdminDb: () => { databaseCalls += 1; throw new Error('must not reach database'); } },
    '@/lib/platform-auth': { requirePlatformAdmin: async () => { throw new Error('PLATFORM_OWNER_REQUIRED'); } },
    '@/lib/data-deletion': model,
  };
  const list = loadRoute('src/app/api/platform/data-deletion-requests/route.ts', mocks);
  const detail = loadRoute('src/app/api/platform/data-deletion-requests/[requestId]/route.ts', mocks);
  assert.equal((await list.GET()).status, 401);
  assert.equal((await detail.GET(new Request('https://dashboard.test'), { params: Promise.resolve({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) })).status, 401);
  const patch = new Request('https://dashboard.test/api', { method: 'PATCH', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'IN_PROGRESS' }) });
  assert.equal((await detail.PATCH(patch, { params: Promise.resolve({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) })).status, 401);
  assert.equal(databaseCalls, 0);
});

test('authorized status update writes actor and timestamp history; completed is unavailable', async () => {
  const db = new MemoryDb();
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  db.seed('dataDeletionRequests', requestId, {
    requestReference: 'DR-123456ABCDEF', email: 'person@example.com', accountRole: 'OTHER', school: '',
    status: 'RECEIVED', submittedAt: new Date('2026-10-10T10:00:00.000Z'),
  });
  const detail = loadRoute('src/app/api/platform/data-deletion-requests/[requestId]/route.ts', {
    '@/lib/firebase-admin': { getAdminDb: () => db },
    '@/lib/platform-auth': { requirePlatformAdmin: async () => ({ uid: 'owner-1', name: 'Platform Owner', email: 'owner@example.com', role: 'PLATFORM_OWNER', status: 'ACTIVE' }) },
    'firebase-admin/firestore': { FieldValue: { serverTimestamp: () => new Date('2026-10-10T12:00:00.000Z') } },
    '@/lib/data-deletion': model,
  });
  const oldOrigin = process.env.DASHBOARD_ORIGIN;
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.test';
  try {
    const patch = new Request('https://dashboard.test/api', { method: 'PATCH', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken: 'csrf-test', status: 'VERIFICATION_REQUIRED' }) });
    Object.defineProperty(patch, 'cookies', { value: { get: () => ({ value: 'csrf-test' }) } });
    const result = await detail.PATCH(patch, { params: Promise.resolve({ requestId }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).request.status, 'VERIFICATION_REQUIRED');
    const events = db.entries('dataDeletionRequests/' + requestId + '/statusEvents');
    assert.equal(events.length, 1);
    assert.equal(events[0][1].fromStatus, 'RECEIVED');
    assert.equal(events[0][1].toStatus, 'VERIFICATION_REQUIRED');
    assert.equal(events[0][1].actorUid, 'owner-1');
    assert.ok(events[0][1].changedAt instanceof Date);
    assert.ok(events[0][1].createdAt instanceof Date);

    const completed = new Request('https://dashboard.test/api', { method: 'PATCH', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken: 'csrf-test', status: 'COMPLETED' }) });
    Object.defineProperty(completed, 'cookies', { value: { get: () => ({ value: 'csrf-test' }) } });
    assert.equal((await detail.PATCH(completed, { params: Promise.resolve({ requestId }) })).status, 400);
  } finally {
    if (oldOrigin === undefined) delete process.env.DASHBOARD_ORIGIN;
    else process.env.DASHBOARD_ORIGIN = oldOrigin;
  }
});

test('request statuses have no completion or delete operation and enforce explicit transitions', () => {
  assert.equal(model.canTransitionDataDeletionStatus('RECEIVED', 'VERIFICATION_REQUIRED'), true);
  assert.equal(model.canTransitionDataDeletionStatus('RECEIVED', 'COMPLETED'), false);
  assert.equal(model.canTransitionDataDeletionStatus('UNABLE_TO_COMPLETE', 'IN_PROGRESS'), false);
  assert.equal(model.DATA_DELETION_STATUSES.includes('COMPLETED'), false);
  const source = fs.readFileSync(path.resolve(repoRoot, 'src/app/api/platform/data-deletion-requests/[requestId]/route.ts'), 'utf8');
  assert.doesNotMatch(source, /export async function DELETE/);
  assert.match(source, /actorUid: admin\.uid/);
  assert.match(source, /changedAt/);
});
