# WellnessCFO

WellnessCFO is a server-backed personal finance dashboard with deterministic financial calculations and an editorial, responsive interface.

## Run locally

Use a supported Node.js release with the built-in `node:sqlite` module:

```sh
npm start
```

Then open <http://localhost:3000>. The server stores application data in `data/wellnesscfo.db` by default. Set `DB_PATH` to use a different SQLite file and `PORT` to use a different port.

## Profile and privacy

Profile and preference records are kept in separate SQLite tables from financial activity. Profile photos accept PNG, JPEG, and WebP files up to 512 KB and are stored in a separate user-scoped table. Email is read-only in profile settings. INR is the only supported calculation currency; the date display preference is saved per account.

Passwords are hashed with Node.js `scrypt`. Sessions expire after 30 days and logging out invalidates the active session. Browser sessions use an `HttpOnly`, `SameSite=Lax` cookie; the browser no longer stores the bearer token in `localStorage`. A temporary dashboard summary cache may remain in browser storage and is cleared on logout. The local HTTP development cookie is not marked `Secure`; production startup is deliberately blocked until a PostgreSQL data layer is configured. This app does not provide multi-currency calculations or cloud object storage.

The server serves the frontend and API from one origin. Cross-origin API access is not enabled. Production API errors are generic, request bodies are bounded, and the legacy browser-data migration endpoint is disabled in production. Demo-account credentials have been removed from the shipped frontend.

## Tests

```sh
npm test -- --runInBand
```
