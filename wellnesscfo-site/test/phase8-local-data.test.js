'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initDatabase } = require('../server/db');
const { createDatabaseBackup, validateDatabaseFile, restoreDatabaseFile } = require('../server/backup');
const { acquireDatabaseLock } = require('../server/database-lock');
const { hashPassword, createSession, getUserFromSession } = require('../server/auth');
const {
  setupDefaultEntities, recordTransaction, recordAccountTransfer, recordBucketTransfer,
  recordInvestment, recordLending, recordLendingRepayment, recordRecurringCommitment,
  postRecurringToLedger
} = require('../server/financial-engine');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wellnesscfo-phase8-'));
const databasePath = path.join(directory, 'wellnesscfo.sqlite');
const backupPath = path.join(directory, 'backup.sqlite');
const safetyPath = path.join(directory, 'pre-restore.sqlite');
let db = null;

function open() { return initDatabase(databasePath); }

try {
  db = open();
  const password = hashPassword('synthetic-test-password');
  db.prepare('INSERT INTO users (id,email,password_hash,salt,name,created_at) VALUES (?,?,?,?,?,?)')
    .run('phase8-user', 'phase8@example.invalid', password.hash, password.salt, 'Synthetic Phase 8', new Date().toISOString());
  setupDefaultEntities(db, 'phase8-user');
  const accounts = db.prepare('SELECT id, type FROM accounts WHERE user_id = ?').all('phase8-user');
  const account = accounts.find(row => row.type === 'bank').id;
  const cash = accounts.find(row => row.type === 'cash').id;
  db.prepare('UPDATE accounts SET balance=5000 WHERE id=?').run(account); // Synthetic opening balance.
  const buckets = db.prepare('SELECT id, type FROM buckets WHERE user_id = ?').all('phase8-user');
  const savings = buckets.find(row => row.type === 'savings').id;
  const investmentsBucket = buckets.find(row => row.type === 'investments').id;
  db.prepare('UPDATE buckets SET balance=5000 WHERE id=?').run(savings);
  recordTransaction(db, 'phase8-user', { type: 'income', amount: 42000, date: '2026-10-01', description: 'Synthetic salary', account_id: account });
  recordTransaction(db, 'phase8-user', { type: 'expense', amount: 6500, date: '2026-10-02', description: 'Synthetic groceries', account_id: account });
  recordAccountTransfer(db, 'phase8-user', { fromAccountId: account, toAccountId: cash, amount: 2000, date: '2026-10-03' });
  recordBucketTransfer(db, 'phase8-user', { fromBucketId: savings, toBucketId: investmentsBucket, amount: 1200, date: '2026-10-03' });
  const investment = recordInvestment(db, 'phase8-user', { name: 'Synthetic Index', account_id: account, invested_amount: 12000, current_value: 12500 });
  const lending = recordLending(db, 'phase8-user', { personName: 'Synthetic Contact', amount: 3000, accountId: account, date: '2026-10-03' });
  recordLendingRepayment(db, 'phase8-user', { lendingId: lending.id, amount: 500, accountId: account, date: '2026-10-04' });
  const commitment = recordRecurringCommitment(db, 'phase8-user', { name: 'Synthetic subscription', type: 'subscription', amount: 800, frequency: 'monthly', nextDate: '2026-10-05', accountId: account });
  postRecurringToLedger(db, 'phase8-user', commitment.id, '2026-10-05');
  const beforeBackup = {
    accountBalances: db.prepare('SELECT id, balance FROM accounts WHERE user_id=? ORDER BY id').all('phase8-user'),
    bucketBalances: db.prepare('SELECT id, balance FROM buckets WHERE user_id=? ORDER BY id').all('phase8-user'),
    transactions: db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id=?').get('phase8-user').count,
    goalCount: db.prepare('SELECT COUNT(*) AS count FROM goals WHERE user_id=?').get('phase8-user').count,
    investmentCount: db.prepare('SELECT COUNT(*) AS count FROM investments WHERE user_id=?').get('phase8-user').count,
    investmentValue: db.prepare('SELECT SUM(current_value) AS amount FROM investments WHERE user_id=?').get('phase8-user').amount,
    lendingOutstanding: db.prepare('SELECT SUM(outstanding_amount) AS amount FROM lending_records WHERE user_id=?').get('phase8-user').amount,
    nextCommitmentDate: db.prepare('SELECT next_date FROM recurring_commitments WHERE id=?').get(commitment.id).next_date
  };
  assert.equal(beforeBackup.transactions, 7);
  assert.equal(beforeBackup.goalCount, 4);
  assert.equal(beforeBackup.investmentCount, 1);
  assert.equal(beforeBackup.investmentValue, 12500);
  assert.equal(beforeBackup.lendingOutstanding, 2500);
  assert.notEqual(beforeBackup.nextCommitmentDate, '2026-10-05', 'Recurring post advances the next date together with its ledger write');
  assert.ok(investment);

  const token = createSession(db, 'phase8-user').token;
  let storedToken = db.prepare('SELECT token FROM sessions WHERE user_id=?').get('phase8-user').token;
  assert.notEqual(storedToken, token, 'Session table stores only a token digest');
  assert.equal(getUserFromSession(db, token).id, 'phase8-user');
  const legacyToken = 'a'.repeat(64);
  db.prepare('UPDATE sessions SET token=? WHERE token=?').run(legacyToken, storedToken);
  assert.equal(getUserFromSession(db, legacyToken).id, 'phase8-user', 'Legacy plaintext session remains valid during upgrade');
  storedToken = crypto.createHash('sha256').update(legacyToken).digest('hex');
  assert.equal(db.prepare('SELECT token FROM sessions WHERE user_id=?').get('phase8-user').token, storedToken, 'Legacy session is replaced with its digest');
  const expiredToken = 'b'.repeat(64);
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(crypto.createHash('sha256').update(expiredToken).digest('hex'), 'phase8-user', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
  assert.equal(getUserFromSession(db, expiredToken), null, 'Expired session is rejected');

  createDatabaseBackup(db, backupPath);
  assert.equal(validateDatabaseFile(backupPath, { requireCurrentSchema: true }).integrity, 'ok');
  fs.writeFileSync(`${backupPath}-wal`, 'synthetic active WAL');
  assert.throws(() => validateDatabaseFile(backupPath), /journal sidecar/);
  fs.rmSync(`${backupPath}-wal`);
  recordTransaction(db, 'phase8-user', { type: 'expense', amount: 300, date: '2026-10-03', description: 'After backup change', account_id: account });
  db.close();
  db = null;

  assert.throws(() => restoreDatabaseFile({ dbPath: databasePath, backupPath, safetyBackupPath: safetyPath }), /explicit confirmation/);
  const release = acquireDatabaseLock(databasePath);
  assert.throws(() => acquireDatabaseLock(databasePath), /already open/);
  release();
  const result = restoreDatabaseFile({ dbPath: databasePath, backupPath, safetyBackupPath: safetyPath, confirmed: true });
  assert.equal(result.safetyBackupPath, safetyPath);
  assert.equal(validateDatabaseFile(databasePath, { requireCurrentSchema: true }).integrity, 'ok');

  db = open();
  assert.deepEqual(db.prepare('SELECT id, balance FROM accounts WHERE user_id=? ORDER BY id').all('phase8-user'), beforeBackup.accountBalances);
  assert.deepEqual(db.prepare('SELECT id, balance FROM buckets WHERE user_id=? ORDER BY id').all('phase8-user'), beforeBackup.bucketBalances);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id=?').get('phase8-user').count, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM goals WHERE user_id=?').get('phase8-user').count, beforeBackup.goalCount);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM investments WHERE user_id=?').get('phase8-user').count, 1);
  assert.equal(db.prepare('SELECT SUM(current_value) AS amount FROM investments WHERE user_id=?').get('phase8-user').amount, beforeBackup.investmentValue);
  assert.equal(db.prepare('SELECT SUM(outstanding_amount) AS amount FROM lending_records WHERE user_id=?').get('phase8-user').amount, beforeBackup.lendingOutstanding);
  assert.equal(db.prepare('SELECT next_date FROM recurring_commitments WHERE id=?').get(commitment.id).next_date, beforeBackup.nextCommitmentDate);
  assert.equal(db.prepare('SELECT token FROM sessions WHERE user_id=?').get('phase8-user').token, storedToken);
  db.close();
  db = null;

  const safety = initDatabase(safetyPath);
  assert.equal(safety.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id=?').get('phase8-user').count, 8, 'Pre-restore safety backup retains the overwritten state');
  safety.close();

  const corruptPath = path.join(directory, 'corrupt.sqlite');
  fs.writeFileSync(corruptPath, 'not a database');
  assert.throws(() => validateDatabaseFile(corruptPath));
  assert.throws(() => restoreDatabaseFile({ dbPath: databasePath, backupPath: corruptPath, safetyBackupPath: path.join(directory, 'must-not-exist.sqlite'), confirmed: true }));
  fs.writeFileSync(`${databasePath}-wal`, 'synthetic active WAL');
  assert.throws(() => restoreDatabaseFile({ dbPath: databasePath, backupPath, safetyBackupPath: path.join(directory, 'sidecar-blocked.sqlite'), confirmed: true }), /journal sidecar/);
  fs.rmSync(`${databasePath}-wal`);
  db = open();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id=?').get('phase8-user').count, 7, 'Invalid restore source leaves the live database unchanged');

  db.exec(`CREATE TRIGGER fail_initial_investment BEFORE INSERT ON investment_transactions
    WHEN NEW.notes = 'Initial investment record' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
  assert.throws(() => recordInvestment(db, 'phase8-user', { name: 'Should rollback', account_id: account, invested_amount: 1000 }));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM investments WHERE name='Should rollback'").get().count, 0, 'Investment and ledger writes roll back together');
  db.close();
  db = null;

  console.log('✓ Local data safety: hashed sessions, consistent backup, explicit restore, safety copy, validation, lock, and atomic investment write');
} finally {
  if (db) db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
