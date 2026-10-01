# Stillwell

Stillwell is a mobile-first personal finance tracker with a clear, quiet dashboard. This project currently runs as an installable local-first web app. Demo records and new entries are stored in this browser using localStorage; there is no cloud account, sync, or backend database yet. Do not use the demo as a secure store for sensitive real-world financial records.

## Run locally

Requires Node.js 18 or newer; no packages are needed.

```sh
npm start
```

Open <http://localhost:4173>. The service worker enables offline shell access on localhost. On a phone connected to the same network, use the computer's LAN address and allow port 4173 through its firewall. For use outside localhost, browsers require HTTPS for PWA installation and service workers.

## Preview deployment

The current app is static and can be previewed on Vercel: install the Vercel CLI, sign in to the intended account, then run `vercel` from this folder and follow its prompts. This only publishes the local-first demo; it does not add secure accounts, cloud storage, or synchronization. No Vercel credentials or deployment URL were available in this workspace, so no deployment was made.

## Use it on a phone

Host the static files on an HTTPS-capable static host, then open its URL in Chrome on Android or Safari on iPhone and use the browser's **Install app** / **Add to Home Screen** action. No native Android or iOS application has been built. Local data stays in that browser profile and does not sync between devices.

## What works

- Responsive dashboard and bottom navigation, light and dark appearance.
- Seeded demo transactions, monthly summary, net-worth snapshot, cash-flow graph, goals, budget plan, insights, and future-value illustrations.
- Quick transaction parsing with a review/edit step; deterministic local classification and calculations.
- Browser-local persistence, transaction filtering and deletion, demo reset, and JSON export.
- Installable web-app manifest and an offline app shell.

## Not connected yet

There is no authentication, PostgreSQL database, cloud synchronization, AI provider, profile image upload, CSV/PDF import, subscriptions scheduler, account aggregator, or deployed URL/build. `.env.example` lists placeholder names only. Those require implementing and provisioning a production backend, choosing providers, and supplying deployment credentials. The parser and Q&A are local heuristics, not an AI integration. Sample balances are a demo snapshot and historical seed transactions are illustrative; do not treat them as reconciled account statements.
