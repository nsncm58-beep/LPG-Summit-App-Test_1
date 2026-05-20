#!/usr/bin/env node
/**
 * LPG Summit — push fan-out sender.
 *
 * Watches Firebase Realtime Database at /shared/pushQueue for new broadcasts,
 * sends them to every token under /shared/pushTokens via FCM Admin SDK, then
 * moves the message to /shared/pushSent and prunes dead tokens.
 *
 * Run on any machine with Node 18+. Long-running process — use pm2, a systemd
 * service, or just `node push-sender.js` in a tmux session.
 *
 * Setup:
 *   1. Firebase Console → Project Settings → Service accounts → Generate new
 *      private key. Save as ./service-account.json (gitignored).
 *   2. npm install
 *   3. node push-sender.js
 *
 * Env vars (optional):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json (overrides ./service-account.json)
 *   LPG_RTDB_URL=https://lpgsummittest-3ea64-default-rtdb.firebaseio.com (overrides default)
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const RTDB_URL = process.env.LPG_RTDB_URL || 'https://lpgsummittest-3ea64-default-rtdb.firebaseio.com';

// Locate the service account JSON. Prefer GOOGLE_APPLICATION_CREDENTIALS if set,
// otherwise look for ./service-account.json next to this script.
let credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  const local = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(local)) credPath = local;
}
if (!credPath || !fs.existsSync(credPath)) {
  console.error('[push-sender] Missing service account JSON.');
  console.error('  Put it at ./service-account.json or set GOOGLE_APPLICATION_CREDENTIALS.');
  console.error('  Generate one at: Firebase Console → Project Settings → Service accounts → Generate new private key');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(credPath)),
  databaseURL: RTDB_URL
});

const db = admin.database();
const messaging = admin.messaging();

const QUEUE = db.ref('shared/pushQueue');
const SENT  = db.ref('shared/pushSent');
const TOKENS = db.ref('shared/pushTokens');

console.log('[push-sender] Connected to', RTDB_URL);
console.log('[push-sender] Listening on /shared/pushQueue …');

// Track in-flight ids so a node disconnect/reconnect doesn't double-send within
// the same process lifetime. Firebase de-dupes child_added across reconnects
// once the value matches, but a transient retry on the same snapshot can happen.
const inFlight = new Set();

QUEUE.on('child_added', async (snap) => {
  const id = snap.key;
  if (inFlight.has(id)) return;
  inFlight.add(id);

  const msg = snap.val() || {};
  const title = msg.title || 'LPG Summit';
  const body  = msg.body  || msg.text || '';
  if (!body) {
    console.warn('[push-sender] Skipping empty message', id);
    await snap.ref.remove();
    inFlight.delete(id);
    return;
  }

  // Gather every token across every user.
  let tokensSnap;
  try {
    tokensSnap = await TOKENS.once('value');
  } catch (e) {
    console.error('[push-sender] Failed to read tokens', e);
    inFlight.delete(id);
    return;
  }
  const tokens = [];
  const tokenIndex = []; // parallel array: { userKey, tokenId, token }
  tokensSnap.forEach((userSnap) => {
    const uk = userSnap.key;
    userSnap.forEach((tSnap) => {
      const v = tSnap.val();
      if (v && v.token) {
        tokens.push(v.token);
        tokenIndex.push({ userKey: uk, tokenId: tSnap.key, token: v.token });
      }
    });
  });

  if (tokens.length === 0) {
    console.log('[push-sender]', id, '→ no tokens, archiving');
    await SENT.child(id).set({ ...msg, sentAt: Date.now(), recipients: 0 });
    await snap.ref.remove();
    inFlight.delete(id);
    return;
  }

  // FCM caps multicast at 500 tokens per call. Chunk it.
  const CHUNK = 500;
  let success = 0, failure = 0;
  const deadTokenIdx = [];
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const slice = tokens.slice(i, i + CHUNK);
    const sliceStart = i;
    try {
      const resp = await messaging.sendEachForMulticast({
        tokens: slice,
        notification: { title, body },
        data: {
          id: String(id),
          by: String(msg.by || ''),
          at: String(msg.at || ''),
          body: String(body)
        },
        webpush: {
          fcmOptions: { link: '/' },
          notification: { icon: 'icon-192.png', badge: 'icon-192.png' }
        }
      });
      success += resp.successCount;
      failure += resp.failureCount;
      resp.responses.forEach((r, j) => {
        if (!r.success && r.error) {
          const code = r.error.code || '';
          // Token no longer valid — schedule for cleanup.
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token' ||
              code === 'messaging/invalid-argument') {
            deadTokenIdx.push(sliceStart + j);
          } else {
            console.warn('[push-sender]', id, 'token error', code, r.error.message);
          }
        }
      });
    } catch (e) {
      console.error('[push-sender]', id, 'multicast failed', e);
      failure += slice.length;
    }
  }

  // Prune dead tokens.
  for (const idx of deadTokenIdx) {
    const t = tokenIndex[idx];
    if (!t) continue;
    try { await TOKENS.child(t.userKey).child(t.tokenId).remove(); } catch(_){}
  }

  console.log('[push-sender]', id, `→ sent ${success}/${tokens.length} (${failure} failed, ${deadTokenIdx.length} pruned)`);
  await SENT.child(id).set({
    ...msg,
    sentAt: Date.now(),
    recipients: tokens.length,
    success,
    failure,
    pruned: deadTokenIdx.length
  });
  await snap.ref.remove();
  inFlight.delete(id);
});

QUEUE.on('child_removed', (snap) => { inFlight.delete(snap.key); });

process.on('SIGINT',  () => { console.log('[push-sender] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[push-sender] Shutting down'); process.exit(0); });
