import {
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app';
import {
  getAuth,
  type Auth,
} from 'firebase-admin/auth';
import {
  getFirestore,
  type Firestore,
} from 'firebase-admin/firestore';

let adminApp: App | undefined;

type FirebaseServiceAccount = {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function parseServiceAccount(): FirebaseServiceAccount {
  const encoded =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (encoded) {
    try {
      const decoded = Buffer.from(
        encoded.trim(),
        'base64',
      ).toString('utf8');

      return JSON.parse(decoded) as FirebaseServiceAccount;
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid Base64-encoded JSON.',
      );
    }
  }

  const rawJson =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (rawJson) {
    try {
      return JSON.parse(rawJson) as FirebaseServiceAccount;
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
      );
    }
  }

  throw new Error(
    'Firebase service-account credentials are not configured.',
  );
}

function getFirebaseAdminApp(): App {
  if (adminApp) {
    return adminApp;
  }

  const existingApps = getApps();

  if (existingApps.length > 0) {
    adminApp = existingApps[0];
    return adminApp;
  }

  const serviceAccount = parseServiceAccount();

  if (
    !serviceAccount.project_id ||
    !serviceAccount.client_email ||
    !serviceAccount.private_key
  ) {
    throw new Error(
      'Firebase service account is missing required fields.',
    );
  }

  const privateKey = serviceAccount.private_key.replace(
    /\\n/g,
    '\n',
  );

  adminApp = initializeApp({
    credential: cert({
      projectId: serviceAccount.project_id,
      clientEmail: serviceAccount.client_email,
      privateKey,
    }),
    projectId:
      process.env.FIREBASE_PROJECT_ID ||
      serviceAccount.project_id,
  });

  return adminApp;
}

export function getAdminAuth(): Auth {
  return getAuth(getFirebaseAdminApp());
}

export function getAdminDb(): Firestore {
  return getFirestore(getFirebaseAdminApp());
}