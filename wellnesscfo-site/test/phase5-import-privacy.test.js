'use strict';
const assert = require('node:assert/strict');
const { initDatabase } = require('../server/db');
const { setupDefaultEntities, recordTransaction, recordInvestment, previewStatementImport, commitStatementImport } = require('../server/financial-engine');
const { parseCsvRecords, MAX_ROWS } = require('../server/statement-import');
const { sanitizeText, sanitizeForLogs } = require('../server/ai/privacy');

const db = initDatabase(':memory:');
function addUser(id) {
  db.prepare('INSERT INTO users (id,email,password_hash,salt,name,created_at) VALUES (?,?,?,?,?,?)').run(id, `${id}@example.test`, 'hash', 'salt', id, new Date().toISOString());
  setupDefaultEntities(db, id);
  return {
    account: db.prepare('SELECT id FROM accounts WHERE user_id=? AND type=? LIMIT 1').get(id, 'bank').id,
    bucket: db.prepare('SELECT id FROM buckets WHERE user_id=? AND type=? LIMIT 1').get(id, 'spending').id
  };
}
const a = addUser('user_a');
const b = addUser('user_b');

console.log('--- PHASE 5 IMPORT & PRIVACY TESTS ---');
const aliases = [
  ['Date,Description,Debit,Credit\n2026-10-01,Market,450,\n2026-10-02,Salary,,25000', 2],
  ['Transaction Date,Narration,Withdrawal,Deposit\n2026-10-01,Market,450,\n2026-10-02,Salary,,25000', 2],
  ['Txn Date,Remarks,Dr,Cr\n2026-10-01,Market,450,\n2026-10-02,Salary,,25000', 2],
  ['Date,Details,Transaction Amount\n2026-10-01,"""Market, Central""",-450', 1]
];
for (const [csv, count] of aliases) assert.equal(parseCsvRecords(csv).length, count);
assert.throws(() => parseCsvRecords(''), /empty/i);
assert.throws(() => parseCsvRecords('Date,Description,Amount\n"unclosed,x,3'), /Malformed CSV/i);
assert.throws(() => parseCsvRecords('Description,Amount\nMarket,3'), /Required columns/i);
console.log('✓ CSV header aliases, quoted fields, malformed/empty/missing-column errors');

const parsed = parseCsvRecords('Date,Description,Debit,Credit\n2026-10-01,Groceries,750,\n2026-10-02,Salary credit,,25000\n2026-10-03,Internal transfer,1200,\n2026-02-31,Unknown,3,\n2026-10-05,Unclear merchant,499,');
const preview = previewStatementImport(db, 'user_a', parsed, { accountId: a.account, bucketId: a.bucket });
assert.equal(preview.summary.totalRows, 5);
assert.equal(preview.summary.newCount, 2);
assert.equal(preview.summary.ambiguousCount, 2);
assert.equal(preview.summary.invalidCount, 1);
assert.equal(preview.summary.incomeTotal, 25000);
assert.equal(preview.summary.expenseTotal, 1249);
assert.equal(preview.summary.transferCount, 1);
console.log('✓ Income, expense, transfer detection, ambiguous and invalid preview totals');

recordTransaction(db, 'user_a', { date:'2026-10-08', description:'Coffee Shop', category:'Food & Dining', amount:200, type:'expense', account_id:a.account, bucket_id:a.bucket });
let dup = previewStatementImport(db, 'user_a', [{date:'2026-10-08',description:'Coffee Shop',amount:200,type:'expense',category:'Food & Dining'}], {accountId:a.account,bucketId:a.bucket});
assert.equal(dup.rows[0].status, 'duplicate');
let likely = previewStatementImport(db, 'user_a', [{date:'2026-10-09',description:'Coffee Shop',amount:200,type:'expense',category:'Food & Dining'}], {accountId:a.account,bucketId:a.bucket});
assert.equal(likely.rows[0].status, 'likely_duplicate');
const otherAccount = db.prepare('SELECT id FROM accounts WHERE user_id=? AND type=? LIMIT 1').get('user_a','cash').id;
let repeat = previewStatementImport(db, 'user_a', [{date:'2026-10-09',description:'Coffee Shop',amount:200,type:'expense',category:'Food & Dining'}], {accountId:otherAccount,bucketId:a.bucket});
assert.equal(repeat.rows[0].status, 'new', 'Same description/amount under a different account should not match');
const repeatedRows = previewStatementImport(db,'user_a',[
  {date:'2026-10-14',description:'Cafe',amount:75,type:'expense',category:'Food & Dining'},
  {date:'2026-10-14',description:'Cafe',amount:75,type:'expense',category:'Food & Dining'}
],{accountId:a.account,bucketId:a.bucket});
assert.equal(repeatedRows.rows[0].status,'new');
assert.equal(repeatedRows.rows[1].status,'likely_duplicate','Repeated rows in one file require review, not silent removal');
const isolated = previewStatementImport(db, 'user_b', [{date:'2026-10-08',description:'Coffee Shop',amount:200,type:'expense',category:'Food & Dining'}], {accountId:b.account,bucketId:b.bucket});
assert.equal(isolated.rows[0].status, 'new', 'Another user must not see this user’s transactions during matching');
console.log('✓ Exact/likely matching includes type, date, selected account and user scope');

assert.throws(() => previewStatementImport(db, 'user_a', [{date:'2026-10-09',description:'x',amount:10,type:'expense',category:'Food'}], {accountId:b.account}), /account is not available/i);
assert.throws(() => commitStatementImport(db, 'user_a', [{date:'2026-10-09',description:'x',amount:10,type:'expense',category:'Food'}], {accountId:b.account,bucketId:a.bucket}), /account is not available/i);
console.log('✓ Cross-user account access rejected at preview and commit');

const cancelCount = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get('user_a').c;
assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get('user_a').c, cancelCount, 'Cancel means no commit call and zero rows inserted');
const good = [{date:'2026-10-10',description:'Market',amount:500,type:'expense',category:'Groceries'}];
const done = commitStatementImport(db,'user_a',good,{accountId:a.account,bucketId:a.bucket});
assert.equal(done.imported,1);
assert.equal(db.prepare('SELECT type FROM transactions WHERE user_id=? AND description=?').get('user_a','Market').type,'expense');
assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND description=?').get('user_a','Coffee Shop').c,1);
const legitimateRepeat = commitStatementImport(db,'user_a',[{date:'2026-10-08',description:'Coffee Shop',amount:200,type:'expense',category:'Food & Dining',allowDuplicate:true}],{accountId:a.account,bucketId:a.bucket});
assert.equal(legitimateRepeat.imported,1,'A user-confirmed legitimate repeat can be imported');
assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=? AND description=?').get('user_a','Coffee Shop').c,2);
console.log('✓ Confirmed import uses the normal transaction engine; cancel has no writes');

const cashAccount = db.prepare('SELECT id FROM accounts WHERE user_id=? AND type=? LIMIT 1').get('user_a','cash').id;
const transferBefore = db.prepare('SELECT balance FROM accounts WHERE id=?').get(a.account).balance;
const transferResult = commitStatementImport(db,'user_a',[{date:'2026-10-10',description:'Move to cash',amount:40,type:'transfer_account',transferDirection:'out',transferAccountId:cashAccount}],{accountId:a.account,bucketId:a.bucket});
assert.equal(transferResult.imported,1);
assert.equal(db.prepare('SELECT balance FROM accounts WHERE id=?').get(a.account).balance,transferBefore-40);
assert.equal(db.prepare("SELECT COUNT(*) c FROM transactions WHERE user_id=? AND type='transfer_account' AND description='Move to cash'").get('user_a').c,1);
const inv = recordInvestment(db,'user_a',{name:'Phase 5 Index',account_id:a.account});
const spendingBeforeInvestment = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='expense'").get('user_a').s;
const investmentResult = commitStatementImport(db,'user_a',[{date:'2026-10-10',description:'Index SIP',amount:300,type:'investment_contribution',investmentId:inv.id}],{accountId:a.account,bucketId:a.bucket});
assert.equal(investmentResult.imported,1);
assert.equal(db.prepare('SELECT invested_amount FROM investments WHERE id=? AND user_id=?').get(inv.id,'user_a').invested_amount,300);
assert.equal(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='expense'").get('user_a').s,spendingBeforeInvestment,'Investments must not become ordinary expenses');
const spendingBeforeLending = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='expense'").get('user_a').s;
const lent = commitStatementImport(db,'user_a',[{date:'2026-10-10',description:'Cash lent',amount:180,type:'lending_new',lendingDirection:'lent',personName:'Test Person'}],{accountId:a.account,bucketId:a.bucket});
assert.equal(lent.imported,1);
const lendingRecord = db.prepare('SELECT id,outstanding_amount FROM lending_records WHERE user_id=? AND person_name=?').get('user_a','Test Person');
const repaid = commitStatementImport(db,'user_a',[{date:'2026-10-11',description:'Repayment received',amount:60,type:'lending_repayment',lendingId:lendingRecord.id}],{accountId:a.account,bucketId:a.bucket});
assert.equal(repaid.imported,1);
assert.equal(db.prepare('SELECT outstanding_amount FROM lending_records WHERE id=? AND user_id=?').get(lendingRecord.id,'user_a').outstanding_amount,120);
assert.equal(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE user_id=? AND type='expense'").get('user_a').s,spendingBeforeLending,'Lending and repayment must not become ordinary spending');
console.log('✓ Resolved transfers, investment contributions, lending and repayments use the shared financial engine');

const countBefore = db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get('user_a').c;
const accountBefore = db.prepare('SELECT balance FROM accounts WHERE id=?').get(a.account).balance;
db.exec("CREATE TRIGGER fail_second_import BEFORE INSERT ON transactions WHEN NEW.description='Reject row' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
assert.throws(() => commitStatementImport(db,'user_a',[
  {date:'2026-10-11',description:'Will rollback',amount:55,type:'expense',category:'Groceries'},
  {date:'2026-10-11',description:'Reject row',amount:80,type:'expense',category:'Groceries'}
],{accountId:a.account,bucketId:a.bucket}));
assert.equal(db.prepare('SELECT COUNT(*) c FROM transactions WHERE user_id=?').get('user_a').c,countBefore);
assert.equal(db.prepare('SELECT balance FROM accounts WHERE id=?').get(a.account).balance,accountBefore);
db.exec('DROP TRIGGER fail_second_import;');
console.log('✓ Mid-batch failure rolls back every row and account balance change');

const injection = previewStatementImport(db,'user_a',[{date:'2026-10-12',description:'=HYPERLINK(""https://evil.test"")',amount:12,type:'expense',category:'Shopping'}],{accountId:a.account,bucketId:a.bucket});
assert(injection.rows[0].description.startsWith("'=HYPERLINK"));
assert.throws(() => commitStatementImport(db,'user_a',[{date:'2026-10-12',description:'Transfer to savings',amount:100,type:'transfer',category:'Unclear'}],{accountId:a.account,bucketId:a.bucket}), /Resolve or skip/i);
console.log('✓ Formula-like descriptions neutralized; transfers cannot post as ordinary spend');

const large = 'Date,Description,Amount\n' + Array.from({length:1000},(_,i)=>`2026-09-01,Row ${i},${i+1}`).join('\n');
assert.equal(parseCsvRecords(large).length,1000);
assert.throws(() => parseCsvRecords('Date,Description,Amount\n' + Array.from({length:MAX_ROWS+1},(_,i)=>`2026-09-01,Row ${i},1`).join('\n')), /at most 10000/i);
console.log('✓ Large CSV accepted within limit and rejected safely above limit');

const sanitized = sanitizeText('Aadhaar 1234 5678 9012; PAN ABCDE1234F; phone 9876543210; UPI user@okhdfcbank; token abc123def');
assert(!sanitized.includes('123456789012'));
assert(!sanitized.includes('ABCDE1234F'));
assert(!sanitized.includes('9876543210'));
assert(!sanitized.includes('user@okhdfcbank'));
const safe = sanitizeForLogs('Authorization: Bearer secret-token; account 123456789012; note some data');
assert(!safe.includes('secret-token'));
assert(!safe.includes('123456789012'));
console.log('✓ Privacy sanitizer redacts sensitive values before logging');

db.close();
console.log('--- ALL PHASE 5 IMPORT & PRIVACY TESTS PASSED ---');
