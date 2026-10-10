/* eslint @typescript-eslint/no-require-imports: off */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

require.extensions['.ts'] = (loadedModule, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  loadedModule._compile(output, filename);
};
const repoRoot = path.resolve(__dirname, '..');
const { buildManageSchoolPatch, getManageSchoolInitialName, mergeManageSchoolPatch } = require('../src/lib/school-update.ts');

class Snapshot {
  constructor(id, value) { this.id = id; this.value = value; this.exists = value !== undefined; }
  data() { return this.value; }
}
class MemoryRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').at(-1); }
  collection(name) { return new MemoryCollection(this.db, this.path + '/' + name); }
  async get() { return new Snapshot(this.id, this.db.data.get(this.path)); }
}
class MemoryQuery {
  constructor(db, collection, filters = []) { this.db = db; this.collection = collection; this.filters = filters; }
  where(field, operator, expected) { return new MemoryQuery(this.db, this.collection, [...this.filters, [field, operator, expected]]); }
  async get() {
    const docs = this.db.entries(this.collection).filter(([, value]) => this.filters.every(([field, operator, expected]) => operator === '==' && value[field] === expected));
    return { size: docs.length, docs: docs.map(([key, value]) => new Snapshot(key.split('/').at(-1), value)) };
  }
}
class MemoryCollection {
  constructor(db, name) { this.db = db; this.name = name; }
  doc(id = 'generated-' + (++this.db.sequence)) { return new MemoryRef(this.db, this.name + '/' + id); }
  where(field, operator, value) { return new MemoryQuery(this.db, this.name).where(field, operator, value); }
}
class MemoryDb {
  constructor() { this.data = new Map(); this.sequence = 0; this.reads = 0; }
  collection(name) { return new MemoryCollection(this, name); }
  entries(collection) {
    const prefix = collection + '/';
    return [...this.data.entries()].filter(([key]) => key.startsWith(prefix) && key.slice(prefix.length).split('/').length === 1);
  }
  seed(collection, id, value) { this.data.set(collection + '/' + id, value); }
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      get: async (target) => { this.reads += 1; return target.get(); },
      create: (ref, value) => writes.push(['create', ref, value]),
      update: (ref, value) => writes.push(['update', ref, value]),
    };
    const result = await callback(transaction);
    for (const [kind, ref, value] of writes) {
      const prior = this.data.get(ref.path);
      if (kind === 'create' && prior !== undefined) throw new Error('already exists');
      if (kind === 'update' && prior === undefined) throw new Error('missing');
      this.data.set(ref.path, kind === 'create' ? value : { ...prior, ...value });
    }
    return result;
  }
}

async function loadSchoolRoute(db, { authorized = true } = {}) {
  const capacity = await import('../src/lib/student-capacity.mjs');
  const absolute = path.resolve(repoRoot, 'src/app/api/platform/schools/[schoolId]/route.ts');
  delete require.cache[absolute];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@/lib/firebase-admin') return { getAdminDb: () => db };
    if (request === '@/lib/platform-auth') return { requirePlatformAdmin: async () => { if (!authorized) throw new Error('PLATFORM_OWNER_REQUIRED'); return { uid: 'owner-test', name: 'Platform Owner', email: null, role: 'PLATFORM_OWNER', status: 'ACTIVE' }; } };
    if (request === 'firebase-admin/firestore') return { FieldValue: { serverTimestamp: () => new Date('2026-10-10T12:00:00.000Z') } };
    if (request === '@/lib/student-capacity.mjs') return capacity;
    if (request === '@/lib/school-update') return require(path.resolve(repoRoot, 'src/lib/school-update.ts'));
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(absolute); } finally { Module._load = originalLoad; }
}

function validSchool(overrides = {}) {
  return {
    name: 'Example Academy', city: 'Example City', status: 'ACTIVE', timezone: 'Asia/Karachi', releaseEnabled: true,
    pickupLatitude: 33.6844, pickupLongitude: 73.0479, pickupRadiusMeters: 100,
    pickupRequestLifetimeMinutes: 30, pickupReleaseMinutesBeforeBell: 15, pickupSessionDurationMinutes: 60,
    studentLimit: null, activeStudentCount: 0, ...overrides,
  };
}
function patchRequest(body, schoolId = 'school-example') {
  const request = new Request('https://dashboard.test/api/platform/schools/' + schoolId, {
    method: 'PATCH', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken: 'csrf-test-012345678901234567890123456789', action: 'update', ...body }),
  });
  Object.defineProperty(request, 'cookies', { value: { get: () => ({ value: 'csrf-test-012345678901234567890123456789' }) } });
  return request;
}
async function withOrigin(callback) {
  const oldOrigin = process.env.DASHBOARD_ORIGIN;
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.test';
  try { await callback(); }
  finally { if (oldOrigin === undefined) delete process.env.DASHBOARD_ORIGIN; else process.env.DASHBOARD_ORIGIN = oldOrigin; }
}

test('Manage School initializes the selected school name and capacity-only form data omits unchanged settings', () => {
  const current = validSchool();
  assert.equal(getManageSchoolInitialName(current), 'Example Academy');
  const patch = buildManageSchoolPatch(current, { ...current, studentLimit: 300 });
  assert.deepEqual(patch, { studentLimit: 300 });
  assert.equal(mergeManageSchoolPatch(current, patch).name, 'Example Academy');
});

test('capacity-only update on an existing school preserves its name and unrelated settings', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool());
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.school.name, 'Example Academy');
    assert.equal(result.school.city, 'Example City');
    assert.equal(result.school.timezone, 'Asia/Karachi');
    assert.equal(result.school.releaseEnabled, true);
    assert.equal(result.school.pickupRadiusMeters, 100);
    assert.equal(result.school.studentLimit, 300);
  });
});

test('new schools still reject an invalid name', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    const capacity = await import('../src/lib/student-capacity.mjs');
    const absolute = path.resolve(repoRoot, 'src/app/api/platform/schools/route.ts');
    delete require.cache[absolute];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === '@/lib/firebase-admin') return { getAdminDb: () => db };
      if (request === '@/lib/platform-auth') return { requirePlatformAdmin: async () => ({ uid: 'owner-test', name: 'Platform Owner', email: null, role: 'PLATFORM_OWNER', status: 'ACTIVE' }) };
      if (request === 'firebase-admin/firestore') return { FieldValue: { serverTimestamp: () => new Date('2026-10-10T12:00:00.000Z') } };
      if (request === '@/lib/student-capacity.mjs') return capacity;
      return originalLoad.call(this, request, parent, isMain);
    };
    let route;
    try { route = require(absolute); } finally { Module._load = originalLoad; }
    const request = new Request('https://dashboard.test/api/platform/schools', {
      method: 'POST', headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken: 'csrf-test-012345678901234567890123456789', name: 'X', studentLimit: 300 }),
    });
    Object.defineProperty(request, 'cookies', { value: { get: () => ({ value: 'csrf-test-012345678901234567890123456789' }) } });
    const response = await route.POST(request);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /School name must be between 2 and 200 characters/);
    assert.equal(db.entries('schools').length, 0);
  });
});

test('explicit invalid school names are still rejected', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool());
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ name: '', studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, 'invalid_school');
    assert.match(result.message, /School name must be between 2 and 200 characters/);
    assert.equal(db.data.get('schools/school-example').name, 'Example Academy');
  });
});

test('partial updates still require Platform Owner authorization and an existing school', async () => {
  await withOrigin(async () => {
    const deniedDb = new MemoryDb();
    const deniedRoute = await loadSchoolRoute(deniedDb, { authorized: false });
    assert.equal((await deniedRoute.PATCH(patchRequest({ studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) })).status, 401);
    assert.equal(deniedDb.reads, 0);

    const missingDb = new MemoryDb();
    const missingRoute = await loadSchoolRoute(missingDb);
    const missing = await missingRoute.PATCH(patchRequest({ studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(missing.status, 404);
  });
});

test('capacity below the existing active-student count remains rejected', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool({ studentLimit: 500, activeStudentCount: 137 }));
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ studentLimit: 100 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'invalid_student_capacity');
    assert.equal(db.data.get('schools/school-example').studentLimit, 500);
  });
});
