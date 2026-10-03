// WellnessCFO AI Intelligence & Command Center Assistant
const { sanitizeText, sanitizeFinancialContext } = require('./privacy');
const { extractAmount, parseNaturalLanguageTransaction } = require('./deterministic-parser');
const {
  getFinancialSummary,
  calculateEmergencyFund,
  calculateBusinessFund,
  getChartData
} = require('../financial-engine');
const { getFinancialInsights, getAffordabilityEstimate, offsetMonth } = require('../financial-insights');

// Opportunity Cost Projection (Deterministic Compound Math)
function calculateOpportunityCost(principal, yearsList = [5, 10, 20]) {
  const p = Math.abs(Number(principal)) || 0;
  // Conservative (8% index/debt), Moderate (12% diversified equity), Aggressive (14% high-growth)
  const rates = [
    { label: 'Conservative (8% CAGR)', rate: 0.08 },
    { label: 'Moderate (12% CAGR)', rate: 0.12 },
    { label: 'Growth (14% CAGR)', rate: 0.14 }
  ];

  const projections = yearsList.map(years => {
    const scenarios = rates.map(r => {
      // Lump-sum future value = P * (1 + r)^t
      const lumpSum = Math.round(p * Math.pow(1 + r.rate, years));
      // If invested as recurring monthly SIP of principal:
      // FV = P * [ (1+i)^n - 1 ] / i * (1+i) where i = r/12, n = years * 12
      const i = r.rate / 12;
      const n = years * 12;
      const monthlySipFV = Math.round(p * ((Math.pow(1 + i, n) - 1) / i) * (1 + i));
      return {
        rateLabel: r.label,
        rate: r.rate * 100,
        lumpSumFV: lumpSum,
        monthlySipFV
      };
    });

    return {
      years,
      scenarios
    };
  });

  return {
    principal: p,
    disclaimer: 'Illustrative estimate — not guaranteed. Assumes annual compounding with reinvestment.',
    projections
  };
}

// Affordability Engine (Deterministic Contextual Rules)
function evaluateAffordability(db, userId, rawQuery) {
  const clean = sanitizeText(rawQuery);
  const amount = extractAmount(clean);

  if (!amount || amount <= 0) {
    return {
      type: 'affordability',
      success: false,
      message: 'Please mention an amount to evaluate affordability (e.g., "Can I afford ₹3,000 shoes?").'
    };
  }

  const itemMatch = clean.match(/(?:afford|buy|purchase|get)\s+(?:₹|rs\.?|inr)?\s*[\d,k]+\s+(?:worth\s+of\s+)?([a-zA-Z\s]{2,25})\b/i);
  const itemName = itemMatch ? itemMatch[1].trim() : 'this purchase';
  const estimate = getAffordabilityEstimate(db, userId, amount);

  return {
    type: 'affordability',
    success: true,
    amount,
    itemName,
    verdict: 'estimate',
    badgeColor: 'gold',
    verdictTitle: estimate.interpretation,
    metrics: {
      availableCash: estimate.availableCash,
      upcomingCommitments: estimate.upcomingCommitments,
      emergencyReserve: estimate.emergencyReserve,
      currentMonthSpending: estimate.currentMonthSpending,
      remainingBeforePurchase: estimate.remainingBeforePurchase,
      remainingAfterPurchase: estimate.remainingAfterPurchase,
      targetBalance: estimate.targetBalance
    },
    observations: [
      `Available cash: ₹${estimate.availableCash.toLocaleString('en-IN')}.`,
      `Upcoming commitments: ₹${estimate.upcomingCommitments.toLocaleString('en-IN')} within the next 30 days.`,
      `Emergency reserve held aside: ₹${estimate.emergencyReserve.toLocaleString('en-IN')}.`,
      `Selected-month spending: ₹${estimate.currentMonthSpending.toLocaleString('en-IN')} (context only; not deducted again).`,
      `Estimated amount remaining after commitments, reserve, and purchase: ₹${estimate.remainingAfterPurchase.toLocaleString('en-IN')}.`
    ],
    assumptions: estimate.assumptions,
    disclaimer: 'This is a transparent estimate, not a judgment or a recommendation about whether to buy.'
  };
}

function detectMoneyLeaks(db, userId, month) {
  const insights = getFinancialInsights(db, userId, month);
  return {
    detectedCount: insights.patterns.items.length,
    leaks: insights.patterns.items,
    message: insights.patterns.message
  };
}

// Monthly CFO Review Memo Generator
function generateMonthlyReview(db, userId, targetMonth) {
  const insights = getFinancialInsights(db, userId, targetMonth);
  return {
    month: insights.month,
    cashFlow: {
      income: insights.cashFlow.income.total,
      spending: insights.cashFlow.expenses.total,
      savingsContribution: insights.cashFlow.savingsAmount,
      netSurplus: insights.cashFlow.netCashFlow,
      savingsRate: insights.cashFlow.savingsRate
    },
    comparison: insights.comparison,
    topCategories: insights.topCategories.map(row => ({ category: row.category, total: row.amount, percentage: row.percentage, change: row.change })),
    goals: insights.goals,
    emergencyRunway: insights.emergencyFund.monthsOfCoverage,
    leaksSummary: insights.patterns.items.slice(0, 2),
    observations: [...insights.monthlyReview.whatHappened, ...insights.monthlyReview.whatChanged, ...insights.monthlyReview.attention],
    monthlyReview: insights.monthlyReview,
    insights
  };
}

// Master AI Query & Command Center Dispatcher
async function processAIQuery(db, userId, queryText) {
  const cleanQuery = sanitizeText(queryText).trim();
  const lower = cleanQuery.toLowerCase();
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const selectedMonth = /\b(last|previous) month\b/.test(lower) ? offsetMonth(currentMonth, -1) : currentMonth;

  // Fetch contextual user data
  const summary = getFinancialSummary(db, userId);
  const accounts = summary.accounts || [];
  const buckets = summary.buckets || [];

  // Intent 1: Financial Action (Move money / Transfer)
  const isTransferAction = /\b(move|transfer|shift|allocate)\b/i.test(lower) && /\b(from|to)\b/i.test(lower) && extractAmount(cleanQuery);
  if (isTransferAction) {
    const parsed = parseNaturalLanguageTransaction(cleanQuery, accounts, buckets);
    if (parsed.isAction) {
      return {
        intent: 'action_proposal',
        actionType: 'transfer_bucket',
        amount: parsed.amount,
        fromBucketId: parsed.fromBucketId,
        fromBucketName: parsed.fromBucketName,
        toBucketId: parsed.toBucketId,
        toBucketName: parsed.toBucketName,
        title: `Confirm Money Movement`,
        message: `You requested to move ₹${parsed.amount.toLocaleString('en-IN')} from ${parsed.fromBucketName} to ${parsed.toBucketName}.`,
        details: [
          `Source: ${parsed.fromBucketName}`,
          `Destination: ${parsed.toBucketName}`,
          `Amount: ₹${parsed.amount.toLocaleString('en-IN')}`,
          `Impact: Pure internal allocation. Available cash and net worth remain unchanged.`
        ],
        requiresConfirmation: true
      };
    }
  }

  // Intent 2: Affordability Check ("Can I afford ₹3,000 shoes?")
  if (/\b(can i afford|afford|should i buy|can i buy)\b/i.test(lower)) {
    return evaluateAffordability(db, userId, cleanQuery);
  }

  // Intent 3: Opportunity Cost / Investment Projection ("What could ₹3,000 become if invested?")
  if (/\b(what could|invested|grow to|future value|opportunity cost|compound)\b/i.test(lower)) {
    const amount = extractAmount(cleanQuery) || 3000;
    const opp = calculateOpportunityCost(amount);
    return {
      type: 'opportunity_cost',
      title: `Opportunity Cost of ₹${amount.toLocaleString('en-IN')}`,
      amount,
      data: opp,
      message: `If ₹${amount.toLocaleString('en-IN')} is invested at a diversified 12% CAGR, it could grow to ~₹${opp.projections.find(p=>p.years===10)?.scenarios[1]?.lumpSumFV?.toLocaleString('en-IN')} in 10 years or ~₹${opp.projections.find(p=>p.years===20)?.scenarios[1]?.lumpSumFV?.toLocaleString('en-IN')} in 20 years.`
    };
  }

  // Intent 4: Money Leak Detection ("Show my money leaks", "unnecessary expenses")
  if (/\b(leaks?|money leaks?|unnecessary|wasteful|avoidable|bleed|spending patterns?)\b/i.test(lower)) {
    const leaks = detectMoneyLeaks(db, userId, selectedMonth);
    return {
      type: 'money_leaks',
      title: 'Recorded Spending Patterns',
      data: leaks,
      message: leaks.message || `${leaks.detectedCount} recorded patterns met the deterministic thresholds for ${selectedMonth}.`
    };
  }

  // Intent 5: Monthly CFO Review ("Generate monthly review", "how did I do this month")
  if (/\b(monthly review|review this month|summary of month|monthly report|cfo review|how did i do this month)\b/i.test(lower)) {
    const review = generateMonthlyReview(db, userId, selectedMonth);
    return {
      type: 'monthly_review',
      title: `Monthly CFO Review (${review.month})`,
      data: review,
      message: `Income: ₹${review.cashFlow.income.toLocaleString('en-IN')} | Spending: ₹${review.cashFlow.spending.toLocaleString('en-IN')} | Surplus: ₹${review.cashFlow.netSurplus.toLocaleString('en-IN')}`
    };
  }

  // Intent 6: Food Spending Inquiry ("How much did I spend on food this month?")
  if (/\b(how much|what)\s+(?:did i spend|spent)\s+(?:on\s+)?(food|groceries|dining|shopping|travel|uber|rent|utilities)/i.test(lower)) {
    const catMatch = lower.match(/(?:on\s+)?(food|groceries|dining|shopping|travel|uber|rent|utilities)/i);
    const term = catMatch ? catMatch[1] : 'food';

    const txs = db.prepare(`
      SELECT description, amount, date, category
      FROM transactions
      WHERE user_id = ? AND type = 'expense' AND date LIKE ? AND (LOWER(category) LIKE ? OR LOWER(description) LIKE ?)
      ORDER BY date DESC
    `).all(userId, `${selectedMonth}%`, `%${term}%`, `%${term}%`);

    const total = txs.reduce((s, t) => s + t.amount, 0);
    return {
      type: 'category_spending',
      category: term.charAt(0).toUpperCase() + term.slice(1),
      total,
      count: txs.length,
      transactions: txs.slice(0, 5),
      month: selectedMonth,
      message: `You recorded ₹${total.toLocaleString('en-IN')} across ${txs.length} matching expense transactions in ${selectedMonth}.`
    };
  }

  if (/\b(compare|compared|change|changed)\b/.test(lower) && /\bmonth\b/.test(lower)) {
    const insights = getFinancialInsights(db, userId, selectedMonth, now);
    return { type: 'monthly_comparison', month: selectedMonth, comparison: insights.comparison,
      message: insights.comparison.available
        ? `Compared with ${insights.comparison.previousMonth}: income ${insights.comparison.income.absolute >= 0 ? 'increased' : 'decreased'} by ₹${Math.abs(insights.comparison.income.absolute).toLocaleString('en-IN')}; expenses ${insights.comparison.expenses.absolute >= 0 ? 'increased' : 'decreased'} by ₹${Math.abs(insights.comparison.expenses.absolute).toLocaleString('en-IN')}.`
        : insights.comparison.reason };
  }

  if (/\b(how much|what)\s+(?:did i save|was my savings|is my savings)\b/.test(lower)) {
    const insights = getFinancialInsights(db, userId, selectedMonth, now);
    return { type: 'cash_flow_answer', month: selectedMonth, cashFlow: insights.cashFlow,
      message: `Recorded net cash flow (income and refunds minus expenses) in ${selectedMonth}: ₹${insights.cashFlow.savingsAmount.toLocaleString('en-IN')}${insights.cashFlow.savingsRate === null ? '. Savings rate unavailable because there was no income.' : `; savings rate ${insights.cashFlow.savingsRate.toFixed(1)}%.`}` };
  }

  if (/\b(how much|what)\s+(?:did i spend|was my spending|is my spending)\s+(?:this month|last month)?\b/.test(lower)) {
    const insights = getFinancialInsights(db, userId, selectedMonth, now);
    return { type: 'cash_flow_answer', month: selectedMonth, cashFlow: insights.cashFlow,
      message: `Recorded expenses in ${selectedMonth}: ₹${insights.cashFlow.expenses.total.toLocaleString('en-IN')} across ${insights.cashFlow.expenses.count} transactions.` };
  }

  if (/\b(recurring|subscriptions?|regular bills?)\b/.test(lower)) {
    const insights = getFinancialInsights(db, userId, selectedMonth, now);
    return { type: 'recurring_summary', recurring: insights.recurring,
      message: `${insights.recurring.activeCount} active recurring rules have an estimated monthly total of ₹${insights.recurring.monthlyTotal.toLocaleString('en-IN')}. ${insights.recurring.annualProjectionLabel}` };
  }

  // Intent 7: Investment query ("How much did I invest this year?")
  if (/\b(invest|invested|sip|stocks|portfolio)\b/i.test(lower) && /\b(how much|total|value)\b/i.test(lower)) {
    const totalInvest = summary.investments || 0;
    const sipTransfers = db.prepare(`
      SELECT SUM(amount) as s FROM transactions
      WHERE user_id = ? AND (category LIKE '%invest%' OR category LIKE '%sip%' OR type = 'transfer_bucket')
    `).get(userId).s || 0;

    return {
      type: 'investment_inquiry',
      title: 'Investment Capital Overview',
      totalInvestments: totalInvest,
      totalContributions: sipTransfers,
      allocations: summary.portfolioAllocations,
      message: `Your current total investment valuation is ₹${totalInvest.toLocaleString('en-IN')} across recorded holdings and SIPs.`
    };
  }

  // Intent 8: Natural Language Transaction Entry Preview
  if (extractAmount(cleanQuery)) {
    const parsed = parseNaturalLanguageTransaction(cleanQuery, accounts, buckets);
    return {
      type: 'transaction_preview',
      parsed,
      message: `Understood: ${parsed.type === 'income' ? 'Income' : 'Expense'} of ₹${parsed.amount.toLocaleString('en-IN')} for "${parsed.description}".`
    };
  }

  // Avoid presenting an unrelated snapshot as an answer to an unsupported question.
  return {
    type: 'clarification',
    title: 'I need a more specific question',
    message: 'I can summarize or compare monthly cash flow, report spending by a supported category, show recurring commitments, estimate a purchase balance, or preview a transaction. I do not have enough information to answer this request as written.'
  };
}

module.exports = {
  calculateOpportunityCost,
  evaluateAffordability,
  detectMoneyLeaks,
  generateMonthlyReview,
  processAIQuery
};
