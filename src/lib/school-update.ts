type SchoolUpdateValues = {
  name?: unknown;
  city?: unknown;
  timezone?: unknown;
  releaseEnabled?: unknown;
  pickupLatitude?: unknown;
  pickupLongitude?: unknown;
  pickupRadiusMeters?: unknown;
  pickupRequestLifetimeMinutes?: unknown;
  pickupReleaseMinutesBeforeBell?: unknown;
  pickupSessionDurationMinutes?: unknown;
  studentLimit?: unknown;
};

const EDITABLE_FIELDS: readonly (keyof SchoolUpdateValues)[] = [
  'name',
  'city',
  'timezone',
  'releaseEnabled',
  'pickupLatitude',
  'pickupLongitude',
  'pickupRadiusMeters',
  'pickupRequestLifetimeMinutes',
  'pickupReleaseMinutesBeforeBell',
  'pickupSessionDurationMinutes',
  'studentLimit',
];

export function getManageSchoolInitialName(school: { name?: unknown }): string {
  return typeof school.name === 'string' ? school.name : '';
}

/** Return only values that differ from the selected school record. */
export function buildManageSchoolPatch(
  current: SchoolUpdateValues,
  submitted: SchoolUpdateValues,
): SchoolUpdateValues {
  const patch: SchoolUpdateValues = {};

  for (const field of EDITABLE_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(submitted, field) &&
      !Object.is(current[field], submitted[field])
    ) {
      patch[field] = submitted[field];
    }
  }

  return patch;
}

/** Preserve current values for fields omitted from a partial update. */
export function mergeManageSchoolPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): SchoolUpdateValues {
  const merged: SchoolUpdateValues = {};

  for (const field of EDITABLE_FIELDS) {
    merged[field] = Object.prototype.hasOwnProperty.call(patch, field)
      ? patch[field]
      : current[field];
  }

  return merged;
}
