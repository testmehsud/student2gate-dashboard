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

export type SchoolConfigurationIssue = {
  field: string;
  code: string;
  message: string;
};

export type SchoolConfigurationOptions = {
  isValidStudentLimit?: (value: unknown) => boolean;
  requirePickupTiming?: boolean;
  allowZeroRadiusWhenDisabled?: boolean;
  expectedSchoolId?: string;
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

export const SCHOOL_FIELD_LABELS: Record<string, string> = {
  schoolId: 'School ID',
  status: 'School status',
  name: 'School name',
  city: 'City',
  timezone: 'Timezone',
  releaseEnabled: 'Pickup release enabled',
  pickupLatitude: 'Pickup latitude',
  pickupLongitude: 'Pickup longitude',
  pickupRadiusMeters: 'Pickup radius',
  pickupRequestLifetimeMinutes: 'Request lifetime',
  pickupReleaseMinutesBeforeBell: 'Release before bell',
  pickupSessionDurationMinutes: 'Session duration',
  studentLimit: 'Student capacity',
};

function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function getSchoolConfigurationIssues(
  values: Record<string, unknown>,
  options: SchoolConfigurationOptions = {},
): SchoolConfigurationIssue[] {
  const issues: SchoolConfigurationIssue[] = [];
  const add = (field: string, code: string, message: string) => {
    issues.push({ field, code, message });
  };

  const name = values.name;
  if (typeof name !== 'string' || name.trim().length < 2) {
    add('name', 'required', 'Enter a school name with at least 2 characters.');
  } else if (name.trim().length > 200) {
    add('name', 'too_long', 'School name must be 200 characters or fewer.');
  }

  if (options.expectedSchoolId !== undefined && values.schoolId !== options.expectedSchoolId) {
    add('schoolId', 'id_mismatch', 'The school document ID does not match its saved school ID. This identity cannot be changed in Manage School.');
  }

  const status = values.status;
  if ((status !== undefined || options.expectedSchoolId !== undefined) && (typeof status !== 'string' || !['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(status))) {
    add('status', 'invalid_status', 'The saved school status is not recognized. This lifecycle value cannot be repaired in Manage School.');
  }

  const city = values.city;
  if (city !== undefined && city !== null && typeof city !== 'string') {
    add('city', 'invalid_type', 'Enter a city name or leave the field blank.');
  } else if (typeof city === 'string' && city.trim().length > 100) {
    add('city', 'too_long', 'City must be 100 characters or fewer.');
  }

  if (!isValidTimezone(values.timezone)) {
    add('timezone', 'invalid_iana_timezone', 'Enter a valid IANA timezone, such as Europe/London.');
  }

  const isValidStudentLimit = options.isValidStudentLimit
    ? options.isValidStudentLimit(values.studentLimit)
    : Number.isSafeInteger(values.studentLimit) && Number(values.studentLimit) > 0;
  if (!isValidStudentLimit) {
    add('studentLimit', 'invalid_capacity', 'Choose one of the approved school-wide student capacity limits.');
  }

  if (typeof values.releaseEnabled !== 'boolean') {
    add('releaseEnabled', 'required', 'Choose whether pickup release is enabled.');
  }

  const latitude = values.pickupLatitude;
  if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
    add('pickupLatitude', 'invalid_coordinate', 'Enter a latitude between -90 and 90.');
  }

  const longitude = values.pickupLongitude;
  if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
    add('pickupLongitude', 'invalid_coordinate', 'Enter a longitude between -180 and 180.');
  }

  const radius = values.pickupRadiusMeters;
  const minimumRadius = values.releaseEnabled === false && options.allowZeroRadiusWhenDisabled ? 0 : 1;
  if (
    !isFiniteNumber(radius) ||
    radius < minimumRadius ||
    radius > 5_000
  ) {
    add(
      'pickupRadiusMeters',
      'invalid_radius',
      minimumRadius === 0
        ? 'Enter a pickup radius from 0 to 5,000 meters while pickup release is disabled.'
        : 'Enter a pickup radius from 1 to 5,000 meters.'
    );
  }

  const lifetime = values.pickupRequestLifetimeMinutes;
  if (!isInteger(lifetime) || lifetime < 1 || lifetime > 180) {
    add('pickupRequestLifetimeMinutes', 'invalid_lifetime', 'Request lifetime must be a whole number from 1 to 180 minutes.');
  }

  const releaseBeforeBell = values.pickupReleaseMinutesBeforeBell;
  if (releaseBeforeBell === undefined || releaseBeforeBell === null) {
    if (options.requirePickupTiming) {
      add('pickupReleaseMinutesBeforeBell', 'required', 'Choose how many minutes before the bell pickup release starts.');
    }
  } else if (!isInteger(releaseBeforeBell) || releaseBeforeBell < 1 || releaseBeforeBell > 60) {
    add('pickupReleaseMinutesBeforeBell', 'invalid_timing', 'Release-before-bell must be a whole number from 1 to 60 minutes.');
  }

  const sessionDuration = values.pickupSessionDurationMinutes;
  if (sessionDuration === undefined || sessionDuration === null) {
    if (options.requirePickupTiming) {
      add('pickupSessionDurationMinutes', 'required', 'Choose a pickup session duration.');
    }
  } else if (!isInteger(sessionDuration) || sessionDuration < 1 || sessionDuration > 240) {
    add('pickupSessionDurationMinutes', 'invalid_timing', 'Session duration must be a whole number from 1 to 240 minutes.');
  }

  return issues;
}

export function getManageSchoolInitialName(school: { name?: unknown }): string {
  return typeof school.name === 'string' ? school.name : '';
}

/** Convert a Firestore record into the Dashboard form model without inventing required values. */
export function serializeManageSchool(
  schoolId: string,
  data: Record<string, unknown>,
  options: SchoolConfigurationOptions = {},
) {
  const model = {
    schoolId,
    name: typeof data.name === 'string' ? data.name : null,
    city: typeof data.city === 'string' ? data.city : '',
    status: typeof data.status === 'string' ? data.status : '',
    timezone: typeof data.timezone === 'string' ? data.timezone : null,
    releaseEnabled: typeof data.releaseEnabled === 'boolean' ? data.releaseEnabled : null,
    pickupLatitude: isFiniteNumber(data.pickupLatitude) ? data.pickupLatitude : null,
    pickupLongitude: isFiniteNumber(data.pickupLongitude) ? data.pickupLongitude : null,
    pickupRadiusMeters: isFiniteNumber(data.pickupRadiusMeters) ? data.pickupRadiusMeters : null,
    pickupRequestLifetimeMinutes: isFiniteNumber(data.pickupRequestLifetimeMinutes) ? data.pickupRequestLifetimeMinutes : null,
    pickupReleaseMinutesBeforeBell: isFiniteNumber(data.pickupReleaseMinutesBeforeBell) ? data.pickupReleaseMinutesBeforeBell : null,
    pickupSessionDurationMinutes: isFiniteNumber(data.pickupSessionDurationMinutes) ? data.pickupSessionDurationMinutes : null,
    studentLimit: Number.isSafeInteger(data.studentLimit) ? data.studentLimit : null,
    activeStudentCount: Number.isSafeInteger(data.activeStudentCount) && Number(data.activeStudentCount) >= 0
      ? Number(data.activeStudentCount)
      : null,
  };

  return {
    ...model,
    configurationIssues: getSchoolConfigurationIssues({ ...data, schoolId: data.schoolId }, { ...options, expectedSchoolId: schoolId }),
  };
}

/** Return only submitted values that belong to the school update contract. */
export function selectManageSchoolPatch(
  submitted: Record<string, unknown>,
): SchoolUpdateValues {
  const patch: SchoolUpdateValues = {};

  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(submitted, field)) {
      const value = submitted[field];
      patch[field] = (field === 'name' || field === 'city' || field === 'timezone') && typeof value === 'string'
        ? value.trim()
        : value;
    }
  }

  return patch;
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
      : field === 'city' && (current[field] === undefined || current[field] === null)
        ? ''
        : current[field];
  }

  return merged;
}
