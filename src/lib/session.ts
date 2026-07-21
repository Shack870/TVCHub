import { signOut } from 'firebase/auth';
import { auth } from '../firebase';

// Set when we force a sign-out because the persisted session went stale, so
// the login screen can explain why the user landed there. sessionStorage is
// per-tab, which is exactly the scope we want.
const SESSION_EXPIRED_KEY = 'tvchub:session-expired';

export function consumeSessionExpiredNotice(): boolean {
  try {
    const expired = sessionStorage.getItem(SESSION_EXPIRED_KEY) === '1';
    sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    return expired;
  } catch {
    return false;
  }
}

// A realtime listener dying with permission-denied while the UI thinks we're
// signed in usually means the persisted auth session went stale: Firestore
// silently falls back to unauthenticated requests, which the rules (correctly)
// deny. Force a token refresh to find out which case we're in. If the session
// is truly dead, sign out so the auth gate shows the login screen instead of a
// scary error banner; if the refresh works, the caller should resubscribe.
export async function recoverFromPermissionDenied(): Promise<'retry' | 'signed-out'> {
  const user = auth.currentUser;
  if (!user) return 'signed-out';
  try {
    await user.getIdToken(true);
    return 'retry';
  } catch {
    try {
      sessionStorage.setItem(SESSION_EXPIRED_KEY, '1');
    } catch {
      // Best effort — worst case the login screen shows no notice.
    }
    await signOut(auth).catch(() => {});
    return 'signed-out';
  }
}
