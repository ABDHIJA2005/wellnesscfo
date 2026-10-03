'use strict';

const assert = require('node:assert/strict');
const { buildMonthlyInsights, calculateAffordabilityEstimate, normalizeRecurringMonthly, countUpcomingOccurrences, percentageChange } = require('../server/financial-insights');

const now = new Date('2026-10-15T12:00:00.000Z');
const transactions = [
  { date: '2026-09-05', type: 'income', amount: 60000, category: 'Salary' },
  { date: '2026-09-07', type: 'expense', amount: 12000, category: 'Rent', necessity: 'Necessary' },
  { date: '2026-10-02', type: 'income', amount: 30000, category: 'Salary' },
  { date: '2026-10-03', type: 'refund', amount: 1000, category: 'Shopping' },
  { date: '2026-10-04', type: 'expense', amount: 13000, category: 'Rent', necessity: 'Necessary' },
  ...[1, 2, 3, 4, 5].map((n) => ({ date: `2026-10-${String(5 + n).padStart(2, '0')}`, type: 'expense', amount: 100, category: 'Snacks', necessity: 'Optional' })),
  { date: '2026-10-09', type: 'transfer_bucket', amount: 9000, category: 'Rent' },
  { date: '2026-10-10', type: 'transfer_account', amount: 7000, category: 'Transfer' },
  { date: '2026-10-11', type: 'initial_balance', amount: 500000, category: 'Starting balance' }
];
const summary = {
  availableCash: 50000, netWorth: 90000, investments: 20000, totalReceivables: 2000, totalPayables: 5000,
  accounts: [{ type: 'credit_card', balance: -3000 }], buckets: [], goals: [],
  emergencyFundDetails: { balance: 8000, essentialMonthlyExpenses: 13000, monthsCovered: 0.6, targetAmount: 150000, remainingAmount: 142000 }
};

console.log('Phase 9 deterministic insight calculations...');
const insights = buildMonthlyInsights({
  transactions, categorySettings: new Set(['rent']),
  recurringCommitments: [
    { id: 'daily', name: 'Daily', amount: 10, frequency: 'daily', next_date: '2026-10-15', is_active: 1 },
    { id: 'weekly', name: 'Weekly', amount: 100, frequency: 'weekly', next_date: '2026-10-17', is_active: 1 },
    { id: 'monthly', name: 'Monthly', amount: 1000, frequency: 'monthly', next_date: '2026-10-20', is_active: 1 },
    { id: 'yearly', name: 'Yearly', amount: 12000, frequency: 'yearly', next_date: '2026-11-01', is_active: 1 },
    { id: 'inactive', name: 'Inactive', amount: 9999, frequency: 'monthly', next_date: '2026-10-15', is_active: 0 }
  ], summary, month: '2026-10', now
});
assert.deepEqual(insights.period, { start: '2026-10-01', end: '2026-10-15', isPartial: true });
assert.equal(insights.cashFlow.income.total, 31000, 'Refund is treated as income');
assert.equal(insights.cashFlow.expenses.total, 13500);
assert.equal(insights.cashFlow.netCashFlow, 17500);
assert.equal(insights.cashFlow.expenses.count, 6);
assert.equal(insights.cashFlow.expenses.average, 2250);
assert.equal(insights.cashFlow.expenses.largest, 13000);
assert.equal(insights.cashFlow.savingsRate, 17500 / 31000 * 100);
assert.equal(insights.comparison.available, true);
assert.equal(insights.comparison.previousMonth, '2026-09');
assert.equal(insights.comparison.income.absolute, -29000);
assert.equal(insights.categories.find(row => row.category === 'Rent').percentage, 13000 / 13500 * 100);
assert.equal(insights.spendingClassification.essential, 13000);
assert.equal(insights.spendingClassification.discretionary, 500);
assert(insights.patterns.items.some(item => item.type === 'repeated_small_expenses'));
assert.equal(insights.recurring.activeCount, 4);
assert.equal(insights.recurring.upcoming.find(row => row.id === 'daily').upcomingCount, 30);
assert.equal(insights.recurring.upcoming.find(row => row.id === 'weekly').upcomingCount, 4);
assert.equal(insights.recurring.upcoming.find(row => row.id === 'yearly').upcomingCount, 1, 'The due date within 30 days is included regardless of recurrence frequency');
assert.equal(insights.emergencyFund.monthsOfCoverage, 0.6);
assert.equal(insights.netWorth.current, 90000);
assert.equal(insights.netWorth.historicalComparisonAvailable, false);
assert.equal(insights.charts.netWorthMonths.length, 0);

const noIncome = buildMonthlyInsights({ transactions: [{ date: '2026-10-03', type: 'expense', amount: 50, category: 'Other' }], categorySettings: new Set(), recurringCommitments: [], summary: { ...summary, emergencyFundDetails: { balance: 100, essentialMonthlyExpenses: 0 } }, month: '2026-10', now });
assert.equal(noIncome.cashFlow.savingsRate, null);
assert.equal(noIncome.emergencyFund.monthsOfCoverage, null);
assert.equal(noIncome.comparison.available, false);
assert.equal(noIncome.patterns.items.length, 0, 'No baseline means no historical pattern claim');
assert.equal(percentageChange(25, 0).percent, null);
assert.equal(normalizeRecurringMonthly({ amount: 1200, frequency: 'quarterly' }), 400);
assert.equal(normalizeRecurringMonthly({ amount: 1200, frequency: 'yearly' }), 100);
assert.equal(countUpcomingOccurrences({ next_date: '2026-10-16', frequency: 'weekly' }, '2026-10-15', '2026-11-14'), 5);

const estimate = calculateAffordabilityEstimate({ purchaseAmount: 10000, availableCash: 50000, upcomingCommitments: 5000, emergencyReserve: 8000, currentMonthSpending: 20000, targetBalance: 3000 });
assert.equal(estimate.remainingBeforePurchase, 34000);
assert.equal(estimate.remainingAfterPurchase, 24000);
assert(estimate.assumptions.some(line => line.includes('not subtracted again')));
assert.throws(() => calculateAffordabilityEstimate({ purchaseAmount: -1, availableCash: 1, upcomingCommitments: 0, emergencyReserve: 0, currentMonthSpending: 0 }), /finite, non-negative/);
console.log('Phase 9 deterministic insight calculations passed.');
