'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { restoreDatabaseFile, validateDatabaseFile } = require('../server/backup');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.length < 3) {
    console.log('Usage: node scripts/restore-database.js --backup <backup.sqlite> [--database <database.sqlite>]');
    console.log('Stop WellnessCFO first. Restore requires typing RESTORE and retains a pre-restore safety copy.');
    process.exitCode = process.argv.includes('--help') ? 0 : 2;
    return;
  }

  const backupPath = path.resolve(argument('--backup') || '');
  if (!argument('--backup')) throw new Error('Specify --backup <backup.sqlite>.');
  const databasePath = path.resolve(argument('--database') || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'wellnesscfo.db'));
  const backupFolder = path.join(os.homedir(), 'WellnessCFO Backups');
  fs.mkdirSync(backupFolder, { recursive: true, mode: 0o700 });
  const safetyBackupPath = path.join(backupFolder, `wellnesscfo-pre-restore-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);

  const validation = validateDatabaseFile(backupPath);
  console.log(`Restore source passed SQLite integrity checks (${validation.tableCount} tables).`);
  console.log(`Target database: ${databasePath}`);
  console.log(`A separate pre-restore safety copy will be kept at: ${safetyBackupPath}`);
  console.log('This replaces the current database. Close WellnessCFO and all apps using the database before continuing.');
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question('Type RESTORE to continue: ');
    if (answer !== 'RESTORE') {
      console.log('Restore cancelled.');
      return;
    }
  } finally {
    prompt.close();
  }

  const result = restoreDatabaseFile({ dbPath: databasePath, backupPath, safetyBackupPath, confirmed: true });
  console.log('Restore completed and the restored database passed integrity checks.');
  console.log(`Safety copy: ${result.safetyBackupPath}`);
}

main().catch(() => {
  console.error('Restore failed or was refused. The original database is preserved unless the tool explicitly reported successful completion.');
  process.exitCode = 1;
});
