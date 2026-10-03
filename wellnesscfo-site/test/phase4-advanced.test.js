// test/phase4-advanced.test.js
// Automated test suite for Phase 4: Advanced Finance Layer

const assert = require('node:assert');
const { initDatabase } = require('../server/db');
const {
  setupDefaultEntities,
  recordTransaction,
  getFinancialSummary,
  // Phase 4
  getInvestments,
  recordInvestment,
  updateInvestment,
  deleteInvestment,
  recordInvestmentTransaction,
  getLendingRecords,
  recordLending,
  recordLendingRepayment,
  getSplitExpenses,
  recordSplitExpense,
  settleSplitParticipant,
  getRecurringCommitments,
  recordRecurringCommitment,
  updateRecurringCommitment,
  deleteRecurringCommitment,
  getFinancialCalendar,
  postRecurringToLedger
} = require('../server/financial-engine');

console.log('--- STARTING PHASE 4 ADVANCED FINANCE TESTS ---');

const db = initDatabase(':memory:');
const userA = 'usr_alice_p4';
const userB = 'usr_bob_p4';

db.prepare(`INSERT INTO users (id, email, password_hash, salt, name, created_at) VALUES (?, 'alice4@cfo.test', 'h', 's', 'Alice', '2026-10-03')`).run(userA);
db.prepare(`INSERT INTO users (id, email, password_hash, salt, name, created_at) VALUES (?, 'bob4@cfo.test', 'h', 's', 'Bob', '2026-10-03')`).run(userB);

setupDefaultEntities(db, userA);
setupDefaultEntities(db, userB);

const bankA = db.prepare(`SELECT id FROM accounts WHERE user_id = ? AND type = 'bank' LIMIT 1`).get(userA);
// Seed initial bank balance for Alice with ₹50,000
recordTransaction(db, userA, {
  account_id: bankA.id,
  type: 'income',
  amount: 50000,
  category: 'Salary',
  description: 'Initial Salary'
});

// Test 1: Advanced Investments & SIP Tracking
console.log('Test 1: Advanced Investments (Holdings, Contribution, Withdrawal, Performance)...');
const inv = recordInvestment(db, userA, {
  name: 'Parag Parikh Flexi Cap Fund',
  type: 'mutual_fund',
  invested_amount: 10000,
  current_value: 11500,
  units: 150,
  sip_amount: 2000,
  sip_day: 5
});
assert(inv.id, 'Investment should be created with ID');
assert.strictEqual(inv.name, 'Parag Parikh Flexi Cap Fund');

// Verify initial state
let invData = getInvestments(db, userA);
assert.strictEqual(invData.investments.length, 1);
assert.strictEqual(invData.summary.totalInvested, 10000);
assert.strictEqual(invData.summary.totalValue, 11500);
assert.strictEqual(invData.summary.totalGain, 1500);
assert.strictEqual(invData.investments[0].return_percentage, 15);

// Test contribution: Add ₹5,000 contribution from bank account
const curSpendBefore = getFinancialSummary(db, userA).thisMonth.spending;
recordInvestmentTransaction(db, userA, {
  investmentId: inv.id,
  type: 'contribution',
  amount: 5000,
  units: 50,
  accountId: bankA.id
});

invData = getInvestments(db, userA);
assert.strictEqual(invData.summary.totalInvested, 15000);
assert.strictEqual(invData.summary.totalValue, 16500);

// CRITICAL DETERMINISTIC CHECK: Investment contribution must NOT count as monthly expense!
const curSpendAfter = getFinancialSummary(db, userA).thisMonth.spending;
assert.strictEqual(curSpendAfter, curSpendBefore, 'Investment contribution must NOT inflate monthly spending!');

// Test withdrawal: ₹3,000 withdrawal back to bank account
recordInvestmentTransaction(db, userA, {
  investmentId: inv.id,
  type: 'withdrawal',
  amount: 3000,
  units: 30,
  accountId: bankA.id
});
invData = getInvestments(db, userA);
assert.strictEqual(invData.summary.totalInvested, 12000);
assert.strictEqual(invData.summary.totalValue, 13500);

// Test valuation snapshot update without bank movement
recordInvestmentTransaction(db, userA, {
  investmentId: inv.id,
  type: 'valuation_update',
  amount: 14000
});
invData = getInvestments(db, userA);
assert.strictEqual(invData.summary.totalValue, 14000);
assert.strictEqual(invData.summary.totalGain, 2000);
console.log('✓ Investment tracking, contributions, withdrawals, and valuation verified without spending inflation.');

// Test 2: Lending & Borrowing (Receivables & Payables)
console.log('\nTest 2: Lending & Borrowing (Receivables, Payables, Partial & Full Repayments)...');
// Alice lends ₹3,000 to Aakash
const lendRecord = recordLending(db, userA, {
  type: 'lent',
  personName: 'Aakash',
  totalAmount: 3000,
  dueDate: '2026-11-01',
  accountId: bankA.id,
  notes: 'Lent for exam books'
});
assert.strictEqual(lendRecord.outstandingAmount, 3000);
assert.strictEqual(lendRecord.status, 'active');

let lendingData = getLendingRecords(db, userA);
assert.strictEqual(lendingData.summary.totalLent, 3000);
assert.strictEqual(lendingData.summary.netBalance, 3000);

// Verify Net Worth accounts for money lent as a receivable
let summary = getFinancialSummary(db, userA);
assert.strictEqual(summary.totalReceivables, 3000);

// Partial repayment: Aakash pays back ₹1,000
const rep1 = recordLendingRepayment(db, userA, {
  lendingId: lendRecord.id,
  amount: 1000,
  accountId: bankA.id
});
assert.strictEqual(rep1.remainingOutstanding, 2000);

lendingData = getLendingRecords(db, userA);
assert.strictEqual(lendingData.records[0].outstanding_amount, 2000);
assert.strictEqual(lendingData.records[0].status, 'active');

// Full repayment: Aakash pays back remaining ₹2,000
const rep2 = recordLendingRepayment(db, userA, {
  lendingId: lendRecord.id,
  amount: 2000,
  accountId: bankA.id
});
assert.strictEqual(rep2.remainingOutstanding, 0);

lendingData = getLendingRecords(db, userA);
assert.strictEqual(lendingData.records[0].status, 'repaid');
assert.strictEqual(lendingData.summary.totalLent, 0);

// Borrowing: Alice borrows ₹2,000 from Rohit
const borrowRecord = recordLending(db, userA, {
  type: 'borrowed',
  personName: 'Rohit',
  totalAmount: 2000,
  dueDate: '2026-10-25',
  accountId: bankA.id
});
lendingData = getLendingRecords(db, userA);
assert.strictEqual(lendingData.summary.totalBorrowed, 2000);
assert.strictEqual(lendingData.summary.netBalance, -2000);

summary = getFinancialSummary(db, userA);
assert.strictEqual(summary.totalPayables, 2000);
console.log('✓ Lending, borrowing, partial repayments, and net balance verified.');

// Test 3: Split Expenses
console.log('\nTest 3: Split Expenses (Equal, Unequal, and Settlement)...');
// Alice pays ₹3,000 for dinner with 2 friends (her share is ₹1,000; Bob & Carol owe ₹1,000 each)
const spendingBeforeSplit = getFinancialSummary(db, userA).thisMonth.spending;

const split = recordSplitExpense(db, userA, {
  title: 'Weekend Dinner',
  totalAmount: 3000,
  myShare: 1000,
  payer: 'me',
  category: 'Food & Dining',
  accountId: bankA.id,
  participants: [
    { name: 'Bob Friend', shareAmount: 1000 },
    { name: 'Carol Friend', shareAmount: 1000 }
  ]
});

assert.strictEqual(split.title, 'Weekend Dinner');
assert.strictEqual(split.totalAmount, 3000);
assert.strictEqual(split.myShare, 1000);

// CRITICAL DETERMINISTIC CHECK: Personal spending must increase ONLY by Alice's share (₹1,000), NOT ₹3,000!
const spendingAfterSplit = getFinancialSummary(db, userA).thisMonth.spending;
assert.strictEqual(spendingAfterSplit - spendingBeforeSplit, 1000, 'Split expense must only record personal share as spending!');

// Verify split participants
const allSplits = getSplitExpenses(db, userA);
assert.strictEqual(allSplits.length, 1);
assert.strictEqual(allSplits[0].participants.length, 2);

// Settle Bob's share
const bobParticipant = allSplits[0].participants.find(p => p.name === 'Bob Friend');
settleSplitParticipant(db, userA, bobParticipant.id, {
  amount: 1000,
  accountId: bankA.id
});

const splitsAfterSettlement = getSplitExpenses(db, userA);
const settledBob = splitsAfterSettlement[0].participants.find(p => p.name === 'Bob Friend');
assert.strictEqual(settledBob.is_settled, 1);
assert.strictEqual(splitsAfterSettlement[0].status, 'pending'); // Carol still unsettled

console.log('✓ Split expenses accurately record personal share and track participant settlements.');

// Test 4: Recurring Commitments & Financial Calendar
console.log('\nTest 4: Recurring Commitments & Next Occurrence Calculations...');
const recCommitment = recordRecurringCommitment(db, userA, {
  name: 'Netflix Premium',
  type: 'subscription',
  amount: 649,
  frequency: 'monthly',
  nextDate: '2026-10-15',
  accountId: bankA.id
});
assert.strictEqual(recCommitment.name, 'Netflix Premium');
assert.strictEqual(recCommitment.amount, 649);

const commitments = getRecurringCommitments(db, userA);
assert.strictEqual(commitments.length, 1);

// Post recurring item to ledger and verify next occurrence advances deterministically
const postResult = postRecurringToLedger(db, userA, recCommitment.id, '2026-10-15');
assert(postResult.success);
assert.strictEqual(postResult.nextDate, '2026-11-15', 'Monthly commitment should advance by exactly 1 month');

const updatedCommitment = getRecurringCommitments(db, userA).find(c => c.id === recCommitment.id);
assert.strictEqual(updatedCommitment.next_date, '2026-11-15');

// Calendar Aggregation
console.log('Test 5: Financial Calendar aggregation...');
const calendar = getFinancialCalendar(db, userA, '2026-10-01', '2026-11-30');
assert(calendar.events.length > 0, 'Calendar should include scheduled events');
const hasNetflix = calendar.events.some(e => e.title === 'Netflix Premium');
assert(hasNetflix, 'Calendar must include Netflix commitment');
console.log('✓ Financial calendar aggregated recurring commitments, due dates, and deadlines.');

// Test 6: User Isolation
console.log('Test 6: User Isolation in Phase 4...');
// User B must have 0 investments, 0 lending records, 0 split expenses, 0 recurring commitments
const bInvestments = getInvestments(db, userB);
assert.strictEqual(bInvestments.investments.length, 0, 'User B must not see User A investments');

const bLending = getLendingRecords(db, userB);
assert.strictEqual(bLending.records.length, 0, 'User B must not see User A lending records');

const bSplits = getSplitExpenses(db, userB);
assert.strictEqual(bSplits.length, 0, 'User B must not see User A split expenses');

const bRecurring = getRecurringCommitments(db, userB);
assert.strictEqual(bRecurring.length, 0, 'User B must not see User A recurring commitments');

console.log('✓ Strict User Isolation verified for all Phase 4 entities.');

console.log('\n--- ALL PHASE 4 ADVANCED FINANCE TESTS PASSED 100% SUCCESSFULLY! ---');
