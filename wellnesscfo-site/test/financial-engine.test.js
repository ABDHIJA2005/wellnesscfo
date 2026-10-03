const assert = require('node:assert');
const { initDatabase } = require('../server/db');
const { hashPassword, verifyPassword, createSession, getUserFromSession } = require('../server/auth');
const {
  setupDefaultEntities,
  recordTransaction,
  recordAccountTransfer,
  recordBucketTransfer,
  getFinancialSummary,
  migrateLegacyData
} = require('../server/financial-engine');

console.log('--- STARTING FINANCIAL ENGINE & ISOLATION TESTS ---');

const db = initDatabase(':memory:');

// Test 1: User Creation & Password Hashing
console.log('Test 1: User creation & authentication...');
const { hash, salt } = hashPassword('SecurePass123!');
assert(verifyPassword('SecurePass123!', hash, salt), 'Password verification should succeed with correct password');
assert(!verifyPassword('WrongPass', hash, salt), 'Password verification should fail with incorrect password');

const userAId = 'usr_alice';
const userBId = 'usr_bob';
const now = new Date().toISOString();

db.prepare(`
  INSERT INTO users (id, email, password_hash, salt, name, created_at)
  VALUES (?, 'alice@wellnesscfo.test', ?, ?, 'Alice', ?)
`).run(userAId, hash, salt, now);

db.prepare(`
  INSERT INTO users (id, email, password_hash, salt, name, created_at)
  VALUES (?, 'bob@wellnesscfo.test', ?, ?, 'Bob', ?)
`).run(userBId, hash, salt, now);

// Sessions
const sessionA = createSession(db, userAId);
const authUser = getUserFromSession(db, sessionA.token);
assert.strictEqual(authUser.id, userAId, 'Session should authenticate user A');
assert.strictEqual(authUser.name, 'Alice');

// Initialize entities for user A & B
setupDefaultEntities(db, userAId);
setupDefaultEntities(db, userBId);

const summaryInitA = getFinancialSummary(db, userAId);
assert.strictEqual(summaryInitA.availableCash, 0, 'Initial available cash should be 0');
assert.strictEqual(summaryInitA.netWorth, 0, 'Initial net worth should be 0');

// Test 2: Income: Add ₹27,000 income
console.log('Test 2: Income test (Add ₹27,000 income)...');
const mainBankA = summaryInitA.accounts.find(a => a.type === 'bank');
const spendingBktA = summaryInitA.buckets.find(b => b.type === 'spending');

recordTransaction(db, userAId, {
  account_id: mainBankA.id,
  bucket_id: spendingBktA.id,
  type: 'income',
  amount: 27000,
  date: '2026-10-03',
  description: 'Salary advance'
});

const summaryAfterIncome = getFinancialSummary(db, userAId, '2026-10');
assert.strictEqual(summaryAfterIncome.availableCash, 27000, 'Available cash must increase by exactly ₹27,000');
assert.strictEqual(summaryAfterIncome.netWorth, 27000, 'Net worth must increase by exactly ₹27,000');
assert.strictEqual(summaryAfterIncome.thisMonth.income, 27000, 'Monthly income must be ₹27,000');
assert.strictEqual(summaryAfterIncome.thisMonth.spending, 0, 'Monthly spending must remain 0');

// Test 3: Expense: Add ₹500 expense
console.log('Test 3: Expense test (Add ₹500 expense)...');
recordTransaction(db, userAId, {
  account_id: mainBankA.id,
  bucket_id: spendingBktA.id,
  type: 'expense',
  amount: 500,
  date: '2026-10-03',
  description: 'Groceries'
});

const summaryAfterExpense = getFinancialSummary(db, userAId, '2026-10');
assert.strictEqual(summaryAfterExpense.availableCash, 26500, 'Available cash must decrease by ₹500 (27000 - 500 = 26500)');
assert.strictEqual(summaryAfterExpense.netWorth, 26500, 'Net worth must decrease by ₹500');
assert.strictEqual(summaryAfterExpense.thisMonth.spending, 500, 'Monthly spending must be ₹500');

// Test 4: Bucket Transfer: Move ₹1,000 from Savings -> Investments
console.log('Test 4: Bucket transfer test (Move ₹1,000 from Savings to Investments)...');
const savingsBktA = summaryAfterExpense.buckets.find(b => b.type === 'savings');
const investBktA = summaryAfterExpense.buckets.find(b => b.type === 'investments');

// Seed Savings bucket with 5000 first via allocation
db.prepare('UPDATE buckets SET balance = 5000 WHERE id = ?').run(savingsBktA.id);
const savingsInitial = db.prepare('SELECT balance FROM buckets WHERE id = ?').get(savingsBktA.id).balance;
const investInitial = db.prepare('SELECT balance FROM buckets WHERE id = ?').get(investBktA.id).balance;

const summaryBeforeBucketTransfer = getFinancialSummary(db, userAId, '2026-10');
const spendingBefore = summaryBeforeBucketTransfer.thisMonth.spending;
const netWorthBefore = summaryBeforeBucketTransfer.netWorth;

recordBucketTransfer(db, userAId, {
  fromBucketId: savingsBktA.id,
  toBucketId: investBktA.id,
  amount: 1000,
  date: '2026-10-03',
  description: 'Allocate savings to investments'
});

const savingsAfter = db.prepare('SELECT balance FROM buckets WHERE id = ?').get(savingsBktA.id).balance;
const investAfter = db.prepare('SELECT balance FROM buckets WHERE id = ?').get(investBktA.id).balance;
const summaryAfterBucketTransfer = getFinancialSummary(db, userAId, '2026-10');

assert.strictEqual(savingsAfter, savingsInitial - 1000, 'Savings bucket balance must decrease by ₹1,000');
assert.strictEqual(investAfter, investInitial + 1000, 'Investments bucket balance must increase by ₹1,000');
assert.strictEqual(summaryAfterBucketTransfer.thisMonth.spending, spendingBefore, 'Expense total must NOT increase');
assert.strictEqual(summaryAfterBucketTransfer.netWorth, netWorthBefore, 'Net worth must NOT decrease');

// Test 5: Multiple accounts transfer
console.log('Test 5: Multiple accounts transfer (Bank -> Cash)...');
const cashAccA = summaryAfterExpense.accounts.find(a => a.type === 'cash');
const bankInitial = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(mainBankA.id).balance;
const cashInitial = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(cashAccA.id).balance;

recordAccountTransfer(db, userAId, {
  fromAccountId: mainBankA.id,
  toAccountId: cashAccA.id,
  amount: 2000,
  date: '2026-10-03',
  description: 'ATM Cash Withdrawal'
});

const bankAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(mainBankA.id).balance;
const cashAfter = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(cashAccA.id).balance;
const summaryAfterAccTransfer = getFinancialSummary(db, userAId, '2026-10');

assert.strictEqual(bankAfter, bankInitial - 2000, 'Bank balance must decrease by ₹2,000');
assert.strictEqual(cashAfter, cashInitial + 2000, 'Cash balance must increase by ₹2,000');
assert.strictEqual(summaryAfterAccTransfer.availableCash, summaryAfterBucketTransfer.availableCash, 'Available cash is preserved during liquid transfer');
assert.strictEqual(summaryAfterAccTransfer.netWorth, summaryAfterBucketTransfer.netWorth, 'Net worth is preserved during account transfer');
assert.strictEqual(summaryAfterAccTransfer.thisMonth.spending, spendingBefore, 'Account transfers do not count as spending');

// Test 6: User Isolation
console.log('Test 6: User Isolation (User B cannot see User A data)...');
const summaryB = getFinancialSummary(db, userBId, '2026-10');
assert.strictEqual(summaryB.availableCash, 0, 'User B must have 0 available cash');
assert.strictEqual(summaryB.netWorth, 0, 'User B must have 0 net worth');
assert.strictEqual(summaryB.thisMonth.income, 0, 'User B must have 0 income');
assert.strictEqual(summaryB.thisMonth.spending, 0, 'User B must have 0 spending');

// Verify cross-user account transfer attempt fails
assert.throws(() => {
  recordAccountTransfer(db, userBId, {
    fromAccountId: mainBankA.id, // Alice's account!
    toAccountId: summaryB.accounts[0].id,
    amount: 1000
  });
}, /Both accounts must belong to the user/, 'Cross-user transfer must be rejected');

// Test 7: Migration from legacy wellnesscfo-data-v1
console.log('Test 7: Legacy wellnesscfo-data-v1 migration...');
const legacyData = {
  transactions: [
    { date: '2026-10-02', description: 'Salary · Acme Technologies', category: 'Income', amount: 95000, type: 'income' },
    { date: '2026-10-01', description: 'Zepto · Groceries', category: 'Food & groceries', amount: -1480, type: 'expense' },
    { date: '2026-09-30', description: 'Netflix subscription', category: 'Subscriptions', amount: -649, type: 'expense' },
    { date: '2026-09-29', description: 'Monthly SIP · Parag Parikh Flexi Cap', category: 'Investments', amount: -10000, type: 'expense' }
  ],
  portfolio: [
    { kind: 'Stocks', value: 454842, asOf: '2026-10-01' },
    { kind: 'Mutual funds', value: 261113, asOf: '2026-10-01' }
  ]
};

const migrationResult = migrateLegacyData(db, userBId, legacyData);
assert.strictEqual(migrationResult.migratedTransactions, 4, 'All 4 legacy transactions should migrate');
assert.strictEqual(migrationResult.migratedPortfolio, 2, 'Both portfolio items should migrate');

// Verify migration idempotency (running again should not duplicate)
const migrationResult2 = migrateLegacyData(db, userBId, legacyData);
assert.strictEqual(migrationResult2.migratedTransactions, 0, 'Subsequent migration should be idempotent (no duplicates)');

const summaryBAfterMigration = getFinancialSummary(db, userBId, '2026-10');
assert(summaryBAfterMigration.availableCash > 0, 'User B should have real available cash from migrated salary minus expenses');
assert.strictEqual(summaryBAfterMigration.thisMonth.income, 95000, 'User B October income should be 95,000');
assert.strictEqual(summaryBAfterMigration.thisMonth.spending, 1480, 'User B October spending should be 1,480');
assert.strictEqual(summaryBAfterMigration.investments, 454842 + 261113, 'Portfolio snapshots should reflect in total investments');

console.log('--- ALL FINANCIAL ENGINE & ISOLATION TESTS PASSED SUCCESSFULLY! ---');
