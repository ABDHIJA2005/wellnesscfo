'use strict';

const { getFinancialSummary } = require('./financial-engine');

const FLOW_TYPES = new Set(['income', 'refund', 'expense']);
const ESSENTIAL_NECESSITY = new Set(['Necessary']);
const DISCRETIONARY_NECESSITY = new Set(['Optional', 'Avoidable', 'Wasteful']);

function validMonth(month) {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function offsetMonth(month, offset) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
}

function comparableEnd(month, selectedMonth, now) {
  if (selectedMonth !== now.toISOString().slice(0, 7)) return monthEnd(month);
  const day = Math.min(Number(now.toISOString().slice(8, 10)), Number(monthEnd(month).slice(8, 10)));
  return `${month}-${String(day).padStart(2, '0')}`;
}

function classifyExpense(transaction, essentialCategories) {
  const category = String(transaction.category || 'Uncategorised').trim() || 'Uncategorised';
  const categoryIsEssential = essentialCategories.has(category.toLowerCase());
  if (categoryIsEssential || ESSENTIAL_NECESSITY.has(transaction.necessity)) return 'essential';
  if (DISCRETIONARY_NECESSITY.has(transaction.necessity)) return 'discretionary';
  return 'unclassified';
}

function percentageChange(current, previous, available = true) {
  if (!available) return { absolute: null, percent: null, reason: 'No comparable period data.' };
  const absolute = current - previous;
  if (previous === 0) {
    return { absolute, percent: null, reason: 'Percentage change is unavailable because the previous period was zero.' };
  }
  return { absolute, percent: (absolute / Math.abs(previous)) * 100, reason: null };
}

function aggregatePeriod(transactions, startDate, endDate, essentialCategories) {
  const inPeriod = transactions.filter(tx => tx.date >= startDate && tx.date <= endDate && FLOW_TYPES.has(tx.type));
  const incomeRows = inPeriod.filter(tx => tx.type === 'income' || tx.type === 'refund');
  const expenseRows = inPeriod.filter(tx => tx.type === 'expense');
  const total = rows => rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const stats = rows => ({
    total: total(rows),
    count: rows.length,
    average: rows.length ? total(rows) / rows.length : null,
    largest: rows.length ? Math.max(...rows.map(row => Number(row.amount || 0))) : null
  });
  const income = stats(incomeRows);
  const expenses = stats(expenseRows);
  const netCashFlow = income.total - expenses.total;
  const categories = new Map();
  const classified = { essential: 0, discretionary: 0, unclassified: 0 };
  const recurringExpenses = [];

  for (const tx of expenseRows) {
    const category = String(tx.category || 'Uncategorised').trim() || 'Uncategorised';
    const entry = categories.get(category) || { category, amount: 0, count: 0 };
    entry.amount += Number(tx.amount || 0);
    entry.count += 1;
    categories.set(category, entry);
    classified[classifyExpense(tx, essentialCategories)] += Number(tx.amount || 0);
    if (tx.is_recurring || tx.source === 'recurring_auto_post') recurringExpenses.push(tx);
  }

  return {
    startDate,
    endDate,
    hasTransactions: inPeriod.length > 0,
    transactionCount: inPeriod.length,
    income,
    expenses,
    netCashFlow,
    savingsAmount: netCashFlow,
    savingsRate: income.total > 0 ? (netCashFlow / income.total) * 100 : null,
    savingsRateReason: income.total > 0 ? null : 'Savings rate is unavailable because this period has no income or refunds.',
    classified,
    categories: [...categories.values()],
    recurringExpenseTotal: total(recurringExpenses),
    recurringExpenseCount: recurringExpenses.length
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeRecurringMonthly(commitment) {
  const amount = Math.max(0, Number(commitment.amount) || 0);
  switch (commitment.frequency) {
    case 'daily': return amount * 365 / 12;
    case 'weekly': return amount * 52 / 12;
    case 'quarterly': return amount / 3;
    case 'yearly': return amount / 12;
    case 'monthly':
    default: return amount;
  }
}

function countUpcomingOccurrences(commitment, startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(commitment.next_date || '') || commitment.next_date < startDate) return 0;
  let date = new Date(`${commitment.next_date}T00:00:00.000Z`);
  const last = new Date(`${endDate}T00:00:00.000Z`);
  let count = 0;
  for (let guard = 0; date <= last && guard < 100; guard += 1) {
    count += 1;
    const day = date.getUTCDate();
    if (commitment.frequency === 'daily') date.setUTCDate(date.getUTCDate() + 1);
    else if (commitment.frequency === 'weekly') date.setUTCDate(date.getUTCDate() + 7);
    else if (commitment.frequency === 'quarterly' || commitment.frequency === 'monthly' || commitment.frequency === 'yearly') {
      const increment = commitment.frequency === 'quarterly' ? 3 : commitment.frequency === 'yearly' ? 12 : 1;
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + increment);
      const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, daysInMonth));
    } else break;
  }
  return count;
}

function buildMonthlyInsights({ transactions, categorySettings, recurringCommitments, summary, month, now = new Date() }) {
  if (!validMonth(month)) throw new Error('Month must use YYYY-MM format.');
  const selectedMonth = month;
  const currentMonth = now.toISOString().slice(0, 7);
  const day = now.toISOString().slice(8, 10);
  const currentEnd = comparableEnd(selectedMonth, selectedMonth, now);
  const previousMonth = offsetMonth(selectedMonth, -1);
  const previousEnd = selectedMonth === currentMonth
    ? `${previousMonth}-${String(Math.min(Number(day), Number(monthEnd(previousMonth).slice(8, 10)))).padStart(2, '0')}`
    : monthEnd(previousMonth);
  const current = aggregatePeriod(transactions, `${selectedMonth}-01`, currentEnd, categorySettings);
  const previous = aggregatePeriod(transactions, `${previousMonth}-01`, previousEnd, categorySettings);
  const comparisonAvailable = previous.hasTransactions;

  const categoryMap = new Map();
  for (const row of [...current.categories, ...previous.categories]) {
    if (!categoryMap.has(row.category)) categoryMap.set(row.category, { category: row.category, amount: 0, count: 0, previousAmount: 0, previousCount: 0 });
  }
  for (const row of current.categories) Object.assign(categoryMap.get(row.category), { amount: row.amount, count: row.count });
  for (const row of previous.categories) Object.assign(categoryMap.get(row.category), { previousAmount: row.amount, previousCount: row.count });
  const categories = [...categoryMap.values()].map(row => ({
    ...row,
    percentage: current.expenses.total > 0 ? row.amount / current.expenses.total * 100 : null,
    change: percentageChange(row.amount, row.previousAmount, comparisonAvailable)
  }));
  const categoryChanges = categories
    .map(row => ({ ...row, delta: row.amount - row.previousAmount }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const changeFor = (key, nowValue = current[key], priorValue = previous[key]) => ({
    current: nowValue,
    previous: comparisonAvailable ? priorValue : null,
    ...percentageChange(nowValue, priorValue, comparisonAvailable)
  });
  const comparison = {
    available: comparisonAvailable,
    previousMonth,
    reason: comparisonAvailable ? null : `No income or expense activity is recorded for ${previousMonth}.`,
    income: changeFor('income', current.income.total, previous.income.total),
    expenses: changeFor('expenses', current.expenses.total, previous.expenses.total),
    netCashFlow: changeFor('netCashFlow'),
    savingsRate: {
      current: current.savingsRate,
      previous: comparisonAvailable ? previous.savingsRate : null,
      absolute: comparisonAvailable && current.savingsRate !== null && previous.savingsRate !== null ? current.savingsRate - previous.savingsRate : null,
      percent: null,
      reason: comparisonAvailable && (current.savingsRate === null || previous.savingsRate === null) ? 'Savings-rate comparison requires recorded income in both periods.' : null,
      unit: 'percentage points'
    },
    essentialSpending: changeFor('classified', current.classified.essential, previous.classified.essential),
    discretionarySpending: changeFor('classified', current.classified.discretionary, previous.classified.discretionary),
    recurringSpending: changeFor('recurringExpenseTotal')
  };

  const baseline = [];
  for (let offset = 1; offset <= 3; offset += 1) {
    const baselineMonth = offsetMonth(selectedMonth, -offset);
    let end = monthEnd(baselineMonth);
    if (selectedMonth === currentMonth) {
      end = `${baselineMonth}-${String(Math.min(Number(day), Number(end.slice(8, 10)))).padStart(2, '0')}`;
    }
    baseline.push(aggregatePeriod(transactions, `${baselineMonth}-01`, end, categorySettings));
  }
  const baselineMonthsWithExpenseData = baseline.filter(period => period.expenses.count > 0).length;
  const patterns = [];
  if (baselineMonthsWithExpenseData >= 2) {
    const names = new Set([...current.categories.map(x => x.category), ...baseline.flatMap(x => x.categories.map(c => c.category))]);
    for (const category of names) {
      const currentAmount = current.categories.find(x => x.category === category)?.amount || 0;
      const comparableBaseline = baseline.filter(period => period.expenses.count > 0);
      const baselineTotal = comparableBaseline.reduce((sum, period) => sum + (period.categories.find(x => x.category === category)?.amount || 0), 0);
      const baselineAverage = comparableBaseline.length ? baselineTotal / comparableBaseline.length : 0;
      if (baselineAverage > 0 && currentAmount >= baselineAverage * 1.3) {
        const increase = percentageChange(currentAmount, baselineAverage);
        patterns.push({
          type: 'category_increase',
          title: `${category} spending increased`,
          message: `${category} spending was ${increase.percent.toFixed(1)}% above the average of ${comparableBaseline.length} previous month${comparableBaseline.length === 1 ? '' : 's'} with recorded expenses.`,
          category,
          currentAmount,
          baselineMonthlyAverage: baselineAverage,
          baselineMonths: comparableBaseline.map(period => period.startDate.slice(0, 7)),
          change: increase,
          reason: `Current category expense is at least 30% above its average across ${comparableBaseline.length} months with recorded expenses.`,
          confidence: 'Measured from recorded expense transactions; this is a pattern, not a judgment.'
        });
      }
    }
  }

  const smallTransactions = transactions.filter(tx => tx.type === 'expense' && tx.date >= `${selectedMonth}-01` && tx.date <= currentEnd && Number(tx.amount) <= 500);
  const smallByCategory = new Map();
  for (const tx of smallTransactions) {
    const category = String(tx.category || 'Uncategorised').trim() || 'Uncategorised';
    const rows = smallByCategory.get(category) || [];
    rows.push(tx);
    smallByCategory.set(category, rows);
  }
  for (const [category, rows] of smallByCategory) {
    if (rows.length >= 5) {
      patterns.push({
        type: 'repeated_small_expenses',
        title: `Repeated small ${category} transactions`,
        message: `${rows.length} transactions of ₹500 or less totaled ₹${rows.reduce((sum, tx) => sum + tx.amount, 0).toLocaleString('en-IN')} in ${selectedMonth}.`,
        category,
        transactionCount: rows.length,
        amount: rows.reduce((sum, tx) => sum + tx.amount, 0),
        comparisonPeriod: selectedMonth,
        reason: 'At least five small expense transactions were recorded in the same category during the selected period.',
        confidence: 'Exact count and total from the selected month.'
      });
    }
  }

  const historicalExpenses = baseline.flatMap(period => transactions.filter(tx => tx.type === 'expense' && tx.date >= period.startDate && tx.date <= period.endDate).map(tx => Number(tx.amount)));
  const expenseMedian = median(historicalExpenses);
  if (historicalExpenses.length >= 8 && expenseMedian > 0) {
    const outliers = transactions.filter(tx => tx.type === 'expense' && tx.date >= `${selectedMonth}-01` && tx.date <= currentEnd && Number(tx.amount) >= expenseMedian * 3);
    for (const tx of outliers) {
      patterns.push({
        type: 'unusually_large_transaction',
        title: 'A transaction was larger than your recent pattern',
        message: `₹${Number(tx.amount).toLocaleString('en-IN')} for ${tx.category || 'Uncategorised'} was at least three times your recent median expense of ₹${expenseMedian.toLocaleString('en-IN')}.`,
        category: tx.category || 'Uncategorised',
        amount: Number(tx.amount),
        baselineMedian: expenseMedian,
        baselineTransactionCount: historicalExpenses.length,
        transactionDate: tx.date,
        reason: 'Compared with expense transactions in the previous three months.',
        confidence: 'Threshold is a descriptive outlier rule and does not imply the transaction was inappropriate.'
      });
    }
  }

  const today = now.toISOString().slice(0, 10);
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const within30 = new Date(todayDate.getTime() + 29 * 86400000).toISOString().slice(0, 10);
  const activeCommitments = recurringCommitments.filter(row => row.is_active === 1 || row.is_active === true);
  const enrichedCommitments = activeCommitments.map(row => ({ ...row, monthlyEstimate: normalizeRecurringMonthly(row) }));
  const recurringMonthlyTotal = enrichedCommitments.reduce((sum, row) => sum + row.monthlyEstimate, 0);
  const upcomingCommitments = enrichedCommitments.map(row => {
    const upcomingCount = countUpcomingOccurrences(row, today, within30);
    return { ...row, upcomingCount, upcomingAmount30Days: upcomingCount * Number(row.amount || 0) };
  }).filter(row => row.upcomingCount > 0);
  const overdueCommitments = enrichedCommitments.filter(row => row.next_date < today);
  const currentIncome = current.income.total;

  const goalInsights = (summary.goals || []).map(goal => {
    const remaining = Math.max(0, Number(goal.target_amount || 0) - Number(goal.current_amount || 0));
    let monthsRemaining = null;
    if (goal.target_date && /^\d{4}-\d{2}-\d{2}$/.test(goal.target_date) && goal.target_date >= today) {
      const targetMonth = goal.target_date.slice(0, 7);
      const delta = (Number(targetMonth.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(targetMonth.slice(5, 7)) - Number(today.slice(5, 7));
      monthsRemaining = Math.max(1, delta + 1);
    }
    let historicalPace = null;
    if (goal.bucket_id) {
      const paceMonths = [1, 2, 3].map(offset => {
        const paceMonth = offsetMonth(currentMonth, -offset);
        return transactions.filter(tx => tx.date.startsWith(paceMonth) && (
          (tx.type === 'transfer_bucket' && tx.to_bucket_id === goal.bucket_id) ||
          ((tx.type === 'income' || tx.type === 'refund') && tx.bucket_id === goal.bucket_id)
        )).reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
      });
      if (paceMonths.some(amount => amount > 0)) historicalPace = { monthlyAverage: paceMonths.reduce((sum, amount) => sum + amount, 0) / 3, months: 3, type: 'recorded contributions' };
    }
    return {
      id: goal.id,
      name: goal.name,
      targetDate: goal.target_date || null,
      currentAmount: Number(goal.current_amount || 0),
      targetAmount: Number(goal.target_amount || 0),
      percentageComplete: Number(goal.target_amount) > 0 ? Number(goal.current_amount || 0) / Number(goal.target_amount) * 100 : null,
      remainingAmount: remaining,
      requiredMonthlyContribution: monthsRemaining ? remaining / monthsRemaining : null,
      monthsRemaining,
      configuredMonthlyTarget: Number(goal.monthly_target || 0) || null,
      historicalContributionPace: historicalPace,
      deadlineStatus: goal.target_date && goal.target_date < today ? 'past' : 'current_or_future'
    };
  });

  const cashFlowMonths = [];
  const historicalMonthNames = [...new Set(transactions.filter(tx => FLOW_TYPES.has(tx.type) && tx.date <= currentEnd).map(tx => tx.date.slice(0, 7)))].sort();
  for (const historyMonth of historicalMonthNames.slice(-12)) {
    const period = aggregatePeriod(transactions, `${historyMonth}-01`, historyMonth === currentMonth ? currentEnd : monthEnd(historyMonth), categorySettings);
    if (period.transactionCount) cashFlowMonths.push({ month: historyMonth, income: period.income.total, expenses: period.expenses.total, netCashFlow: period.netCashFlow, savingsRate: period.savingsRate });
  }
  const savingsRateMonths = cashFlowMonths.filter(point => point.savingsRate !== null);

  const currentCreditCardLiabilities = (summary.accounts || []).filter(account => account.type === 'credit_card').reduce((sum, account) => sum + Math.abs(Math.min(0, Number(account.balance || 0))), 0);
  const totalLiabilities = Number(summary.totalPayables || 0) + currentCreditCardLiabilities;
  const emergency = summary.emergencyFundDetails || {};
  const emergencyFund = {
    balance: Number(emergency.balance || 0),
    essentialMonthlyExpenses: Number(emergency.essentialMonthlyExpenses || 0),
    monthsOfCoverage: Number(emergency.essentialMonthlyExpenses || 0) > 0 ? Number(emergency.monthsCovered) : null,
    targetAmount: Number(emergency.targetAmount || 0),
    targetSource: (summary.buckets || []).some(bucket => bucket.type === 'emergency' && Number(bucket.target_amount) > 0) ? 'configured bucket target' : 'existing application default',
    remainingToTarget: Number(emergency.remainingAmount || 0),
    coverageReason: Number(emergency.essentialMonthlyExpenses || 0) > 0 ? null : 'Coverage is unavailable because no essential monthly expenses are classified.'
  };

  const topCategories = [...categories].sort((a, b) => b.amount - a.amount).filter(row => row.amount > 0).slice(0, 5);
  const categorySort = [...categories].sort((a, b) => b.amount - a.amount);
  const increases = categoryChanges.filter(row => row.delta > 0);
  const decreases = categoryChanges.filter(row => row.delta < 0);
  const monthlyReview = {
    whatHappened: [
      `Income and refunds: ₹${current.income.total.toLocaleString('en-IN')} across ${current.income.count} transactions.`,
      `Expenses: ₹${current.expenses.total.toLocaleString('en-IN')} across ${current.expenses.count} transactions.`,
      `Net cash flow: ₹${current.netCashFlow.toLocaleString('en-IN')}.`,
      current.savingsRate === null ? current.savingsRateReason : `Savings rate: ${current.savingsRate.toFixed(1)}% = (income − expenses) ÷ income.`
    ],
    whatChanged: !comparisonAvailable
      ? [`Add transactions in ${previousMonth} to compare the selected period.`]
      : [
          `Income ${comparison.income.absolute >= 0 ? 'increased' : 'decreased'} by ₹${Math.abs(comparison.income.absolute).toLocaleString('en-IN')}${comparison.income.percent === null ? '' : ` (${comparison.income.percent.toFixed(1)}%)`}.`,
          `Expenses ${comparison.expenses.absolute >= 0 ? 'increased' : 'decreased'} by ₹${Math.abs(comparison.expenses.absolute).toLocaleString('en-IN')}${comparison.expenses.percent === null ? '' : ` (${comparison.expenses.percent.toFixed(1)}%)`}.`,
          ...(increases[0] ? [`Largest category increase: ${increases[0].category}, +₹${increases[0].delta.toLocaleString('en-IN')}.`] : []),
          ...(decreases[0] ? [`Largest category decrease: ${decreases[0].category}, −₹${Math.abs(decreases[0].delta).toLocaleString('en-IN')}.`] : [])
        ],
    attention: patterns.map(pattern => pattern.message),
    improved: comparisonAvailable && comparison.expenses.absolute < 0
      ? [`Recorded expenses were ₹${Math.abs(comparison.expenses.absolute).toLocaleString('en-IN')} lower than ${previousMonth}.`]
      : []
  };

  return {
    month,
    period: { start: current.startDate, end: current.endDate, isPartial: current.endDate !== monthEnd(month) },
    dataAvailability: {
      hasIncomeOrExpenseTransactions: current.hasTransactions,
      comparisonAvailable,
      comparisonReason: comparison.reason,
      categoryDataAvailable: current.expenses.count > 0,
      monthSelectionNote: current.endDate !== monthEnd(month) ? `Month-to-date through ${current.endDate}; previous month uses the same day-of-month cutoff.` : 'Complete selected calendar month.'
    },
    cashFlow: {
      income: current.income,
      expenses: current.expenses,
      netCashFlow: current.netCashFlow,
      savingsAmount: current.savingsAmount,
      savingsRate: current.savingsRate,
      savingsRateExplanation: current.savingsRate === null ? current.savingsRateReason : '(Income and refunds − expenses) ÷ income and refunds × 100.',
      excludedMovements: ['Account transfers', 'Bucket transfers', 'Starting balances', 'Investment-account movements', 'Loan repayments']
    },
    comparison,
    categories: categorySort,
    topCategories,
    spendingClassification: {
      essential: current.classified.essential,
      discretionary: current.classified.discretionary,
      unclassified: current.classified.unclassified,
      essentialPercentage: current.expenses.total > 0 ? current.classified.essential / current.expenses.total * 100 : null,
      discretionaryPercentage: current.expenses.total > 0 ? current.classified.discretionary / current.expenses.total * 100 : null,
      unclassifiedPercentage: current.expenses.total > 0 ? current.classified.unclassified / current.expenses.total * 100 : null,
      classificationNote: 'Uses category settings marked essential and the existing transaction necessity values. Useful, Planned, and Unclear expenses remain unclassified.'
    },
    patterns: {
      items: patterns,
      historicalBaselineMonths: baselineMonthsWithExpenseData,
      message: patterns.length ? null : (baselineMonthsWithExpenseData < 2 ? 'Not enough historical data yet to identify month-over-month patterns.' : 'No patterns met the displayed deterministic thresholds for this period.')
    },
    recurring: {
      activeCount: enrichedCommitments.length,
      monthlyTotal: recurringMonthlyTotal,
      projectedAnnualTotal: recurringMonthlyTotal * 12,
      annualProjectionLabel: 'Projection: estimated monthly commitments × 12; it is not a forecast.',
      percentageOfIncome: currentIncome > 0 ? recurringMonthlyTotal / currentIncome * 100 : null,
      percentageOfIncomeReason: currentIncome > 0 ? null : 'Unavailable because selected-period income is zero.',
      upcoming: upcomingCommitments,
      overdue: overdueCommitments,
      recordedRecurringExpense: current.recurringExpenseTotal,
      previousRecordedRecurringExpense: comparisonAvailable ? previous.recurringExpenseTotal : null
    },
    affordabilityAssumptions: {
      availableCash: Number(summary.availableCash || 0),
      currentMonthSpending: current.expenses.total,
      currentMonthSpendingTreatment: 'Shown as context; it is already reflected in current account balances and is not deducted again.',
      emergencyReserve: emergencyFund.balance,
      emergencyReserveTreatment: 'Excluded from the estimated remaining spendable balance; this is an explicit conservative assumption, not a safety verdict.'
    },
    emergencyFund,
    goals: goalInsights,
    netWorth: {
      current: Number(summary.netWorth || 0),
      previous: null,
      change: null,
      historicalComparisonAvailable: false,
      historicalReason: 'The current schema does not store point-in-time net-worth snapshots; account, lending, and liability histories cannot reliably reconstruct past net worth.',
      assets: Number(summary.availableCash || 0) + Number(summary.investments || 0) + Number(summary.totalReceivables || 0),
      liquidAssets: Number(summary.availableCash || 0),
      investmentAssets: Number(summary.investments || 0),
      receivables: Number(summary.totalReceivables || 0),
      liabilities: totalLiabilities,
      valuationNote: 'Uses the existing financial summary formula and recorded investment valuations only.'
    },
    charts: {
      cashFlowMonths,
      savingsRateMonths,
      savingsRateReason: savingsRateMonths.length >= 2 ? null : 'Add income in at least two months to compare historical savings rates.',
      netWorthMonths: [],
      netWorthReason: 'Historical net-worth snapshots are not stored.'
    },
    monthlyReview
  };
}

function calculateAffordabilityEstimate({ purchaseAmount, availableCash, upcomingCommitments, emergencyReserve, currentMonthSpending, targetBalance = 0 }) {
  const values = { purchaseAmount, availableCash, upcomingCommitments, emergencyReserve, currentMonthSpending, targetBalance };
  if (Object.values(values).some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) {
    throw new Error('Affordability values must be finite, non-negative numbers.');
  }
  const cash = Number(availableCash);
  const commitments = Number(upcomingCommitments);
  const reserve = Number(emergencyReserve);
  const target = Number(targetBalance);
  const amount = Number(purchaseAmount);
  const remainingBeforePurchase = cash - commitments - reserve - target;
  return {
    purchaseAmount: amount,
    availableCash: cash,
    upcomingCommitments: commitments,
    emergencyReserve: reserve,
    targetBalance: target,
    currentMonthSpending: Number(currentMonthSpending),
    remainingBeforePurchase,
    remainingAfterPurchase: remainingBeforePurchase - amount,
    assumptions: [
      'Upcoming commitments are subtracted once from current liquid account balances.',
      'The emergency-fund balance and optional target balance are treated as reserved amounts.',
      'Current-month spending is shown for context and is not subtracted again because it is already reflected in account balances.',
      'This estimate does not include unrecorded bills, future income, investment sales, or a recommendation about whether to buy.'
    ]
  };
}

function getFinancialInsights(db, userId, month, now = new Date()) {
  const selectedMonth = month || now.toISOString().slice(0, 7);
  if (!validMonth(selectedMonth)) throw new Error('Month must use YYYY-MM format.');
  const summary = getFinancialSummary(db, userId, selectedMonth);
  const transactions = db.prepare(`
    SELECT date, type, amount, category, necessity, description, is_recurring, source, bucket_id, to_bucket_id
    FROM transactions WHERE user_id = ? ORDER BY date ASC
  `).all(userId);
  const categorySettings = new Set(db.prepare('SELECT name FROM category_settings WHERE user_id = ? AND is_essential = 1').all(userId).map(row => String(row.name).toLowerCase()));
  const recurringCommitments = db.prepare(`
    SELECT id, name, type, amount, frequency, next_date, is_active
    FROM recurring_commitments WHERE user_id = ? AND is_active = 1 ORDER BY next_date ASC
  `).all(userId);
  return buildMonthlyInsights({ transactions, categorySettings, recurringCommitments, summary, month: selectedMonth, now });
}

function getAffordabilityEstimate(db, userId, purchaseAmount, targetBalance = 0, now = new Date()) {
  const insights = getFinancialInsights(db, userId, now.toISOString().slice(0, 7), now);
  const commitments = insights.recurring.upcoming.reduce((sum, item) => sum + Number(item.upcomingAmount30Days || 0), 0);
  const estimate = calculateAffordabilityEstimate({
    purchaseAmount,
    availableCash: insights.affordabilityAssumptions.availableCash,
    upcomingCommitments: commitments,
    emergencyReserve: insights.affordabilityAssumptions.emergencyReserve,
    currentMonthSpending: insights.affordabilityAssumptions.currentMonthSpending,
    targetBalance
  });
  return {
    ...estimate,
    upcomingCommitmentsDetail: insights.recurring.upcoming,
    interpretation: `After the listed commitments and reserves, the estimate leaves ₹${estimate.remainingAfterPurchase.toLocaleString('en-IN')} after this purchase. This is a calculation, not a safety recommendation.`
  };
}

module.exports = {
  validMonth,
  offsetMonth,
  percentageChange,
  aggregatePeriod,
  normalizeRecurringMonthly,
  countUpcomingOccurrences,
  buildMonthlyInsights,
  getFinancialInsights,
  calculateAffordabilityEstimate,
  getAffordabilityEstimate
};
