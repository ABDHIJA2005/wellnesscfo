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

Passwords are hashed with Node.js `scrypt`. Sessions expire after 30 days and logging out invalidates the active session. SQLite stores only a SHA-256 digest of each random session token; older plaintext sessions are upgraded the next time they are used. Browser sessions use an `HttpOnly`, `SameSite=Lax` cookie; raw session tokens are returned to the test harness only in `NODE_ENV=test`, and the browser does not store bearer tokens in `localStorage`. A temporary dashboard summary cache may remain in browser storage and is cleared on logout. The local HTTP cookie is not marked `Secure`; when running with `NODE_ENV=production`, the cookie is marked `Secure`. This app does not provide multi-currency calculations or cloud object storage.

The local server serves the frontend and API from one origin. Cross-origin API access is not enabled. API errors are generic, request bodies are bounded, and demo-account credentials have been removed from the shipped frontend. The interface uses system fonts and local assets, so it does not fetch third-party resources.

## Local data and backups

The local SQLite file is the authoritative source of truth. By default it is `data/wellnesscfo.db`; set `DB_PATH` to choose another file. The server binds to `127.0.0.1` by default and uses no cloud service or network connection for normal operation. Only one WellnessCFO server may open a database file at a time; a local lock prevents accidental concurrent access. Close the server normally to release the lock. If a process crashes, restart after confirming that no WellnessCFO process is still using the database; a stale lock can then be removed.

Open **Account settings → Download SQLite backup** while signed in. The download is a consistent SQLite snapshot and includes the complete database for this local installation (including all local users), not only the signed-in account. Keep it private, preferably in encrypted storage separate from the computer. Browser download location is controlled by the browser. The application does not encrypt the database or backup files itself; use device encryption and protect exported backups accordingly. Git ignores the local database, SQLite journals, lock files, and backup artifacts.

To restore a backup, first stop WellnessCFO and close any program using its database. Validate the source file without changing the current database:

```sh
node scripts/validate-backup.js "C:/path/to/wellnesscfo-backup.sqlite"
```

Then restore it (the default target is `data/wellnesscfo.db`; use `--database` if the server normally uses a custom `DB_PATH`):

```sh
node scripts/restore-database.js --backup "C:/path/to/wellnesscfo-backup.sqlite"
```

The restore tool refuses while the server holds the database lock, validates the backup and a staging copy, asks you to type `RESTORE`, and retains a timestamped pre-restore safety snapshot under `~/WellnessCFO Backups`. It installs the replacement only after validation and rolls back to the displaced original if final validation fails. Restore does not delete the safety snapshot. Never restore a database while the server is running, and never commit database files or backups.

## Tests

```sh
npm test
```
