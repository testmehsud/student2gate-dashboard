/** Capacity choices shared by manual school setup and paid onboarding.
 * Keep these aligned with worker/src/onboarding_plans.ts.
 * @type {readonly number[]} */
export const MANUAL_STUDENT_CAPACITY_OPTIONS = Object.freeze([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);

/** @param {unknown} value */
export function parseManualStudentLimit(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && MANUAL_STUDENT_CAPACITY_OPTIONS.includes(value) ? value : null;
}

/** @param {unknown} value */
export function createManualStudentCapacity(value) {
  const studentLimit = parseManualStudentLimit(value);
  return studentLimit === null ? null : { studentLimit, activeStudentCount: 0 };
}

/** @param {unknown} value @param {unknown} activeStudentCount */
export function validateManualStudentCapacity(value, activeStudentCount) {
  const studentLimit = parseManualStudentLimit(value);
  if (studentLimit === null) return { ok: false, error: 'invalid_student_limit' };
  if (!Number.isSafeInteger(activeStudentCount) || activeStudentCount < 0) return { ok: false, error: 'invalid_active_student_count' };
  if (activeStudentCount > studentLimit) return { ok: false, error: 'student_limit_below_active_count' };
  return { ok: true, studentLimit, activeStudentCount };
}
