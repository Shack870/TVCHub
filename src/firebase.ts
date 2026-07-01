import { initializeApp } from 'firebase/app';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, type Functions } from 'firebase/functions';

// Firebase config is read from Vite env vars (see .env.example).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId,
);

// These are only ever used after a successful login, which is impossible until
// Firebase is configured. When unconfigured we leave them undefined so the app
// can still boot to the setup screen instead of throwing at import time.
let auth = undefined as unknown as Auth;
let db = undefined as unknown as Firestore;
let storage = undefined as unknown as FirebaseStorage;
let functions = undefined as unknown as Functions;

if (isFirebaseConfigured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  try {
    db = initializeFirestore(app, {
      // Optional fields are often undefined (e.g. a conflict check with no
      // notes). Strip them instead of letting Firestore reject the whole write.
      ignoreUndefinedProperties: true,
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch {
    db = initializeFirestore(app, { ignoreUndefinedProperties: true });
  }
  storage = getStorage(app);
  functions = getFunctions(app);
}

export { auth, db, storage, functions };
