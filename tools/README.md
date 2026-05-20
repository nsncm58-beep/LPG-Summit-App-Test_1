# LPG Summit — Push Sender

Long-running Node.js process that fans broadcast messages out to every attendee
who has push enabled.

## How it fits together

```
Staff member sends a broadcast in the app
  → app writes to Firebase RTDB at /shared/lpg-broadcasts (in-app feed)
  → app ALSO writes to /shared/pushQueue/{id}   ← this script picks it up
  → push-sender.js reads /shared/pushTokens, sends FCM to each token
  → message moves to /shared/pushSent/{id} and queue entry is removed
```

The app itself never touches FCM Admin or VAPID private keys. Those live only
on whatever machine runs `push-sender.js`.

## Setup (once)

1. **Get a service account key.**
   Firebase Console → ⚙️ Project Settings → **Service accounts** tab →
   *Generate new private key*. Save the downloaded JSON as
   `tools/service-account.json` (already gitignored — never commit it).

2. **Install dependencies.**
   ```bash
   cd "tools"
   npm install
   ```

## Running

```bash
node push-sender.js
```

Leave it running for the duration of the summit. It logs every fan-out, e.g.

```
[push-sender] Connected to https://lpgsummittest-3ea64-default-rtdb.firebaseio.com
[push-sender] Listening on /shared/pushQueue …
[push-sender] 1716147300000 → sent 42/45 (3 failed, 3 pruned)
```

### Run it as a background service

Easiest options:

- **tmux / screen** — `tmux new -s push 'node push-sender.js'`, detach with `Ctrl-B D`.
- **pm2** — `npm i -g pm2 && pm2 start push-sender.js --name lpg-push`.
- **systemd** (Linux) — drop a `lpg-push.service` unit that runs `node /opt/lpg-push/push-sender.js`.

If the script dies, the RTDB queue is durable: any messages added while it was
down will still be there when it restarts (it processes them in order).

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./service-account.json` | Path to the service account JSON. |
| `LPG_RTDB_URL` | `https://lpgsummittest-3ea64-default-rtdb.firebaseio.com` | RTDB endpoint. Change if you swap Firebase projects. |

## What it does on each message

For every entry written under `/shared/pushQueue`:

1. Reads every token under `/shared/pushTokens/{userKey}/{tokenId}`.
2. Calls `messaging.sendEachForMulticast()` in chunks of 500.
3. Counts success / failure. Tokens that come back as
   `registration-token-not-registered` get deleted (the user uninstalled, the
   token expired, or the OS evicted it).
4. Writes a record under `/shared/pushSent/{id}` with `success`, `failure`,
   `recipients`, `pruned` counts.
5. Removes the queue entry so the same message isn't sent twice.

## Alternative: Cloud Function

If you'd rather not run a Node process yourself, see `../functions/` — it has
an equivalent Firebase Cloud Function that runs server-side on every
`/shared/pushQueue` write. Pick one path, not both.

## Troubleshooting

- **`Missing service account JSON`** → step 1 above.
- **`PERMISSION_DENIED at /shared/pushTokens`** → your RTDB rules don't grant
  the service account access. Service accounts bypass rules by default, so
  this usually means the wrong service account file or wrong project.
- **`auth/invalid-credential`** → the service account JSON is for a different
  project than `LPG_RTDB_URL` points at.
- **App shows "Not configured yet"** → set `window.LPG_VAPID_KEY` in
  `index.html`. The VAPID public key (Firebase Console → Cloud Messaging →
  Web Push certificates) goes in the app; the service account JSON goes here.
