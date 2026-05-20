# LPG Summit — Push Cloud Function

Serverless alternative to `../tools/push-sender.js`. Same logic, runs on
Firebase, no machine to keep alive.

## Deploy

```bash
cd functions
npm install
npx firebase login          # once
npx firebase use lpgsummittest-3ea64
npx firebase deploy --only functions:onPushQueueWrite
```

The function triggers on every new child under
`/shared/pushQueue/{id}` in `lpgsummittest-3ea64-default-rtdb`. It reads all
tokens under `/shared/pushTokens`, calls FCM multicast, prunes dead tokens,
writes the result to `/shared/pushSent/{id}`, and removes the queue entry.

## Watch logs

```bash
npx firebase functions:log --only onPushQueueWrite
```

## Pick one — sender OR function

If you also run `tools/push-sender.js`, every message will be sent twice. Pick
whichever you'll actually keep running:

- **Cloud Function** — zero ops, costs pennies, requires a Blaze (pay-as-you-go)
  plan on the Firebase project. Use this if billing is enabled.
- **Node sender** — runs on your laptop or a VM, free, but only fires while
  the process is up. Use this if the project is still on the Spark (free) plan.
