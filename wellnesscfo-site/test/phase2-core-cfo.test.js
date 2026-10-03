const assert = require('node:assert');
const { initDatabase } = require('../server/db');
const {
  setupDefaultEntities,
  recordTransaction,
  updateTransaction,
  deleteTransaction,
  recordAccountTransfer,
  recordBucketTransfer,
  getFinancialSummary,
  getGoals,
  calculateEmergencyFund,
  calculateBusinessFund,
  getChartData
} = require('../server/financial-engine');

console.log('--- STARTING PHASE 2 CORE CFO TESTS ---');

const db = initDatabase(':memory:');
const userA = 'usr_alice_p2';
const userB = 'usr_bob_p2';

db.prepare(`
  INSERT INTO users (id, email, password_hash, salt, name, created_at)
  VALUES (?, 'alice2@cfo.test', 'hash', 'salt', 'Alice', '2026-10-03')
`).run(userA);

db.prepare(`
  INSERT INTO users (id, email, password_hash, salt, name, created_at)
  VALUES (?, 'bob2@cfo.test', 'hash', 'salt', 'Bob', '2026-10-03')
`).run(userB);

setupDefaultEntities(db, userA);
setupDefaultEntities(db, userB);

// Initial summary Alice
let summaryA = getFinancialSummary(db, userA, '2026-10');
const bankA = summaryA.accounts.find(a => a.type === 'bank');
const savingsBktA = summaryA.buckets.find(b => b.type === 'savings');
const businessBktA = summaryA.buckets.find(b => b.type === 'business');
const emergencyBktA = summaryA.buckets.find(b => b.type === 'emergency');
const spendingBktA = summaryA.buckets.find(b => b.type === 'spending');

// Seed Alice with Available Cash = 30,000, Savings = 10,000, Business = 5,000, Spending = 15,000
recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingBktA.id,
  type: 'income',
  amount: 30000,
  date: '2026-10-01',
  description: 'Initial Salary Deposit'
});

// Seed buckets via transfers from spending
recordBucketTransfer(db, userA, {
  fromBucketId: spendingBktA.id,
  toBucketId: savingsBktA.id,
  amount: 10000,
  date: '2026-10-01',
  description: 'Fund savings'
});

recordBucketTransfer(db, userA, {
  fromBucketId: spendingBktA.id,
  toBucketId: businessBktA.id,
  amount: 5000,
  date: '2026-10-01',
  description: 'Fund business'
});

summaryA = getFinancialSummary(db, userA, '2026-10');
assert.strictEqual(summaryA.availableCash, 30000, 'Available cash should be 30,000');
assert.strictEqual(summaryA.savingsFund, 10000, 'Savings should be 10,000');
assert.strictEqual(summaryA.businessFund, 5000, 'Business should be 5,000');

// Test 1: Bucket Transfer (₹1,000 Savings -> Business)
console.log('Test 1: Bucket Transfer: ₹1,000 Savings -> Business...');
const spendingBefore = summaryA.thisMonth.spending;
const cashBefore = summaryA.availableCash;
const netWorthBefore = summaryA.netWorth;

const transferRes = recordBucketTransfer(db, userA, {
  fromBucketId: savingsBktA.id,
  toBucketId: businessBktA.id,
  amount: 1000,
  date: '2026-10-02',
  description: 'Savings to Business'
});

summaryA = getFinancialSummary(db, userA, '2026-10');
assert.strictEqual(summaryA.savingsFund, 9000, 'Savings must be ₹9,000 (decreased by 1,000)');
assert.strictEqual(summaryA.businessFund, 6000, 'Business Fund must be ₹6,000 (increased by 1,000)');
assert.strictEqual(summaryA.thisMonth.spending, spendingBefore, 'Expense total must remain unchanged');
assert.strictEqual(summaryA.availableCash, cashBefore, 'Available cash must remain unchanged');
assert.strictEqual(summaryA.netWorth, netWorthBefore, 'Net worth must remain unchanged');

// Test 2: Goal contribution (Add ₹2,000 to Business Fund)
console.log('Test 2: Goal contribution...');
recordBucketTransfer(db, userA, {
  fromBucketId: spendingBktA.id,
  toBucketId: businessBktA.id,
  amount: 2000,
  date: '2026-10-03',
  description: 'Additional business contribution'
});

const bzFundDetails = calculateBusinessFund(db, userA);
assert.strictEqual(bzFundDetails.balance, 8000, 'Business balance should now be 8,000');
assert.strictEqual(bzFundDetails.progressPct, 8, 'Progress towards 100,000 should be 8%');
const goalsList = getGoals(db, userA);
const bzGoal = goalsList.find(g => g.type === 'business');
assert.strictEqual(bzGoal.current_amount, 8000, 'Goal current amount should track bucket balance');
assert.strictEqual(bzGoal.progressPct, 8, 'Goal progress % should be 8%');

// Test 3: Emergency Fund & Withdrawal Warning
console.log('Test 3: Emergency Fund & Withdrawal Warning...');
// Fund emergency bucket with 18,000
recordBucketTransfer(db, userA, {
  fromBucketId: spendingBktA.id,
  toBucketId: emergencyBktA.id,
  amount: 18000,
  date: '2026-10-02',
  description: 'Emergency reserve'
});

// Add essential expenses (groceries: 6000)
recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingBktA.id,
  type: 'expense',
  amount: 6000,
  date: '2026-10-02',
  category: 'Groceries',
  description: 'Monthly essential groceries'
});

const emBefore = calculateEmergencyFund(db, userA);
assert.strictEqual(emBefore.balance, 18000, 'Emergency balance should be 18,000');
assert.strictEqual(emBefore.essentialMonthlyExpenses, 6000, 'Essential expenses should be 6,000');
assert.strictEqual(emBefore.monthsCovered, 3, '18,000 / 6,000 = 3 months coverage');

// Withdraw ₹1,000 from Emergency Fund
const emWithdrawal = recordBucketTransfer(db, userA, {
  fromBucketId: emergencyBktA.id,
  toBucketId: spendingBktA.id,
  amount: 1000,
  date: '2026-10-03',
  description: 'Emergency repair withdrawal'
});

assert.strictEqual(emWithdrawal.isEmergencyWithdrawal, true, 'Should flag emergency withdrawal');
assert(emWithdrawal.warning.includes('Warning: You are withdrawing'), 'Warning message should be returned');

const emAfter = calculateEmergencyFund(db, userA);
assert.strictEqual(emAfter.balance, 17000, 'Emergency balance decreased to 17,000');
assert.strictEqual(emAfter.monthsCovered, 2.8, 'Coverage reduced to 2.8 months (17000 / 6000)');

// Test 4: Chart Update (Add expense -> verify chart -> edit/delete -> verify recalculation)
console.log('Test 4: Real Time-Series Chart dynamic calculation...');
const chartInitial = getChartData(db, userA, 'monthly');
const curMonthKey = '2026-10';
const curMonthDataInitial = chartInitial.cashFlow.find(c => c.period === curMonthKey);
const expInitial = curMonthDataInitial.expense;

// Add an expense of ₹2,500
const testTx = recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingBktA.id,
  type: 'expense',
  amount: 2500,
  date: '2026-10-03',
  category: 'Shopping',
  description: 'Winter Jacket'
});

const chartAfterAdd = getChartData(db, userA, 'monthly');
const curMonthDataAfterAdd = chartAfterAdd.cashFlow.find(c => c.period === curMonthKey);
assert.strictEqual(curMonthDataAfterAdd.expense, expInitial + 2500, 'Chart expense should increase by 2,500');

// Update the transaction to ₹3,000
updateTransaction(db, userA, testTx.id, {
  amount: 3000,
  description: 'Premium Winter Jacket'
});

const chartAfterUpdate = getChartData(db, userA, 'monthly');
const curMonthDataAfterUpdate = chartAfterUpdate.cashFlow.find(c => c.period === curMonthKey);
assert.strictEqual(curMonthDataAfterUpdate.expense, expInitial + 3000, 'Chart expense should update to +3,000');

// Delete the transaction
deleteTransaction(db, userA, testTx.id);
const chartAfterDelete = getChartData(db, userA, 'monthly');
const curMonthDataAfterDelete = chartAfterDelete.cashFlow.find(c => c.period === curMonthKey);
assert.strictEqual(curMonthDataAfterDelete.expense, expInitial, 'Chart expense should recalculate back to original after deletion');

// Test 5: Filters (All, Income, Expense, Transfers, Investments)
console.log('Test 5: Transaction Filters...');
const allTxs = db.prepare('SELECT * FROM transactions WHERE user_id = ?').all(userA);
const incomeTxs = allTxs.filter(t => t.type === 'income');
const expenseTxs = allTxs.filter(t => t.type === 'expense');
const transferTxs = allTxs.filter(t => t.type === 'transfer_account' || t.type === 'transfer_bucket');

assert(incomeTxs.length > 0, 'Should have income transactions');
assert(expenseTxs.length > 0, 'Should have expense transactions');
assert(transferTxs.length > 0, 'Should have transfer transactions');

// Test 6: User Isolation on Goals & Fund Details
console.log('Test 6: User Isolation for Goals and Buckets...');
const bobSummary = getFinancialSummary(db, userB);
const bobGoals = getGoals(db, userB);
assert.strictEqual(bobSummary.availableCash, 0, 'Bob should have 0 cash');
assert.strictEqual(bobGoals.find(g => g.type === 'business').current_amount, 0, 'Bob business goal should be 0');

assert.throws(() => {
  // Bob tries to delete Alice's transaction
  deleteTransaction(db, userB, allTxs[0].id);
}, /Transaction not found/, 'Bob cannot delete Alice transaction');

console.log('--- ALL PHASE 2 CORE CFO TESTS PASSED SUCCESSFULLY! ---');
