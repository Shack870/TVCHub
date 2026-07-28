// Live end-to-end test of the DEPLOYED askPostIt callable (2026-07-28).
//
// The callable requires a signed-in Firebase user, so this script:
//   1. creates a throwaway Firebase Auth user via the privileged Identity
//      Toolkit API (gcloud OAuth token — project admin),
//   2. signs in with password (web API key from .env.local) for an ID token,
//   3. POSTs a real question about a REAL post-it to the deployed callable,
//   4. reads the message doc back to confirm the qa turns landed,
//   5. deletes the throwaway user.
//
// Usage: node scripts/askPostItLiveTest-2026-07-28.mjs <messageId> "<question>"

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PROJECT = 'tvchub-f2401';
const REGION = 'us-central1';
const messageId = process.argv[2];
const question = process.argv[3];
if (!messageId || !question) {
  console.error('usage: node askPostItLiveTest-2026-07-28.mjs <messageId> "<question>"');
  process.exit(1);
}

const apiKey = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .match(/^VITE_FIREBASE_API_KEY=(.+)$/m)[1]
  .trim();
const gtoken = execSync('gcloud auth print-access-token').toString().trim();
const gheaders = {
  Authorization: `Bearer ${gtoken}`,
  'Content-Type': 'application/json',
  'x-goog-user-project': PROJECT,
};

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// 1. Throwaway user (privileged create so no sign-up flow is needed).
const email = `askpostit-livetest-${Date.now()}@goironrock.com`;
const password = randomBytes(18).toString('base64url');
const created = await jfetch(
  `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`,
  { method: 'POST', headers: gheaders, body: JSON.stringify({ email, password }) },
);
const localId = created.localId;
console.log('temp user created:', email, localId);

try {
  // 2. Real ID token via password sign-in.
  const signIn = await jfetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );

  // 3. Call the deployed callable.
  console.log(`\nQ: ${question}\n`);
  const t0 = Date.now();
  const result = await jfetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/askPostIt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signIn.idToken}`,
    },
    body: JSON.stringify({ data: { messageId, question } }),
  });
  console.log(`A (${((Date.now() - t0) / 1000).toFixed(1)}s):\n${result.result.answer}\n`);

  // 4. Confirm the qa array landed on the message doc.
  const doc = await jfetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/messages/${messageId}`,
    { headers: gheaders },
  );
  const qa = (doc.fields?.qa?.arrayValue?.values ?? []).map((v) => ({
    role: v.mapValue.fields.role.stringValue,
    ts: Number(v.mapValue.fields.ts.integerValue),
    text: v.mapValue.fields.text.stringValue,
  }));
  console.log(`qa array on messages/${messageId}: ${qa.length} turn(s)`);
  for (const t of qa) {
    console.log(`  [${t.role} @ ${new Date(t.ts).toISOString()}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '…' : ''}`);
  }
} finally {
  // 5. Clean up the throwaway user.
  await jfetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:delete`, {
    method: 'POST',
    headers: gheaders,
    body: JSON.stringify({ localId }),
  });
  console.log('\ntemp user deleted:', localId);
}
