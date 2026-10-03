'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { initDatabase } = require('./db');
const { acquireDatabaseLock } = require('./database-lock');

const CORE_SCHEMA = {
  users: ['id', 'email', 'password_hash', 'salt', 'name', 'created_at'],
  sessions: ['token', 'user_id', 'created_at', 'expires_at'],
  accounts: ['id', 'user_id', 'name', 'type', 'balance', 'created_at'],
  buckets: ['id', 'user_id', 'name', 'type', 'balance', 'target_amount', 'created_at'],
  goals: ['id', 'user_id', 'bucket_id', 'name', 'type', 'target_amount', 'created_at'],
  category_settings: ['id', 'user_id', 'name', 'is_essential'],
  transactions: ['id', 'user_id', 'type', 'amount', 'date', 'description', 'created_at'],
  portfolio_snapshots: ['id', 'user_id', 'kind', 'value', 'as_of', 'created_at'],
  investments: ['id', 'user_id', 'name', 'type', 'invested_amount', 'current_value', 'created_at', 'updated_at'],
  investment_transactions: ['id', 'user_id', 'investment_id', 'type', 'amount', 'date', 'created_at'],
  lending_records: ['id', 'user_id', 'type', 'person_name', 'total_amount', 'outstanding_amount', 'date', 'status', 'created_at', 'updated_at'],
  lending_repayments: ['id', 'user_id', 'lending_id', 'amount', 'date', 'created_at'],
  split_expenses: ['id', 'user_id', 'title', 'total_amount', 'my_share', 'date', 'status', 'created_at'],
  split_participants: ['id', 'split_id', 'user_id', 'name', 'share_amount', 'paid_amount', 'created_at'],
  recurring_commitments: ['id', 'user_id', 'name', 'type', 'amount', 'frequency', 'next_date', 'created_at']
};

const PROFILE_TABLES = ['user_profiles', 'user_preferences', 'profile_avatars'];

function getApplicationSchema() {
  const expected = initDatabase(':memory:');
  try {
    return expected.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      .map(({ name }) => [name, expected.prepare(`PRAGMA table_info(${name})`).all().map(column => column.name)]);
  } finally {
    expected.close();
  }
}

function assertDatabasePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('A database file path is required.');
  const info = fs.lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('The SQLite file is not a non-empty regular file.');
}

function assertNoSqliteSidecars(filePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarPath = `${filePath}${suffix}`;
    if (fs.existsSync(sidecarPath) && fs.statSync(sidecarPath).size > 0) {
      throw new Error('This SQLite file has an active journal sidecar. Close the application that created it and make a fresh backup.');
    }
  }
}

function inspectDatabase(filePath, { requireCurrentSchema = false } = {}) {
  assertDatabasePath(filePath);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error('SQLite integrity validation failed.');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('SQLite foreign-key validation failed.');

    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    for (const [table, requiredColumns] of Object.entries(CORE_SCHEMA)) {
      if (!tables.has(table)) throw new Error(`This file is missing a required WellnessCFO table (${table}).`);
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      const missing = requiredColumns.filter(column => !columns.has(column));
      if (missing.length) throw new Error(`This file has an incompatible WellnessCFO schema (${table}).`);
    }

    const profileTablesPresent = PROFILE_TABLES.filter(table => tables.has(table)).length;
    if (requireCurrentSchema) {
      for (const [table, expectedColumns] of getApplicationSchema()) {
        if (!tables.has(table)) throw new Error(`This file is missing a current WellnessCFO table (${table}).`);
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
        if (expectedColumns.some(column => !columns.has(column))) {
          throw new Error(`This file is missing current WellnessCFO columns (${table}).`);
        }
      }
    }
    return { integrity, tableCount: tables.size, needsAdditiveUpgrade: profileTablesPresent !== PROFILE_TABLES.length };
  } finally {
    db.close();
  }
}

function validateDatabaseFile(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  assertNoSqliteSidecars(absolutePath);
  const inspected = inspectDatabase(absolutePath, options);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wellnesscfo-validate-'));
  const temporaryDatabase = path.join(temporaryDirectory, 'validation.sqlite');
  try {
    fs.copyFileSync(absolutePath, temporaryDatabase, fs.constants.COPYFILE_EXCL);
    const upgraded = initDatabase(temporaryDatabase);
    upgraded.close();
    const upgradedInfo = inspectDatabase(temporaryDatabase, { requireCurrentSchema: true });
    return { ...upgradedInfo, needsAdditiveUpgrade: inspected.needsAdditiveUpgrade };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function quoteSqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createDatabaseBackup(db, destinationPath) {
  const absolutePath = path.resolve(destinationPath);
  if (fs.existsSync(absolutePath)) throw new Error('The backup destination already exists; choose a new filename.');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  try {
    db.exec(`VACUUM INTO ${quoteSqliteString(absolutePath)};`);
    fs.chmodSync(absolutePath, 0o600);
    validateDatabaseFile(absolutePath, { requireCurrentSchema: true });
    return absolutePath;
  } catch (error) {
    try { fs.rmSync(absolutePath, { force: true }); } catch {}
    throw error;
  }
}

function createSnapshotFromFile(sourcePath, destinationPath) {
  const source = new DatabaseSync(sourcePath);
  try {
    return createDatabaseBackup(source, destinationPath);
  } finally {
    source.close();
  }
}

function restoreDatabaseFile({ dbPath, backupPath, safetyBackupPath, confirmed = false }) {
  if (!confirmed) throw new Error('Restore requires explicit confirmation.');
  const databasePath = path.resolve(dbPath);
  const sourceBackupPath = path.resolve(backupPath);
  const safetyPath = path.resolve(safetyBackupPath);
  if (databasePath === sourceBackupPath || databasePath === safetyPath || sourceBackupPath === safetyPath) {
    throw new Error('The database, restore source, and safety backup must be three different files.');
  }
  if (!fs.existsSync(databasePath)) throw new Error('The current database file does not exist; restore was not started.');
  if (fs.existsSync(safetyPath)) throw new Error('The pre-restore safety backup already exists; choose a new filename.');

  const releaseLock = acquireDatabaseLock(databasePath);
  const stagingPath = `${databasePath}.restore-${crypto.randomUUID()}.sqlite`;
  const displacedPath = `${databasePath}.displaced-${crypto.randomUUID()}.sqlite`;
  let currentDisplaced = false;
  let replacementInstalled = false;

  try {
    validateDatabaseFile(sourceBackupPath);
    assertNoSqliteSidecars(databasePath);
    fs.copyFileSync(sourceBackupPath, stagingPath, fs.constants.COPYFILE_EXCL);
    const stagedDb = initDatabase(stagingPath);
    stagedDb.close();
    validateDatabaseFile(stagingPath, { requireCurrentSchema: true });

    createSnapshotFromFile(databasePath, safetyPath);
    fs.renameSync(databasePath, displacedPath);
    currentDisplaced = true;
    fs.renameSync(stagingPath, databasePath);
    replacementInstalled = true;
    validateDatabaseFile(databasePath, { requireCurrentSchema: true });
    fs.rmSync(displacedPath, { force: true });
    currentDisplaced = false;

    return { databasePath, backupPath: sourceBackupPath, safetyBackupPath: safetyPath };
  } catch (error) {
    if (replacementInstalled) {
      try { fs.rmSync(databasePath, { force: true }); } catch {}
    }
    if (currentDisplaced) {
      try { fs.renameSync(displacedPath, databasePath); } catch (restoreError) {
        throw new Error(`Restore failed and automatic rollback also failed. The original is preserved at ${displacedPath}; safety backup: ${safetyPath}. ${restoreError.message}`, { cause: error });
      }
    }
    throw error;
  } finally {
    try { fs.rmSync(stagingPath, { force: true }); } catch {}
    releaseLock();
  }
}

module.exports = { createDatabaseBackup, validateDatabaseFile, restoreDatabaseFile };
