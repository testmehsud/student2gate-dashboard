import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
async function capacityModel() { return import('../src/lib/student-capacity.mjs'); }

test('manual setup uses the paid onboarding capacity tiers', async () => {
  const { MANUAL_STUDENT_CAPACITY_OPTIONS } = await capacityModel();
  deepEqual(MANUAL_STUDENT_CAPACITY_OPTIONS, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
});

test('new manual schools initialize the Worker school-wide capacity fields', async () => {
  const { createManualStudentCapacity } = await capacityModel();
  deepEqual(createManualStudentCapacity(300), { studentLimit: 300, activeStudentCount: 0 });
});

test('missing and invalid limits are rejected', async () => {
  const { createManualStudentCapacity } = await capacityModel();
  for (const invalid of [undefined, null, '', '300', 0, -100, 150, 100.5, 1001]) equal(createManualStudentCapacity(invalid), null);
});

test('existing schools retain active counts and reject contradictory limits', async () => {
  const { validateManualStudentCapacity } = await capacityModel();
  deepEqual(validateManualStudentCapacity(500, 137), { ok: true, studentLimit: 500, activeStudentCount: 137 });
  deepEqual(validateManualStudentCapacity(100, 137), { ok: false, error: 'student_limit_below_active_count' });
  deepEqual(validateManualStudentCapacity(300, -1), { ok: false, error: 'invalid_active_student_count' });
});
