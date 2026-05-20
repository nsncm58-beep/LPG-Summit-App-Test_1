/**
 * LPG Summit — push fan-out as a Firebase Cloud Function.
 *
 * Equivalent to tools/push-sender.js, but runs serverless on Firebase.
 * Triggers on every write to /shared/pushQueue/{id}, fans the message out
 * to every token under /shared/pushTokens, then moves it to /shared/pushSent
 * and removes the queue entry.
 *
 * Deploy:
 *   cd functions
 *   npm install
 *   firebase deploy --only functions:onPushQueueWrite
 *
 * Pick ONE deploy path — this function or tools/push-sender.js — not both,
 * or every message will get sent twice.
 */

const { onValueCreated } = require('firebase-functions/v2/database');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const RTDB_INSTANCE = 'lpgsummittest-3ea64-default-rtdb';

exports.onPushQueueWrite = onValueCreated(
  {
    ref: '/shared/pushQueue/{id}',
    instance: RTDB_INSTANCE,
    region: 'us-central1'
  },
  async (event) => {
    const id = event.params.id;
    const msg = event.data.val() || {};
    const title = msg.title || 'LPG Summit';
    const body  = msg.body  || msg.text || '';

    const db = admin.database();
    const queueRef = db.ref(`shared/pushQueue/${id}`);
    const sentRef  = db.ref(`shared/pushSent/${id}`);
    const tokensRef = db.ref('shared/pushTokens');

    if (!body) {
      logger.warn('Skipping empty push message', id);
      await queueRef.remove();
      return;
    }

    const tokensSnap = await tokensRef.once('value');
    const tokens = [];
    const tokenIndex = [];
    tokensSnap.forEach((userSnap) => {
      const uk = userSnap.key;
      userSnap.forEach((tSnap) => {
        const v = tSnap.val();
        if (v && v.token) {
          tokens.push(v.token);
          tokenIndex.push({ userKey: uk, tokenId: tSnap.key });
        }
      });
    });

    if (tokens.length === 0) {
      logger.info(id, '→ no tokens, archiving');
      await sentRef.set({ ...msg, sentAt: Date.now(), recipients: 0 });
      await queueRef.remove();
      return;
    }

    const messaging = admin.messaging();
    const CHUNK = 500;
    let success = 0, failure = 0;
    const deadIdx = [];

    for (let i = 0; i < tokens.length; i += CHUNK) {
      const slice = tokens.slice(i, i + CHUNK);
      const start = i;
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
            if (code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token' ||
                code === 'messaging/invalid-argument') {
              deadIdx.push(start + j);
            } else {
              logger.warn(id, 'token error', code, r.error.message);
            }
          }
        });
      } catch (e) {
        logger.error(id, 'multicast failed', e);
        failure += slice.length;
      }
    }

    // Prune dead tokens in parallel.
    await Promise.all(deadIdx.map((idx) => {
      const t = tokenIndex[idx];
      if (!t) return Promise.resolve();
      return tokensRef.child(t.userKey).child(t.tokenId).remove().catch(() => {});
    }));

    logger.info(id, `→ sent ${success}/${tokens.length} (${failure} failed, ${deadIdx.length} pruned)`);
    await sentRef.set({
      ...msg,
      sentAt: Date.now(),
      recipients: tokens.length,
      success,
      failure,
      pruned: deadIdx.length
    });
    await queueRef.remove();
  }
);
