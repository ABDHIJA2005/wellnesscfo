// WellnessCFO AI Intelligence & Command Center Assistant
const { sanitizeText, sanitizeFinancialContext } = require('./privacy');
const { extractAmount, parseNaturalLanguageTransaction } = require('./deterministic-parser');
const {
  getFinancialSummary,
  calculateEmergencyFund,
  calculateBusinessFund,
  getChartData
} = require('../financial-engine');

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

  // Extract item name if present (e.g., "shoes", "jacket", "laptop")
  const itemMatch = clean.match(/(?:afford|buy|purchase|get)\s+(?:₹|rs\.?|inr)?\s*[\d,k]+\s+(?:worth\s+of\s+)?([a-zA-Z\s]{2,25})\b/i);
  const itemName = itemMatch ? itemMatch[1].trim() : 'this purchase';

  const summary = getFinancialSummary(db, userId);
  const availableCash = summary.availableCash || 0;
  const spendingBucket = summary.buckets.find(b => b.type === 'spending');
  const spendingBalance = spendingBucket ? spendingBucket.balance : 0;
  const thisMonthSpent = summary.thisMonth.spending || 0;
  const thisMonthIncome = summary.thisMonth.income || 0;
  const emergencyCoverage = summary.emergencyFundDetails?.monthsCovered || 0;

  // Discretionary capital available
  const discretionary = Math.max(0, spendingBalance);
  const cashSurplus = Math.max(0, availableCash);

  // Projected impact
  const remainingDiscretionary = discretionary - amount;
  const remainingCash = cashSurplus - amount;
  const currentSurplus = thisMonthIncome - thisMonthSpent;
  const projectedSurplus = currentSurplus - amount;

  let verdict = 'affordable';
  let badgeColor = 'green';
  let verdictTitle = `You can comfortably afford this without compromising reserves.`;

  if (amount > availableCash) {
    verdict = 'unaffordable';
    badgeColor = 'rose';
    verdictTitle = `This exceeds your total available cash balance of ₹${availableCash.toLocaleString('en-IN')}.`;
  } else if (remainingDiscretionary < 0 && amount <= availableCash) {
    verdict = 'tight';
    badgeColor = 'gold';
    verdictTitle = `Affordable from cash, but exceeds your current Spending bucket allocation by ₹${Math.abs(remainingDiscretionary).toLocaleString('en-IN')}.`;
  }

  // Opportunity cost of this amount over 10 years at 12%
  const oppCost10yr = Math.round(amount * Math.pow(1 + 0.12, 10));

  return {
    type: 'affordability',
    success: true,
    amount,
    itemName,
    verdict,
    badgeColor,
    verdictTitle,
    metrics: {
      availableCash,
      spendingBucketBalance: discretionary,
      afterPurchaseDiscretionary: remainingDiscretionary,
      emergencyCoverageMonths: emergencyCoverage,
      projectedMonthlySurplus: projectedSurplus
    },
    observations: [
      `Available cash: ₹${availableCash.toLocaleString('en-IN')} across liquid bank and cash accounts.`,
      `Spending bucket balance: ₹${discretionary.toLocaleString('en-IN')}. ${remainingDiscretionary >= 0 ? `Leaves ₹${remainingDiscretionary.toLocaleString('en-IN')} for remaining discretionary expenses.` : `Would require pulling ₹${Math.abs(remainingDiscretionary).toLocaleString('en-IN')} from general cash reserves.`}`,
      `Your emergency fund coverage (${emergencyCoverage} months) will remain completely intact.`,
      `Opportunity cost: If invested instead at 12% CAGR, ₹${amount.toLocaleString('en-IN')} could grow to ~₹${oppCost10yr.toLocaleString('en-IN')} in 10 years.`
    ],
    disclaimer: 'This factual analysis outlines consequences and options. It does not make personal lifestyle decisions for you.'
  };
}

// Money Leak Detection Engine
function detectMoneyLeaks(db, userId) {
  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE user_id = ? AND type = 'expense'
    ORDER BY date DESC
  `).all(userId);

  const leaks = [];

  // 1. Check for repeated small purchases (< ₹300 occurring frequently)
  const microTx = transactions.filter(t => t.amount <= 300);
  if (microTx.length >= 5) {
    const totalMicro = microTx.reduce((s, t) => s + t.amount, 0);
    leaks.push({
      type: 'micro_spending',
      severity: 'moderate',
      title: 'Frequent Micro-Transactions',
      message: `You have ${microTx.length} small purchases under ₹300 totaling ₹${totalMicro.toLocaleString('en-IN')}. These small leaks often add up unnoticed.`,
      supportingCount: microTx.length,
      supportingAmount: totalMicro
    });
  }

  // 2. Check for Avoidable / Wasteful tagged purchases
  const avoidableTx = transactions.filter(t => t.necessity === 'Avoidable' || t.necessity === 'Wasteful');
  if (avoidableTx.length > 0) {
    const totalAvoidable = avoidableTx.reduce((s, t) => s + t.amount, 0);
    leaks.push({
      type: 'avoidable_spending',
      severity: 'high',
      title: 'Avoidable / Regretted Purchases',
      message: `${avoidableTx.length} expense(s) tagged as avoidable or wasteful totaling ₹${totalAvoidable.toLocaleString('en-IN')}.`,
      supportingCount: avoidableTx.length,
      supportingAmount: totalAvoidable,
      items: avoidableTx.slice(0, 3).map(t => ({ desc: t.description, amount: t.amount, date: t.date }))
    });
  }

  // 3. Category comparison: Current month vs previous month
  const now = new Date();
  const curMonthKey = now.toISOString().slice(0, 7);
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const curMonthTx = transactions.filter(t => String(t.date || '').startsWith(curMonthKey));
  const prevMonthTx = transactions.filter(t => String(t.date || '').startsWith(prevMonthKey));

  const curCatSums = {};
  for (const t of curMonthTx) {
    const c = t.category || 'General';
    curCatSums[c] = (curCatSums[c] || 0) + t.amount;
  }

  const prevCatSums = {};
  for (const t of prevMonthTx) {
    const c = t.category || 'General';
    prevCatSums[c] = (prevCatSums[c] || 0) + t.amount;
  }

  for (const [cat, curSum] of Object.entries(curCatSums)) {
    const prevSum = prevCatSums[cat] || 0;
    if (prevSum > 1000 && curSum > prevSum * 1.3) {
      const pctIncrease = Math.round(((curSum - prevSum) / prevSum) * 100);
      leaks.push({
        type: 'category_spike',
        severity: 'moderate',
        title: `${cat} Spike (+${pctIncrease}%)`,
        message: `You spent ₹${curSum.toLocaleString('en-IN')} on ${cat} this month vs ₹${prevSum.toLocaleString('en-IN')} last month (+${pctIncrease}%).`,
        supportingAmount: curSum - prevSum
      });
    }
  }

  return {
    detectedCount: leaks.length,
    leaks: leaks.length > 0 ? leaks : [{
      type: 'clean',
      severity: 'low',
      title: 'No Significant Leaks Detected',
      message: 'Spending patterns appear steady without unusual category spikes or excessive micro-transactions.'
    }]
  };
}

// Monthly CFO Review Memo Generator
function generateMonthlyReview(db, userId, targetMonth) {
  const now = new Date();
  const curMonth = targetMonth || now.toISOString().slice(0, 7);
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const summary = getFinancialSummary(db, userId, curMonth);
  const prevSummary = getFinancialSummary(db, userId, prevMonth);

  const curInc = summary.thisMonth.income;
  const curExp = summary.thisMonth.spending;
  const prevInc = prevSummary.thisMonth.income;
  const prevExp = prevSummary.thisMonth.spending;

  const incomeDelta = curInc - prevInc;
  const expenseDelta = curExp - prevExp;

  // Category breakdown
  const expenses = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM transactions
    WHERE user_id = ? AND type = 'expense' AND date LIKE ?
    GROUP BY category
    ORDER BY total DESC
  `).all(userId, curMonth + '%');

  const leaks = detectMoneyLeaks(db, userId);

  return {
    month: curMonth,
    cashFlow: {
      income: curInc,
      spending: curExp,
      savingsContribution: summary.thisMonth.savingsContribution,
      businessContribution: summary.thisMonth.businessContribution,
      investmentsContribution: summary.thisMonth.investmentsContribution,
      netSurplus: curInc - curExp
    },
    comparison: {
      prevMonth,
      incomeChange: incomeDelta,
      expenseChange: expenseDelta,
      expenseChangePct: prevExp > 0 ? Math.round((expenseDelta / prevExp) * 100) : 0
    },
    topCategories: expenses.slice(0, 5),
    goals: summary.goals,
    emergencyRunway: summary.emergencyFundDetails.monthsCovered,
    leaksSummary: leaks.leaks.slice(0, 2),
    observations: [
      `Net cash flow for ${curMonth} is ${curInc >= curExp ? 'positive' : 'negative'} at ₹${Math.abs(curInc - curExp).toLocaleString('en-IN')}.`,
      curExp > prevExp && prevExp > 0
        ? `Spending increased by ${Math.round((expenseDelta / prevExp) * 100)}% compared to ${prevMonth}.`
        : `Spending remained controlled relative to ${prevMonth}.`,
      `Emergency fund currently covers ${summary.emergencyFundDetails.monthsCovered} months of essential expenses.`
    ]
  };
}

// Master AI Query & Command Center Dispatcher
async function processAIQuery(db, userId, queryText) {
  const cleanQuery = sanitizeText(queryText).trim();
  const lower = cleanQuery.toLowerCase();

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
  if (/\b(leaks?|money leaks?|unnecessary|wasteful|avoidable|bleed)\b/i.test(lower)) {
    const leaks = detectMoneyLeaks(db, userId);
    return {
      type: 'money_leaks',
      title: 'Money Leak Analysis',
      data: leaks,
      message: `Identified ${leaks.detectedCount} spending pattern observations based on your transactions.`
    };
  }

  // Intent 5: Monthly CFO Review ("Generate monthly review", "how did I do this month")
  if (/\b(monthly review|review this month|summary of month|monthly report|cfo review)\b/i.test(lower)) {
    const review = generateMonthlyReview(db, userId);
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
      WHERE user_id = ? AND type = 'expense' AND (LOWER(category) LIKE ? OR LOWER(description) LIKE ?)
      ORDER BY date DESC
    `).all(userId, `%${term}%`, `%${term}%`);

    const total = txs.reduce((s, t) => s + t.amount, 0);
    return {
      type: 'category_spending',
      category: term.charAt(0).toUpperCase() + term.slice(1),
      total,
      count: txs.length,
      transactions: txs.slice(0, 5),
      message: `You spent a total of ₹${total.toLocaleString('en-IN')} across ${txs.length} transactions relating to "${term}".`
    };
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

  // General Financial Overview Fallback
  return {
    type: 'general_cfo_answer',
    title: 'Financial Position Snapshot',
    summary: {
      netWorth: summary.netWorth,
      availableCash: summary.availableCash,
      thisMonthIncome: summary.thisMonth.income,
      thisMonthSpending: summary.thisMonth.spending,
      emergencyCoverage: summary.emergencyFundDetails.monthsCovered
    },
    message: `Here is where things stand: Net Worth is ₹${summary.netWorth.toLocaleString('en-IN')}, Available Cash is ₹${summary.availableCash.toLocaleString('en-IN')}, and Emergency Runway is ${summary.emergencyFundDetails.monthsCovered} months.`
  };
}

module.exports = {
  calculateOpportunityCost,
  evaluateAffordability,
  detectMoneyLeaks,
  generateMonthlyReview,
  processAIQuery
};
