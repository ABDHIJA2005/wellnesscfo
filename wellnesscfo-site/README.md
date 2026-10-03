# WellnessCFO

WellnessCFO is a server-backed personal finance dashboard with deterministic financial calculations and an editorial, responsive interface.

## Run locally

WellnessCFO is a local-first application. The local SQLite database is the authoritative store; the server, frontend, and financial calculations run on your computer without a cloud account or internet connection. Use a supported Node.js release with the built-in `node:sqlite` module:

```sh
npm start
```

Then open <http://localhost:3000>. The server stores application data in `data/wellnesscfo.db` by default. Set `DB_PATH` to use a different SQLite file and `PORT` to use a different port.

## Profile and privacy

Profile and preference records are kept in separate SQLite tables from financial activity. Profile photos accept PNG, JPEG, and WebP files up to 512 KB and are stored in a separate user-scoped table. Email is read-only in profile settings. INR is the only supported calculation currency; the date display preference is saved per account.

Passwords are hashed with Node.js `scrypt`. Sessions expire after 30 days and logging out invalidates the active session. Browser sessions use an `HttpOnly`, `SameSite=Lax` cookie; the browser no longer stores the bearer token in `localStorage`. A temporary dashboard summary cache may remain in browser storage and is cleared on logout. The local HTTP cookie is not marked `Secure`; when running with `NODE_ENV=production`, the cookie is marked `Secure`. This app does not provide multi-currency calculations or cloud object storage.

The local server serves the frontend and API from one origin. Cross-origin API access is not enabled. API errors are generic, request bodies are bounded, and demo-account credentials have been removed from the shipped frontend. The interface uses system fonts and local assets, so it does not fetch third-party resources.

## Local data and backups

The default database is `data/wellnesscfo.db`; set `DB_PATH` to choose another local file. To back up or restore the database file, stop the WellnessCFO server first, then copy the database file to or from a safe location. Keep backups private because they contain personal financial records. Do not commit the database or its backups to Git.

## Tests

```sh
npm test -- --runInBand
```
