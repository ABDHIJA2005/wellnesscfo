'use strict';

const path = require('node:path');
const { validateDatabaseFile } = require('../server/backup');

const backupPath = process.argv[2];
if (!backupPath || backupPath === '--help') {
  console.log('Usage: node scripts/validate-backup.js <backup.sqlite>');
  process.exit(backupPath ? 0 : 2);
}

try {
  const result = validateDatabaseFile(path.resolve(backupPath));
  console.log(`Backup is readable and passes SQLite integrity/foreign-key checks (${result.tableCount} tables).`);
  if (result.needsAdditiveUpgrade) console.log('This backup uses an older compatible WellnessCFO schema; restore will apply existing additive startup migrations to a staging copy.');
} catch {
  console.error('Backup validation failed. The current database has not been changed.');
  process.exitCode = 1;
}
