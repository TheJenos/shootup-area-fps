import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { getDatabase, connectDatabaseEmulator, forceWebSockets, type Database } from 'firebase/database';
import { IN_DISCORD } from '../discord/patch';

const env = import.meta.env;
const useEmulator = env.VITE_FIREBASE_EMULATOR === 'true';

const config: FirebaseOptions = useEmulator
  ? { projectId: 'demo-fps', databaseURL: 'http://127.0.0.1:9000?ns=demo-fps' }
  : {
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      databaseURL: env.VITE_FIREBASE_DATABASE_URL,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID,
    };

export const isConfigured = Boolean(config.databaseURL);

// After a WebSocket that never got healthy (e.g. the Activity was closed mid-connect), Firebase
// starts the next session with long-polling, which loads <script> tags from the database host.
// Discord's proxy can't reroute those and its CSP blocks them, so every read hangs. Never poll.
if (IN_DISCORD) forceWebSockets();

const instance: Database | null = isConfigured ? getDatabase(initializeApp(config)) : null;

if (instance && useEmulator) connectDatabaseEmulator(instance, '127.0.0.1', 9000);

/** The database; only call this when `isConfigured` is true. */
export function db(): Database {
  if (!instance) throw new Error('Firebase is not configured');
  return instance;
}
