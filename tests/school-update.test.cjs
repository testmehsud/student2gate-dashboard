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
const { buildManageSchoolPatch, getManageSchoolInitialName, getSchoolConfigurationIssues, mergeManageSchoolPatch, serializeManageSchool } = require('../src/lib/school-update.ts');

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
    schoolId: 'school-example', name: 'Example Academy', city: 'Example City', status: 'ACTIVE', timezone: 'Asia/Karachi', releaseEnabled: true,
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
      if (request === '@/lib/school-update') return require(path.resolve(repoRoot, 'src/lib/school-update.ts'));
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
    const result = await response.json();
    assert.equal(result.error, 'invalid_school');
    const fields = result.issues.map((issue) => issue.field);
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('timezone'));
    assert.ok(fields.includes('releaseEnabled'));
    assert.ok(fields.includes('pickupLatitude'));
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
    const nameIssue = result.issues.find((issue) => issue.field === 'name');
    assert.equal(nameIssue.code, 'required');
    assert.match(nameIssue.message, /school name with at least 2 characters/);
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

test('the school serializer reports all invalid required values without inventing defaults', () => {
  const school = serializeManageSchool('school-example', validSchool({
    name: '',
    timezone: 'Not/A_Time_Zone',
    releaseEnabled: 'false',
    pickupLatitude: null,
    pickupLongitude: 'not-a-number',
    pickupRadiusMeters: null,
    pickupRequestLifetimeMinutes: null,
    studentLimit: null,
  }), {
    isValidStudentLimit: (value) => value === 300,
    allowZeroRadiusWhenDisabled: true,
    expectedSchoolId: 'school-example',
  });
  assert.equal(school.name, '');
  assert.equal(school.timezone, 'Not/A_Time_Zone');
  assert.equal(school.releaseEnabled, null);
  assert.equal(school.pickupLatitude, null);
  const fields = school.configurationIssues.map((issue) => issue.field);
  for (const field of ['name', 'timezone', 'releaseEnabled', 'pickupLatitude', 'pickupLongitude', 'pickupRadiusMeters', 'pickupRequestLifetimeMinutes', 'studentLimit']) {
    assert.ok(fields.includes(field), 'missing issue for ' + field);
  }
});

test('paid-provisioned disabled pickup settings remain valid with Worker timing defaults', () => {
  const school = serializeManageSchool('school-example', {
    schoolId: 'school-example',
    name: 'Paid Example School',
    status: 'INACTIVE',
    timezone: 'America/New_York',
    studentLimit: 300,
    activeStudentCount: 0,
    releaseEnabled: false,
    pickupLatitude: 0,
    pickupLongitude: 0,
    pickupRadiusMeters: 0,
    pickupRequestLifetimeMinutes: 30,
  }, {
    isValidStudentLimit: (value) => value === 300,
    allowZeroRadiusWhenDisabled: true,
    expectedSchoolId: 'school-example',
  });
  assert.equal(school.pickupRadiusMeters, 0);
  assert.equal(school.pickupReleaseMinutesBeforeBell, null);
  assert.equal(school.pickupSessionDurationMinutes, null);
  assert.deepEqual(school.configurationIssues, []);
  assert.deepEqual(
    getSchoolConfigurationIssues({
      name: 'Paid Example School', city: '', timezone: 'America/New_York',
      studentLimit: 300, activeStudentCount: 0, releaseEnabled: false,
      pickupLatitude: 0, pickupLongitude: 0, pickupRadiusMeters: 0,
      pickupRequestLifetimeMinutes: 30,
    }, {
      isValidStudentLimit: (value) => value === 300,
      allowZeroRadiusWhenDisabled: true,
    }),
    [],
  );
});

test('manual creation writes the canonical school fields and initializes capacity counters', async () => {
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
      if (request === '@/lib/school-update') return require(path.resolve(repoRoot, 'src/lib/school-update.ts'));
      return originalLoad.call(this, request, parent, isMain);
    };
    let route;
    try { route = require(absolute); } finally { Module._load = originalLoad; }
    const payload = {
      csrfToken: 'csrf-test-012345678901234567890123456789',
      name: 'Manual Example Academy',
      city: 'Example City',
      timezone: 'Europe/London',
      studentLimit: 300,
      releaseEnabled: false,
      pickupLatitude: 51.5072,
      pickupLongitude: -0.1276,
      pickupRadiusMeters: 150,
      pickupRequestLifetimeMinutes: 30,
      pickupReleaseMinutesBeforeBell: 5,
      pickupSessionDurationMinutes: 30,
    };
    const request = new Request('https://dashboard.test/api/platform/schools', {
      method: 'POST',
      headers: { origin: 'https://dashboard.test', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    Object.defineProperty(request, 'cookies', { value: { get: () => ({ value: payload.csrfToken }) } });
    const response = await route.POST(request);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.school.name, payload.name);
    assert.equal(result.school.timezone, payload.timezone);
    assert.equal(result.school.studentLimit, 300);
    assert.equal(result.school.activeStudentCount, 0);
    const saved = db.data.get('schools/' + result.school.schoolId);
    assert.equal(saved.schoolId, result.school.schoolId);
    assert.equal(saved.status, 'ACTIVE');
    assert.equal(saved.pickupRadiusMeters, 150);
    assert.equal(saved.activeStudentCount, 0);
  });
});

test('legacy updates report all field errors together and make no partial writes', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    const legacy = validSchool({
      name: '',
      timezone: 'Not/A_Time_Zone',
      releaseEnabled: undefined,
      pickupLatitude: null,
      pickupLongitude: 'bad',
      pickupRadiusMeters: null,
      pickupRequestLifetimeMinutes: null,
      studentLimit: null,
    });
    db.seed('schools', 'school-example', legacy);
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ city: 'Changed City' }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 400);
    const result = await response.json();
    const fields = result.issues.map((issue) => issue.field);
    for (const field of ['name', 'timezone', 'releaseEnabled', 'pickupLatitude', 'pickupLongitude', 'pickupRadiusMeters', 'pickupRequestLifetimeMinutes', 'studentLimit']) {
      assert.ok(fields.includes(field), 'missing issue for ' + field);
    }
    assert.deepEqual(db.data.get('schools/school-example'), legacy);
    assert.equal(db.entries('platformAuditLog').length, 0);
  });
});

test('partial update preserves omitted optionals and explicit city clearing is retained', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    const paid = {
      schoolId: 'school-example', name: 'Paid Example School', city: 'Old City',
      status: 'INACTIVE', timezone: 'America/New_York', releaseEnabled: false,
      pickupLatitude: 0, pickupLongitude: 0, pickupRadiusMeters: 0,
      pickupRequestLifetimeMinutes: 30, studentLimit: 300, activeStudentCount: 0,
    };
    db.seed('schools', 'school-example', paid);
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ studentLimit: 500, city: '' }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 200);
    const saved = db.data.get('schools/school-example');
    assert.equal(saved.name, paid.name);
    assert.equal(saved.timezone, paid.timezone);
    assert.equal(saved.releaseEnabled, false);
    assert.equal(saved.pickupRadiusMeters, 0);
    assert.equal(saved.city, '');
    assert.equal(Object.hasOwn(saved, 'pickupReleaseMinutesBeforeBell'), false);
    assert.equal(Object.hasOwn(saved, 'pickupSessionDurationMinutes'), false);
  });
});

test('school document identity mismatch blocks an otherwise valid update', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool({ schoolId: 'other-school' }));
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.ok(result.issues.some((issue) => issue.field === 'schoolId' && issue.code === 'id_mismatch'));
    assert.equal(db.data.get('schools/school-example').schoolId, 'other-school');
    assert.equal(db.entries('platformAuditLog').length, 0);
  });
});

test('a valid IANA timezone change persists and reopens as the saved value', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool());
    const route = await loadSchoolRoute(db);
    const response = await route.PATCH(patchRequest({ timezone: 'Europe/London', studentLimit: 300 }), { params: Promise.resolve({ schoolId: 'school-example' }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.school.timezone, 'Europe/London');
    assert.equal(result.school.configurationIssues.some((issue) => issue.field === 'timezone'), false);
    const reopened = serializeManageSchool('school-example', db.data.get('schools/school-example'), {
      isValidStudentLimit: (value) => value === 300,
      expectedSchoolId: 'school-example',
    });
    assert.equal(reopened.timezone, 'Europe/London');
  });
});

test('manual creation still requires a positive radius even when pickup is disabled', () => {
  const issues = getSchoolConfigurationIssues({
    ...validSchool(), studentLimit: 300, releaseEnabled: false, pickupRadiusMeters: 0,
  }, {
    isValidStudentLimit: (value) => value === 300,
    requirePickupTiming: true,
  });
  assert.ok(issues.some((issue) => issue.field === 'pickupRadiusMeters' && issue.code === 'invalid_radius'));
});

test('zero release-before-bell value is rejected because the Worker requires positive stored timing', () => {
  const issues = getSchoolConfigurationIssues({
    ...validSchool(), studentLimit: 300, pickupReleaseMinutesBeforeBell: 0,
  }, {
    isValidStudentLimit: (value) => value === 300,
    requirePickupTiming: true,
  });
  assert.ok(issues.some((issue) => issue.field === 'pickupReleaseMinutesBeforeBell' && issue.code === 'invalid_timing'));
});

test('explicit null clears an optional Worker-default setting while required null remains invalid', async () => {
  await withOrigin(async () => {
    const db = new MemoryDb();
    db.seed('schools', 'school-example', validSchool({
      studentLimit: 300,
      activeStudentCount: 0,
      pickupSessionDurationMinutes: 60,
    }));
    const route = await loadSchoolRoute(db);
    const cleared = await route.PATCH(
      patchRequest({ studentLimit: 500, pickupSessionDurationMinutes: null }),
      { params: Promise.resolve({ schoolId: 'school-example' }) },
    );
    assert.equal(cleared.status, 200);
    assert.equal(db.data.get('schools/school-example').pickupSessionDurationMinutes, null);

    const beforeInvalid = { ...db.data.get('schools/school-example') };
    const invalid = await route.PATCH(
      patchRequest({ timezone: null }),
      { params: Promise.resolve({ schoolId: 'school-example' }) },
    );
    assert.equal(invalid.status, 400);
    const result = await invalid.json();
    assert.ok(result.issues.some((issue) => issue.field === 'timezone' && issue.code === 'invalid_iana_timezone'));
    assert.deepEqual(db.data.get('schools/school-example'), beforeInvalid);
  });
});
