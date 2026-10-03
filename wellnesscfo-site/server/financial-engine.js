const crypto = require('node:crypto');

function setupDefaultEntities(db, userId) {
  const existingAccounts = db.prepare('SELECT COUNT(*) as c FROM accounts WHERE user_id = ?').get(userId);
  if (existingAccounts.c > 0) {
    // Ensure default goals exist even if accounts were created earlier
    ensureDefaultGoals(db, userId);
    return;
  }

  const now = new Date().toISOString();

  // Default accounts
  const defaultAccounts = [
    { id: 'acc_' + crypto.randomBytes(8).toString('hex'), name: 'Main Bank Account', type: 'bank', balance: 0 },
    { id: 'acc_' + crypto.randomBytes(8).toString('hex'), name: 'Cash in Hand', type: 'cash', balance: 0 },
    { id: 'acc_' + crypto.randomBytes(8).toString('hex'), name: 'Investment Holdings', type: 'investment', balance: 0 }
  ];

  for (const acc of defaultAccounts) {
    db.prepare(`
      INSERT INTO accounts (id, user_id, name, type, balance, currency, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, 'INR', 1, ?)
    `).run(acc.id, userId, acc.name, acc.type, acc.balance, now);
  }

  // Default buckets
  const defaultBuckets = [
    { id: 'bkt_' + crypto.randomBytes(8).toString('hex'), name: 'Spending', type: 'spending', balance: 0, target: 0 },
    { id: 'bkt_' + crypto.randomBytes(8).toString('hex'), name: 'Savings', type: 'savings', balance: 0, target: 100000 },
    { id: 'bkt_' + crypto.randomBytes(8).toString('hex'), name: 'Emergency Fund', type: 'emergency', balance: 0, target: 150000 },
    { id: 'bkt_' + crypto.randomBytes(8).toString('hex'), name: 'Investments', type: 'investments', balance: 0, target: 500000 },
    { id: 'bkt_' + crypto.randomBytes(8).toString('hex'), name: 'Business Fund', type: 'business', balance: 0, target: 100000 }
  ];

  for (const bkt of defaultBuckets) {
    db.prepare(`
      INSERT INTO buckets (id, user_id, name, type, balance, target_amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bkt.id, userId, bkt.name, bkt.type, bkt.balance, bkt.target, now);
  }

  ensureDefaultGoals(db, userId);
}

function ensureDefaultGoals(db, userId) {
  const existingGoals = db.prepare('SELECT COUNT(*) as c FROM goals WHERE user_id = ?').get(userId);
  if (existingGoals.c > 0) return;

  const buckets = db.prepare('SELECT id, name, type, target_amount FROM buckets WHERE user_id = ?').all(userId);
  const now = new Date().toISOString();

  for (const bkt of buckets) {
    if (['emergency', 'business', 'savings', 'investments'].includes(bkt.type)) {
      const goalId = 'goal_' + crypto.randomBytes(8).toString('hex');
      const target = bkt.target_amount || (bkt.type === 'emergency' ? 150000 : 100000);
      db.prepare(`
        INSERT INTO goals (id, user_id, bucket_id, name, type, target_amount, target_date, monthly_target, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)
      `).run(goalId, userId, bkt.id, bkt.name, bkt.type, target, now);
    }
  }
}

function recordTransaction(db, userId, tx) {
  const id = tx.id || 'tx_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const amount = Math.abs(Number(tx.amount));
  if (!Number.isFinite(amount) || amount === 0) {
    throw new Error('Valid non-zero amount is required');
  }

  const type = tx.type || (Number(tx.amount) >= 0 ? 'income' : 'expense');
  const date = tx.date || now.slice(0, 10);
  const description = (tx.description || 'Transaction').trim();
  const category = (tx.category || 'General').trim();
  const necessity = tx.necessity || 'Unclear';
  const notes = tx.notes || null;
  const source = tx.source || null;
  const isRecurring = tx.is_recurring ? 1 : 0;

  // Find or use provided account
  let accountId = tx.account_id;
  if (!accountId) {
    const defaultAcc = db.prepare(`SELECT id FROM accounts WHERE user_id = ? AND type = 'bank' AND is_active = 1 LIMIT 1`).get(userId);
    accountId = defaultAcc ? defaultAcc.id : null;
  }

  // Find or use provided bucket
  let bucketId = tx.bucket_id;
  if (!bucketId) {
    const bucketType = (category.toLowerCase().includes('invest') || category.toLowerCase().includes('sip')) ? 'investments'
      : (type === 'income' ? 'spending' : 'spending');
    const defaultBkt = db.prepare(`SELECT id FROM buckets WHERE user_id = ? AND type = ? LIMIT 1`).get(userId, bucketType);
    bucketId = defaultBkt ? defaultBkt.id : null;
  }

  db.exec('SAVEPOINT transaction_write;');
  try {
    db.prepare(`
      INSERT INTO transactions (
        id, user_id, account_id, bucket_id, type, amount, date,
        description, category, necessity, notes, source, is_recurring, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, accountId, bucketId, type, amount, date, description, category, necessity, notes, source, isRecurring, now);

    // Update account balance
    if (accountId) {
      if (type === 'income' || type === 'refund') {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, accountId, userId);
      } else if (type === 'expense') {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(amount, accountId, userId);
      }
    }

    // Update bucket balance
    if (bucketId) {
      if (type === 'income' || type === 'refund') {
        db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, bucketId, userId);
      } else if (type === 'expense') {
        db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(amount, bucketId, userId);
      }
    }

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { id, userId, accountId, bucketId, type, amount, date, description, category, necessity };
}

function updateTransaction(db, userId, txId, updates) {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(txId, userId);
  if (!existing) {
    throw new Error('Transaction not found');
  }

  const newAmount = updates.amount !== undefined ? Math.abs(Number(updates.amount)) : existing.amount;
  const newType = updates.type || existing.type;
  const newDate = updates.date || existing.date;
  const newDesc = updates.description !== undefined ? String(updates.description).trim() : existing.description;
  const newCategory = updates.category !== undefined ? String(updates.category).trim() : existing.category;
  const newNecessity = updates.necessity || existing.necessity;
  const newAccId = updates.account_id !== undefined ? updates.account_id : existing.account_id;
  const newBktId = updates.bucket_id !== undefined ? updates.bucket_id : existing.bucket_id;

  db.exec('SAVEPOINT transaction_write;');
  try {
    // 1. Reverse old transaction effect
    if (existing.account_id) {
      if (existing.type === 'income' || existing.type === 'refund') {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.account_id, userId);
      } else if (existing.type === 'expense') {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.account_id, userId);
      }
    }
    if (existing.bucket_id) {
      if (existing.type === 'income' || existing.type === 'refund') {
        db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.bucket_id, userId);
      } else if (existing.type === 'expense') {
        db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.bucket_id, userId);
      }
    }

    // 2. Apply new transaction effect
    if (newAccId) {
      if (newType === 'income' || newType === 'refund') {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(newAmount, newAccId, userId);
      } else if (newType === 'expense') {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(newAmount, newAccId, userId);
      }
    }
    if (newBktId) {
      if (newType === 'income' || newType === 'refund') {
        db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(newAmount, newBktId, userId);
      } else if (newType === 'expense') {
        db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(newAmount, newBktId, userId);
      }
    }

    // 3. Update transaction record
    db.prepare(`
      UPDATE transactions
      SET account_id = ?, bucket_id = ?, type = ?, amount = ?, date = ?,
          description = ?, category = ?, necessity = ?
      WHERE id = ? AND user_id = ?
    `).run(newAccId, newBktId, newType, newAmount, newDate, newDesc, newCategory, newNecessity, txId, userId);

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { id: txId, amount: newAmount, type: newType, date: newDate, description: newDesc, category: newCategory };
}

function deleteTransaction(db, userId, txId) {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(txId, userId);
  if (!existing) {
    throw new Error('Transaction not found');
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    // Reverse balance impacts
    if (existing.type === 'transfer_account') {
      if (existing.account_id && existing.to_account_id) {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.account_id, userId);
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.to_account_id, userId);
      }
    } else if (existing.type === 'transfer_bucket') {
      if (existing.bucket_id && existing.to_bucket_id) {
        db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.bucket_id, userId);
        db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.to_bucket_id, userId);
      }
    } else {
      if (existing.account_id) {
        if (existing.type === 'income' || existing.type === 'refund') {
          db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.account_id, userId);
        } else if (existing.type === 'expense') {
          db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.account_id, userId);
        }
      }
      if (existing.bucket_id) {
        if (existing.type === 'income' || existing.type === 'refund') {
          db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.bucket_id, userId);
        } else if (existing.type === 'expense') {
          db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(existing.amount, existing.bucket_id, userId);
        }
      }
    }

    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(txId, userId);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { success: true, deletedId: txId };
}

function recordAccountTransfer(db, userId, { fromAccountId, toAccountId, amount, date, description }) {
  const numAmount = Math.abs(Number(amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error('Valid transfer amount required');
  }
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    throw new Error('Distinct source and destination accounts are required');
  }

  const fromAcc = db.prepare('SELECT id, name FROM accounts WHERE id = ? AND user_id = ?').get(fromAccountId, userId);
  const toAcc = db.prepare('SELECT id, name FROM accounts WHERE id = ? AND user_id = ?').get(toAccountId, userId);
  if (!fromAcc || !toAcc) {
    throw new Error('Both accounts must belong to the user');
  }

  const now = new Date().toISOString();
  const txDate = date || now.slice(0, 10);
  const desc = description || `Transfer: ${fromAcc.name} → ${toAcc.name}`;
  const id = 'tx_' + crypto.randomBytes(8).toString('hex');

  db.exec('SAVEPOINT transaction_write;');
  try {
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(numAmount, fromAccountId, userId);
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(numAmount, toAccountId, userId);

    db.prepare(`
      INSERT INTO transactions (
        id, user_id, account_id, to_account_id, type, amount, date,
        description, category, created_at
      ) VALUES (?, ?, ?, ?, 'transfer_account', ?, ?, ?, 'Transfer', ?)
    `).run(id, userId, fromAccountId, toAccountId, numAmount, txDate, desc, now);

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { id, fromAccountId, toAccountId, amount: numAmount, date: txDate, description: desc };
}

function recordBucketTransfer(db, userId, { fromBucketId, toBucketId, amount, date, description }) {
  const numAmount = Math.abs(Number(amount));
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    throw new Error('Valid transfer amount required');
  }
  if (!fromBucketId || !toBucketId || fromBucketId === toBucketId) {
    throw new Error('Distinct source and destination buckets are required');
  }

  const fromBkt = db.prepare('SELECT id, name, type, balance FROM buckets WHERE id = ? AND user_id = ?').get(fromBucketId, userId);
  const toBkt = db.prepare('SELECT id, name, type, balance FROM buckets WHERE id = ? AND user_id = ?').get(toBucketId, userId);
  if (!fromBkt || !toBkt) {
    throw new Error('Both buckets must belong to the user');
  }

  const now = new Date().toISOString();
  const txDate = date || now.slice(0, 10);
  const desc = description || `Allocation: ${fromBkt.name} → ${toBkt.name}`;
  const id = 'tx_' + crypto.randomBytes(8).toString('hex');

  // Emergency Fund withdrawal check
  let warning = null;
  let isEmergencyWithdrawal = false;
  if (fromBkt.type === 'emergency') {
    isEmergencyWithdrawal = true;
    const newBal = fromBkt.balance - numAmount;
    warning = `Warning: You are withdrawing ₹${numAmount.toLocaleString('en-IN')} from your Emergency Fund. New balance will be ₹${Math.max(0, newBal).toLocaleString('en-IN')}.`;
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare('UPDATE buckets SET balance = balance - ? WHERE id = ? AND user_id = ?').run(numAmount, fromBucketId, userId);
    db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(numAmount, toBucketId, userId);

    db.prepare(`
      INSERT INTO transactions (
        id, user_id, bucket_id, to_bucket_id, type, amount, date,
        description, category, created_at
      ) VALUES (?, ?, ?, ?, 'transfer_bucket', ?, ?, ?, 'Allocation', ?)
    `).run(id, userId, fromBucketId, toBucketId, numAmount, txDate, desc, now);

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    id,
    fromBucketId,
    toBucketId,
    amount: numAmount,
    date: txDate,
    description: desc,
    warning,
    isEmergencyWithdrawal
  };
}

function calculateEmergencyFund(db, userId) {
  const emergencyBkt = db.prepare(`SELECT * FROM buckets WHERE user_id = ? AND type = 'emergency' LIMIT 1`).get(userId);
  const balance = emergencyBkt ? (emergencyBkt.balance || 0) : 0;
  const targetAmount = emergencyBkt && emergencyBkt.target_amount > 0 ? emergencyBkt.target_amount : 150000;

  // Calculate monthly essential expenses
  // Default essential terms: groceries, food, utilities, rent, healthcare, medicine, insurance, bills
  const essentialTerms = ['grocer', 'food', 'utilit', 'rent', 'medic', 'health', 'insur', 'bill'];
  
  // Custom user essential categories
  const userEssentials = db.prepare(`SELECT name FROM category_settings WHERE user_id = ? AND is_essential = 1`).all(userId).map(c => c.name.toLowerCase());

  const expenses = db.prepare(`
    SELECT amount, date, category FROM transactions
    WHERE user_id = ? AND type = 'expense'
  `).all(userId);

  const monthlyEssentialSums = {};
  for (const tx of expenses) {
    const cat = (tx.category || '').toLowerCase();
    const isEssential = userEssentials.includes(cat) || essentialTerms.some(term => cat.includes(term));
    if (isEssential) {
      const month = String(tx.date || '').slice(0, 7);
      monthlyEssentialSums[month] = (monthlyEssentialSums[month] || 0) + tx.amount;
    }
  }

  const monthKeys = Object.keys(monthlyEssentialSums);
  let essentialMonthlyExpenses = 0;
  if (monthKeys.length > 0) {
    const total = monthKeys.reduce((s, m) => s + monthlyEssentialSums[m], 0);
    essentialMonthlyExpenses = Math.round(total / monthKeys.length);
  } else {
    // If no essential transactions logged yet, use 0
    essentialMonthlyExpenses = 0;
  }

  const monthsCovered = essentialMonthlyExpenses > 0 ? Number((balance / essentialMonthlyExpenses).toFixed(1)) : (balance > 0 ? 99 : 0);
  const threeMonthTarget = essentialMonthlyExpenses * 3;
  const sixMonthTarget = essentialMonthlyExpenses * 6;
  const progressPct = targetAmount > 0 ? Math.min(100, Math.round((balance / targetAmount) * 100)) : 100;
  const remainingAmount = Math.max(0, targetAmount - balance);

  return {
    balance,
    targetAmount,
    essentialMonthlyExpenses,
    monthsCovered,
    threeMonthTarget,
    sixMonthTarget,
    progressPct,
    remainingAmount
  };
}

function calculateBusinessFund(db, userId) {
  const bkt = db.prepare(`SELECT * FROM buckets WHERE user_id = ? AND type = 'business' LIMIT 1`).get(userId);
  const balance = bkt ? (bkt.balance || 0) : 0;
  const targetAmount = bkt && bkt.target_amount > 0 ? bkt.target_amount : 100000;
  const progressPct = targetAmount > 0 ? Math.min(100, Math.round((balance / targetAmount) * 100)) : 100;
  const remainingAmount = Math.max(0, targetAmount - balance);

  const bktId = bkt ? bkt.id : null;
  const incoming = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as s FROM transactions
    WHERE user_id = ? AND ((type = 'transfer_bucket' AND to_bucket_id = ?) OR (type = 'income' AND bucket_id = ?))
  `).get(userId, bktId, bktId).s;

  const outgoing = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as s FROM transactions
    WHERE user_id = ? AND type = 'transfer_bucket' AND bucket_id = ?
  `).get(userId, bktId).s;

  const businessExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as s FROM transactions
    WHERE user_id = ? AND type = 'expense' AND (bucket_id = ? OR category LIKE '%business%')
  `).get(userId, bktId).s;

  return {
    balance,
    targetAmount,
    progressPct,
    remainingAmount,
    totalContributions: incoming,
    totalWithdrawals: outgoing,
    businessExpenses
  };
}

function getGoals(db, userId) {
  setupDefaultEntities(db, userId);
  const goals = db.prepare(`
    SELECT g.id, g.name, g.type, g.target_amount, g.target_date, g.monthly_target, g.bucket_id,
           COALESCE(b.balance, 0) as current_amount
    FROM goals g
    LEFT JOIN buckets b ON b.id = g.bucket_id
    WHERE g.user_id = ?
    ORDER BY g.created_at ASC
  `).all(userId);

  return goals.map(g => {
    const current = g.current_amount || 0;
    const target = g.target_amount || 0;
    const progressPct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 100;
    const remaining = Math.max(0, target - current);
    return {
      ...g,
      current_amount: current,
      progressPct,
      remainingAmount: remaining
    };
  });
}

function getChartData(db, userId, interval = 'monthly') {
  const transactions = db.prepare(`
    SELECT id, type, amount, date, category, bucket_id, to_bucket_id
    FROM transactions
    WHERE user_id = ?
    ORDER BY date ASC
  `).all(userId);

  // 1. Group by interval
  const cashFlowMap = {};
  const allocationMap = { savings: 0, investments: 0, business: 0, spending: 0 };
  const categoryMap = {};

  const now = new Date();

  function getPeriodKey(dateStr) {
    if (!dateStr) return '';
    if (interval === 'daily') {
      return dateStr.slice(0, 10);
    } else if (interval === 'weekly') {
      const d = new Date(dateStr + 'T00:00:00');
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const weekNo = Math.ceil((((d - startOfYear) / 86400000) + startOfYear.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    } else if (interval === 'yearly') {
      return dateStr.slice(0, 4);
    }
    // Default: monthly YYYY-MM
    return dateStr.slice(0, 7);
  }

  // Determine periods to generate
  let periodKeys = [];
  if (interval === 'daily') {
    // Last 14 days
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      periodKeys.push(`${y}-${day < 10 ? '0' + +day : day}`); // YYYY-MM-DD
    }
    // ensure exact YYYY-MM-DD
    periodKeys = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dt = String(d.getDate()).padStart(2, '0');
      periodKeys.push(`${y}-${m}-${dt}`);
    }
  } else if (interval === 'weekly') {
    // Last 8 weeks
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i * 7);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dt = String(d.getDate()).padStart(2, '0');
      const k = getPeriodKey(`${y}-${m}-${dt}`);
      if (!periodKeys.includes(k)) periodKeys.push(k);
    }
  } else if (interval === 'yearly') {
    const curYear = now.getFullYear();
    for (let y = curYear - 2; y <= curYear; y++) {
      periodKeys.push(String(y));
    }
  } else {
    // Last 6 months (using local year and month)
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 15); // Use mid-month to avoid DST/timezone edge
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      periodKeys.push(`${y}-${m}`);
    }
  }

  // Initialize cash flow map with 0s
  for (const k of periodKeys) {
    cashFlowMap[k] = { period: k, income: 0, expense: 0, net: 0 };
  }

  // Get buckets for allocation identification
  const buckets = db.prepare('SELECT id, type FROM buckets WHERE user_id = ?').all(userId);
  const bucketTypeMap = {};
  for (const b of buckets) {
    bucketTypeMap[b.id] = b.type;
  }

  for (const tx of transactions) {
    const k = getPeriodKey(tx.date);
    if (cashFlowMap[k]) {
      if (tx.type === 'income' || tx.type === 'refund') {
        cashFlowMap[k].income += tx.amount;
        cashFlowMap[k].net += tx.amount;
      } else if (tx.type === 'expense') {
        cashFlowMap[k].expense += tx.amount;
        cashFlowMap[k].net -= tx.amount;
      }
    }

    // Allocation tracking
    if (tx.type === 'expense') {
      allocationMap.spending += tx.amount;
      const cat = tx.category || 'Uncategorised';
      categoryMap[cat] = (categoryMap[cat] || 0) + tx.amount;
    } else if (tx.type === 'transfer_bucket') {
      const toType = bucketTypeMap[tx.to_bucket_id];
      if (toType === 'savings' || toType === 'emergency') {
        allocationMap.savings += tx.amount;
      } else if (toType === 'investments') {
        allocationMap.investments += tx.amount;
      } else if (toType === 'business') {
        allocationMap.business += tx.amount;
      }
    }
  }

  // Category breakdown
  const categoryBreakdown = Object.entries(categoryMap).map(([category, amount]) => ({
    category,
    amount
  })).sort((a, b) => b.amount - a.amount);

  const totalSpent = allocationMap.spending || 1;
  const categoryPercentages = categoryBreakdown.map(c => ({
    ...c,
    percentage: Math.round((c.amount / totalSpent) * 100)
  }));

  return {
    interval,
    cashFlow: periodKeys.map(k => cashFlowMap[k]),
    allocation: allocationMap,
    categories: categoryPercentages
  };
}

function getFinancialSummary(db, userId, targetMonth) {
  setupDefaultEntities(db, userId);

  const month = targetMonth || new Date().toISOString().slice(0, 7);

  // Accounts
  const accounts = db.prepare(`
    SELECT id, name, type, balance, currency, is_active
    FROM accounts
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);

  // Liquid accounts: bank, cash, wallet
  const liquidAccounts = accounts.filter(a => ['bank', 'cash', 'wallet'].includes(a.type) && a.is_active === 1);
  const availableCash = liquidAccounts.reduce((acc, a) => acc + (a.balance || 0), 0);

  // Investment accounts & snapshots
  const investmentAccounts = accounts.filter(a => a.type === 'investment' && a.is_active === 1);
  const investmentAccountBalance = investmentAccounts.reduce((acc, a) => acc + (a.balance || 0), 0);

  // Latest portfolio snapshots per kind
  const snapshots = db.prepare(`
    SELECT kind, value, as_of
    FROM portfolio_snapshots
    WHERE user_id = ?
    ORDER BY as_of DESC
  `).all(userId);

  const latestSnapshotsByKind = {};
  for (const s of snapshots) {
    if (!latestSnapshotsByKind[s.kind]) {
      latestSnapshotsByKind[s.kind] = s;
    }
  }
  // Phase 4: Tracked investment holdings
  const trackedInvestments = db.prepare(`SELECT * FROM investments WHERE user_id = ?`).all(userId);
  const trackedInvestmentsTotal = trackedInvestments.reduce((sum, inv) => sum + (inv.current_value > 0 ? inv.current_value : (inv.invested_amount || 0)), 0);
  const snapshotTotal = Object.values(latestSnapshotsByKind).reduce((sum, s) => sum + (s.value || 0), 0);
  const totalInvestments = investmentAccountBalance + snapshotTotal + trackedInvestmentsTotal;

  // Phase 4: Lending / Borrowing
  const activeLent = db.prepare(`SELECT COALESCE(SUM(outstanding_amount), 0) as s FROM lending_records WHERE user_id = ? AND type = 'lent' AND status = 'active'`).get(userId).s;
  const activeBorrowed = db.prepare(`SELECT COALESCE(SUM(outstanding_amount), 0) as s FROM lending_records WHERE user_id = ? AND type = 'borrowed' AND status = 'active'`).get(userId).s;

  // Liabilities (Credit cards: debt deducted + active borrowed money)
  const creditCards = accounts.filter(a => a.type === 'credit_card');
  const creditCardLiabilities = creditCards.reduce((sum, a) => sum + Math.abs(Math.min(0, a.balance || 0)), 0);
  const totalLiabilities = creditCardLiabilities + activeBorrowed;

  // Net Worth = Available Cash + Total Investments + Money Lent (Receivables) - Total Liabilities (Credit Cards + Money Borrowed)
  const netWorth = availableCash + totalInvestments + activeLent - totalLiabilities;

  // Buckets
  const buckets = db.prepare(`
    SELECT id, name, type, balance, target_amount, target_date, monthly_target
    FROM buckets
    WHERE user_id = ?
    ORDER BY created_at ASC
  `).all(userId);

  const emergencyBucket = buckets.find(b => b.type === 'emergency');
  const businessBucket = buckets.find(b => b.type === 'business');
  const savingsBucket = buckets.find(b => b.type === 'savings');

  // Transactions this month
  const monthPrefix = month + '%';
  const monthTransactions = db.prepare(`
    SELECT id, account_id, to_account_id, bucket_id, to_bucket_id, type, amount, date, description, category, necessity
    FROM transactions
    WHERE user_id = ? AND date LIKE ?
    ORDER BY date DESC
  `).all(userId, monthPrefix);

  const income = monthTransactions
    .filter(t => t.type === 'income' || t.type === 'refund')
    .reduce((sum, t) => sum + t.amount, 0);

  const spending = monthTransactions
    .filter(t => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);

  const savingsTransfers = monthTransactions
    .filter(t => t.type === 'transfer_bucket' && t.to_bucket_id === (savingsBucket ? savingsBucket.id : null))
    .reduce((sum, t) => sum + t.amount, 0);

  const businessTransfers = monthTransactions
    .filter(t => t.type === 'transfer_bucket' && t.to_bucket_id === (businessBucket ? businessBucket.id : null))
    .reduce((sum, t) => sum + t.amount, 0);

  const investmentTransfers = monthTransactions
    .filter(t => t.type === 'transfer_bucket' && t.to_bucket_id === (buckets.find(b => b.type === 'investments')?.id || null))
    .reduce((sum, t) => sum + t.amount, 0);

  // Daily series for sparklines
  const daysInMonth = 14;
  const today = new Date();
  const dailySeries = [];
  for (let i = daysInMonth - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayIncome = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as s
      FROM transactions
      WHERE user_id = ? AND date = ? AND (type = 'income' OR type = 'refund')
    `).get(userId, dateStr).s;
    const daySpending = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as s
      FROM transactions
      WHERE user_id = ? AND date = ? AND type = 'expense'
    `).get(userId, dateStr).s;
    dailySeries.push({ date: dateStr, income: dayIncome, spending: daySpending });
  }

  // Dynamic Portfolio Allocation
  const portfolioAllocations = [];
  if (totalInvestments > 0) {
    if (Object.keys(latestSnapshotsByKind).length > 0) {
      for (const [kind, s] of Object.entries(latestSnapshotsByKind)) {
        const pct = Math.round((s.value / totalInvestments) * 100);
        portfolioAllocations.push({ kind, value: s.value, percentage: pct });
      }
    } else {
      portfolioAllocations.push({ kind: 'Holdings', value: totalInvestments, percentage: 100 });
    }
  }

  // Emergency & Business Fund Intelligence
  const emergencyFundDetails = calculateEmergencyFund(db, userId);
  const businessFundDetails = calculateBusinessFund(db, userId);
  const goals = getGoals(db, userId);

  return {
    netWorth,
    availableCash,
    investments: totalInvestments,
    totalReceivables: activeLent,
    totalPayables: activeBorrowed,
    lendingSummary: {
      totalLent: activeLent,
      totalBorrowed: activeBorrowed,
      netBalance: activeLent - activeBorrowed
    },
    portfolioAllocations,
    emergencyFund: emergencyBucket ? emergencyBucket.balance : 0,
    emergencyFundDetails,
    businessFund: businessBucket ? businessBucket.balance : 0,
    businessFundDetails,
    savingsFund: savingsBucket ? savingsBucket.balance : 0,
    thisMonth: {
      month,
      income,
      spending,
      savingsContribution: savingsTransfers,
      businessContribution: businessTransfers,
      investmentsContribution: investmentTransfers,
      dailySeries
    },
    accounts,
    buckets,
    goals
  };
}

function normalizeImportDate(value) {
  if (!value && value !== 0) return '';
  const str = String(value).trim();
  if (!str) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(`${str}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str ? '' : str;
  }
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(str)) {
    const m = str.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
    if (!m) return '';
    let day = Number(m[1]);
    let month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (day > 12 && month <= 12) {
      const t = day; day = month; month = t;
    } else if (month > 12 && day <= 12) {
      const t = month; month = day; day = t;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';
    const result = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsedDate = new Date(`${result}T00:00:00Z`);
    return Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== result ? '' : result;
  }

  const parsed = Date.parse(str);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeImportDescription(value) {
  let description = String(value || '').replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, 500) || 'Imported transaction';
  if (/^[=+@\-\t]/.test(description)) description = `'${description}`;
  return description;
}

function normalizeImportAmount(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const source = String(value).trim().replace(/^(?:INR|Rs\.?|₹|\$)\s*/i, '').replace(/\s*(?:INR|Rs\.?|₹|\$)$/i, '');
  const parenNegative = /^\(.*\)$/.test(source);
  const str = source.replace(/[(),\s]/g, '');
  const parsed = Number(str);
  const num = parenNegative ? -Math.abs(parsed) : parsed;
  return Number.isFinite(num) ? num : NaN;
}

function classifyImportedRow(raw) {
  const rawType = String(raw && (raw.type || raw.transactionType || raw.transaction_type || raw.entryType || raw.drCr || raw.direction || '')).trim().toLowerCase();
  const description = normalizeImportDescription(raw && (raw.description || raw.narration || raw.remarks || raw.details || raw.particulars || raw.merchant || 'Imported transaction'));
  const lowers = description.toLowerCase();

  if (rawType && ['unknown', 'ambiguous', 'unsure', 'manual', 'n/a', 'na', 'null', 'none'].includes(rawType)) {
    return { type: 'ambiguous', reason: 'explicitly marked as unknown or ambiguous' };
  }

  if (['transfer_account', 'transfer', 'investment', 'investment_contribution', 'sip', 'contribution', 'lending_new', 'lending_repayment'].includes(rawType)) {
    const type = rawType.startsWith('transfer') || rawType === 'transfer' ? 'transfer' : rawType.startsWith('lending') ? 'lending' : 'investment';
    return { type, reason: 'requires financial type confirmation' };
  }

  if (/(\btransfer\b|bank transfer|to savings|from savings|internal transfer)/i.test(lowers)) {
    return { type: 'transfer', reason: 'transfer-like import row' };
  }

  if (/\bsip\b|mutual fund|investment contribution|invested in|stock purchase/i.test(lowers)) {
    return { type: 'investment', reason: 'investment contribution needs a holding selection' };
  }
  if (/\blent\b|\bborrowed\b|loan repayment|emi repayment|repay(?:ment)? to/i.test(lowers)) {
    return { type: 'lending', reason: 'lending activity needs additional ledger details' };
  }

  if (rawType === 'credit' || rawType === 'deposit' || rawType === 'cr' || rawType === 'income' || rawType === 'inflow') {
    return { type: 'income', reason: 'explicit credit' };
  }

  if (rawType === 'debit' || rawType === 'withdrawal' || rawType === 'dr' || rawType === 'expense' || rawType === 'outflow') {
    return { type: 'expense', reason: 'explicit debit' };
  }

  if (/salary|bonus|refund|interest|reimbursement|stipend|income|credit|received|cashback/i.test(lowers)) {
    return { type: 'income', reason: 'income-like narration' };
  }

  if (/rent|grocer|grocery|food|dining|travel|shopping|utility|bill|subscription|emi|loan|payment|withdrawal|debit|spent|merchant|amazon|flipkart|uber|ola|swiggy|zomato/i.test(lowers)) {
    return { type: 'expense', reason: 'expense-like narration' };
  }

  return { type: 'ambiguous', reason: 'insufficient classification confidence' };
}

function importedCategory(raw, description, type) {
  if (raw.category && String(raw.category).trim()) return String(raw.category).trim();
  const d = description.toLowerCase();
  const matches = [
    [/grocer|grocery|supermarket|blinkit|zepto|bigbasket/, 'Groceries'],
    [/food|dining|restaurant|swiggy|zomato|cafe|coffee/, 'Food & Dining'],
    [/rent|electric|water|wifi|broadband|utility|recharge/, 'Rent & Utilities'],
    [/travel|uber|ola|metro|train|bus|petrol|fuel/, 'Travel & Commute'],
    [/shopping|amazon|flipkart|myntra/, 'Shopping'],
    [/medicine|medical|pharmacy|hospital|doctor/, 'Health & Medical'],
    [/subscription|netflix|spotify|prime/, 'Subscriptions & Entertainment'],
    [/salary|stipend|bonus|interest|cashback|refund|income/, 'Salary & Income']
  ].filter(([re]) => re.test(d));
  return matches.length === 1 ? matches[0][1] : (type === 'income' ? 'Salary & Income' : '');
}

function duplicateParts(row) {
  const date = normalizeImportDate(row.date || row.txnDate || row.transactionDate || row['Transaction Date']);
  const amount = Math.abs(Number(row.amount ?? row.Amount ?? row.credit ?? row.debit ?? row.debitCredit ?? 0));
  const desc = normalizeImportDescription(row.description || row.narration || row.remarks || row.details || row.particulars || row.merchant || row.name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const type = ['transfer','transfer_account','transfer_bucket'].includes(row.type) ? (/lending|borrow|repay/i.test(row.category || '') ? 'lending' : 'transfer') : (['lending_new','lending_repayment'].includes(row.type) ? 'lending' : (row.type === 'refund' ? 'income' : row.type === 'investment_contribution' ? 'investment' : (row.type || '')));
  return { date, amount: amount.toFixed(2), desc, type, account: row.account_id || row.accountId || '' };
}

function exactDuplicate(a, b) {
  const x = duplicateParts(a), y = duplicateParts(b);
  return x.date === y.date && x.amount === y.amount && x.desc === y.desc && x.type === y.type && x.account === y.account;
}

function likelyDuplicate(a, b) {
  const x = duplicateParts(a), y = duplicateParts(b);
  if (!x.date || !y.date || x.amount !== y.amount || x.type !== y.type || x.account !== y.account || !x.desc || !y.desc || x.desc !== y.desc) return false;
  const days = Math.abs(Date.parse(`${x.date}T00:00:00Z`) - Date.parse(`${y.date}T00:00:00Z`)) / 86400000;
  return days > 0 && days <= 2;
}

function previewStatementImport(db, userId, rows, options = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const accountId = options.accountId || options.account_id || null;
  const bucketId = options.bucketId || options.bucket_id || null;
  if (accountId && !db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(accountId, userId)) throw new Error('The selected account is not available.');
  if (bucketId && !db.prepare('SELECT id FROM buckets WHERE id = ? AND user_id = ?').get(bucketId, userId)) throw new Error('The selected bucket is not available.');

  const existing = db.prepare('SELECT id, date, amount, description, type, category, account_id FROM transactions WHERE user_id = ?').all(userId);
  const seenInStatement = new Set();
  const results = normalizedRows.map((raw, index) => {
    const date = normalizeImportDate(raw.date || raw.txnDate || raw.transactionDate || raw['Transaction Date'] || raw['Txn Date']);
    const description = normalizeImportDescription(raw.description || raw.narration || raw.remarks || raw.details || raw.particulars || raw.merchant || raw.name || `Imported row ${index + 1}`);
    let amount = normalizeImportAmount(raw.amount ?? raw.Amount ?? raw.total);

    const creditRaw = raw.credit ?? raw.Credit ?? raw.Cr ?? raw.deposit ?? raw.Deposit;
    const debitRaw = raw.debit ?? raw.Debit ?? raw.Dr ?? raw.withdrawal ?? raw.Withdrawal;
    const creditVal = creditRaw === undefined || creditRaw === '' ? NaN : normalizeImportAmount(creditRaw);
    const debitVal = debitRaw === undefined || debitRaw === '' ? NaN : normalizeImportAmount(debitRaw);
    if (creditRaw !== undefined || debitRaw !== undefined) {
      const credit = Number.isNaN(creditVal) ? 0 : creditVal;
      const debit = Number.isNaN(debitVal) ? 0 : debitVal;
      amount = credit > 0 && debit > 0 ? NaN : credit - debit;
    }

    if (raw._rowError || !date || Number.isNaN(amount) || !Number.isFinite(amount) || Math.abs(amount) <= 0 || Math.abs(amount) > 1e12) {
      return {
        index,
        raw,
        status: 'invalid',
        reason: raw._rowError || (!date ? 'invalid or missing date' : 'invalid or missing amount'),
        date,
        description,
        amount: 0,
        type: 'invalid',
        category: raw.category || 'Unclear'
      };
    }

    const typeInfo = classifyImportedRow(raw);
    const normalizedType = typeInfo.type;
    const explicitDebitCredit = creditRaw !== undefined || debitRaw !== undefined;
    const inferredType = explicitDebitCredit ? (amount >= 0 ? 'income' : 'expense') : amount < 0 ? 'expense' : '';
    const computedType = normalizedType === 'transfer' ? 'transfer' : normalizedType === 'ambiguous' ? inferredType : normalizedType;
    const category = importedCategory(raw, description, computedType);
    const candidate = {
      date,
      amount: Math.abs(amount),
      description,
      type: computedType,
      account_id: accountId
    };
    const exact = existing.find(tx => exactDuplicate(candidate, { ...tx, amount: tx.amount, account_id: tx.account_id }));
    const key = JSON.stringify(duplicateParts(candidate));
    const repeatedInFile = !exact && seenInStatement.has(key);
    seenInStatement.add(key);
    const likely = !exact && !repeatedInFile && existing.some(tx => likelyDuplicate(candidate, { ...tx, account_id: tx.account_id }));

    let status = (!['income','expense'].includes(computedType) || !category) ? 'ambiguous' : 'new';
    if (exact) status = 'duplicate';
    else if (likely || repeatedInFile) status = 'likely_duplicate';

    return {
      index,
      raw,
      status,
      date,
      description,
      amount: Math.abs(amount),
      type: computedType,
      category,
      accountId,
      bucketId,
      reason: status === 'ambiguous' ? (typeInfo.reason || (!category ? 'category needs review' : 'transaction type needs review')) : typeInfo.reason,
      duplicateOf: exact ? exact.id || true : null
    };
  });

  const summary = {
    totalRows: results.length,
    newCount: results.filter(r => r.status === 'new').length,
    duplicateCount: results.filter(r => r.status === 'duplicate' || r.status === 'likely_duplicate').length,
    exactDuplicateCount: results.filter(r => r.status === 'duplicate').length,
    likelyDuplicateCount: results.filter(r => r.status === 'likely_duplicate').length,
    ambiguousCount: results.filter(r => r.status === 'ambiguous').length,
    invalidCount: results.filter(r => r.status === 'invalid').length,
    incomeCount: results.filter(r => r.type === 'income' && r.status !== 'invalid').length,
    incomeValue: results.filter(r => r.type === 'income' && r.status !== 'invalid').reduce((s, r) => s + Number(r.amount || 0), 0),
    expenseCount: results.filter(r => r.type === 'expense' && r.status !== 'invalid').length,
    expenseValue: results.filter(r => r.type === 'expense' && r.status !== 'invalid').reduce((s, r) => s + Number(r.amount || 0), 0),
    transferCount: results.filter(r => r.type === 'transfer').length,
    transferValue: results.filter(r => r.type === 'transfer').reduce((s, r) => s + Number(r.amount || 0), 0),
    investmentCount: results.filter(r => r.type === 'investment').length,
    investmentValue: results.filter(r => r.type === 'investment').reduce((s, r) => s + Number(r.amount || 0), 0),
    lendingCount: results.filter(r => r.type === 'lending').length,
    lendingValue: results.filter(r => r.type === 'lending').reduce((s, r) => s + Number(r.amount || 0), 0),
    expenseTotal: results.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount || 0), 0),
    incomeTotal: results.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount || 0), 0),
    importableCount: results.filter(r => r.status === 'new' && r.type !== 'transfer').length
  };

  return { rows: results, summary };
}

function commitStatementImport(db, userId, rows, options = {}) {
  const accountId = options.accountId || options.account_id || null;
  const bucketId = options.bucketId || options.bucket_id || null;
  const selected = Array.isArray(rows) ? rows : [];
  if (selected.length > 10000) throw new Error('An import may contain at most 10000 rows.');
  const ownedAccount = accountId && db.prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
  const ownedBucket = bucketId && db.prepare('SELECT id FROM buckets WHERE id = ? AND user_id = ?').get(bucketId, userId);
  if (accountId && !ownedAccount) throw new Error('The selected account is not available.');
  if (bucketId && !ownedBucket) throw new Error('The selected bucket is not available.');
  if (selected.some(r => !r || !['income', 'expense', 'transfer_account', 'investment_contribution','lending_new','lending_repayment'].includes(r.type) || (['income','expense'].includes(r.type) && !String(r.category || '').trim()) || (r.type === 'transfer_account' && (!r.transferAccountId || !['out','in'].includes(r.transferDirection))) || (r.type === 'investment_contribution' && !r.investmentId) || (r.type === 'lending_new' && (!['lent','borrowed'].includes(r.lendingDirection) || !String(r.personName || '').trim())) || (r.type === 'lending_repayment' && !r.lendingId))) {
    throw new Error('Resolve or skip every ambiguous row before importing. Transfers, investments, and lending need their matching account or ledger details.');
  }
  for (const row of selected) {
    if (row.type === 'transfer_account' && !db.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND id<>?').get(row.transferAccountId,userId,accountId)) throw new Error('The transfer destination account is not available.');
    if (row.type === 'investment_contribution' && !db.prepare('SELECT id FROM investments WHERE id=? AND user_id=?').get(row.investmentId,userId)) throw new Error('The selected investment is not available.');
    if (row.type === 'lending_repayment') {
      const record = db.prepare('SELECT outstanding_amount FROM lending_records WHERE id=? AND user_id=?').get(row.lendingId,userId);
      if (!record || Number(row.amount) > record.outstanding_amount) throw new Error('The selected lending record is not available for this repayment amount.');
    }
  }
  const fresh = previewStatementImport(db, userId, selected, { accountId, bucketId });
  const duplicates = fresh.rows.filter((r, i) => r.status === 'duplicate' && !selected[i].allowDuplicate);
  const eligible = fresh.rows.map((row,i)=>({row,choice:selected[i]})).filter(({row,choice}) =>
    (['new','ambiguous'].includes(row.status) && ['transfer_account','investment_contribution','lending_new','lending_repayment'].includes(choice.type)) ||
    row.status === 'new' || (row.status === 'likely_duplicate' && choice.allowLikelyDuplicate) || (row.status === 'duplicate' && choice.allowDuplicate)
  );
  if (fresh.rows.some((r,i) => r.status === 'invalid' || (r.status === 'ambiguous' && !['transfer_account','investment_contribution','lending_new','lending_repayment'].includes(selected[i].type)))) throw new Error('The import changed or contains invalid rows. Review the statement again.');
  const imported = [];
  db.exec('BEGIN TRANSACTION;');
  try {
    for (const {row,choice} of eligible) {
      if (choice.type === 'transfer_account') {
        const fromAccountId = choice.transferDirection === 'out' ? accountId : choice.transferAccountId;
        const toAccountId = choice.transferDirection === 'out' ? choice.transferAccountId : accountId;
        imported.push(recordAccountTransfer(db,userId,{fromAccountId,toAccountId,amount:row.amount,date:normalizeImportDate(row.date),description:normalizeImportDescription(row.description)}));
        continue;
      }
      if (choice.type === 'investment_contribution') {
        imported.push(recordInvestmentTransaction(db,userId,{investmentId:choice.investmentId,type:'contribution',amount:row.amount,date:normalizeImportDate(row.date),notes:normalizeImportDescription(row.description),accountId}));
        continue;
      }
      if (choice.type === 'lending_new') {
        imported.push(recordLending(db,userId,{type:choice.lendingDirection,personName:String(choice.personName).trim(),totalAmount:row.amount,date:normalizeImportDate(row.date),notes:normalizeImportDescription(row.description),transactionDescription:normalizeImportDescription(row.description),accountId}));
        continue;
      }
      if (choice.type === 'lending_repayment') {
        imported.push(recordLendingRepayment(db,userId,{lendingId:choice.lendingId,amount:row.amount,date:normalizeImportDate(row.date),notes:normalizeImportDescription(row.description),transactionDescription:normalizeImportDescription(row.description),accountId}));
        continue;
      }
      const amount = choice.type === 'expense' ? -Math.abs(Number(row.amount)) : Math.abs(Number(row.amount));
      imported.push(recordTransaction(db, userId, {
        date: normalizeImportDate(row.date),
        description: normalizeImportDescription(row.description),
        category: String(row.category).trim(),
        amount,
        type: choice.type,
        account_id: accountId,
        bucket_id: bucketId,
        source: 'statement_import'
      }));
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return {
    imported: imported.length,
    skipped: duplicates.length,
    duplicate: duplicates.length,
    likelyDuplicate: fresh.rows.filter(r => r.status === 'likely_duplicate').length,
    ambiguous: 0,
    invalid: 0
  };
}

// --- PHASE 4 ADVANCED FINANCE ENGINE ---

// 1. Investments & SIP Tracking
function getInvestments(db, userId) {
  const investments = db.prepare(`
    SELECT i.*, COALESCE(a.name, 'Default') as account_name
    FROM investments i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE i.user_id = ?
    ORDER BY i.current_value DESC, i.created_at ASC
  `).all(userId);

  const transactions = db.prepare(`
    SELECT * FROM investment_transactions WHERE user_id = ? ORDER BY date DESC, created_at DESC
  `).all(userId);

  const txByInv = {};
  for (const t of transactions) {
    if (!txByInv[t.investment_id]) txByInv[t.investment_id] = [];
    txByInv[t.investment_id].push(t);
  }

  const enriched = investments.map(inv => {
    const txs = txByInv[inv.id] || [];
    const totalInvested = inv.invested_amount || 0;
    const currentVal = inv.current_value > 0 ? inv.current_value : totalInvested;
    const absGain = currentVal - totalInvested;
    const gainPct = totalInvested > 0 ? Math.round((absGain / totalInvested) * 1000) / 10 : 0;
    return {
      ...inv,
      current_value: currentVal,
      absolute_return: absGain,
      return_percentage: gainPct,
      transactions: txs
    };
  });

  const totalInvested = enriched.reduce((s, i) => s + i.invested_amount, 0);
  const totalValue = enriched.reduce((s, i) => s + i.current_value, 0);
  const totalGain = totalValue - totalInvested;
  const totalGainPct = totalInvested > 0 ? Math.round((totalGain / totalInvested) * 1000) / 10 : 0;

  return {
    investments: enriched,
    summary: {
      totalInvested,
      totalValue,
      totalGain,
      totalGainPercentage: totalGainPct,
      count: enriched.length
    }
  };
}

function recordInvestment(db, userId, data) {
  const id = data.id || 'inv_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Investment name is required');
  const type = data.type || 'mutual_fund';
  const invested = Math.max(0, Number(data.invested_amount) || 0);
  const currentVal = data.current_value !== undefined ? Math.max(0, Number(data.current_value)) : invested;
  const units = Number(data.units) || 0;
  const sipAmount = Number(data.sip_amount) || 0;
  const sipDay = data.sip_day ? parseInt(data.sip_day, 10) : null;
  const accountId = data.account_id || null;
  const notes = data.notes || null;

  db.prepare(`
    INSERT INTO investments (id, user_id, account_id, name, type, invested_amount, current_value, units, sip_amount, sip_day, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, accountId, name, type, invested, currentVal, units, sipAmount, sipDay, notes, now, now);

  if (invested > 0) {
    const txId = 'itx_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO investment_transactions (id, user_id, investment_id, type, amount, units, date, notes, created_at)
      VALUES (?, ?, ?, 'contribution', ?, ?, ?, 'Initial investment record', ?)
    `).run(txId, userId, id, invested, units, now.slice(0, 10), now);
  }

  return { id, name, type, invested_amount: invested, current_value: currentVal };
}

function updateInvestment(db, userId, id, data) {
  const existing = db.prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new Error('Investment not found');
  const now = new Date().toISOString();

  const name = data.name !== undefined ? String(data.name).trim() : existing.name;
  const type = data.type !== undefined ? data.type : existing.type;
  const currentVal = data.current_value !== undefined ? Math.max(0, Number(data.current_value)) : existing.current_value;
  const units = data.units !== undefined ? Number(data.units) : existing.units;
  const sipAmount = data.sip_amount !== undefined ? Number(data.sip_amount) : existing.sip_amount;
  const sipDay = data.sip_day !== undefined ? data.sip_day : existing.sip_day;
  const notes = data.notes !== undefined ? data.notes : existing.notes;

  db.prepare(`
    UPDATE investments
    SET name = ?, type = ?, current_value = ?, units = ?, sip_amount = ?, sip_day = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(name, type, currentVal, units, sipAmount, sipDay, notes, now, id, userId);

  return { id, success: true };
}

function deleteInvestment(db, userId, id) {
  const existing = db.prepare('SELECT id FROM investments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new Error('Investment not found');
  db.prepare('DELETE FROM investments WHERE id = ? AND user_id = ?').run(id, userId);
  return { success: true, deletedId: id };
}

function recordInvestmentTransaction(db, userId, tx) {
  const investment = db.prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?').get(tx.investmentId, userId);
  if (!investment) throw new Error('Investment not found');

  const amount = Math.abs(Number(tx.amount));
  if (!amount || amount <= 0) throw new Error('Positive transaction amount required');

  const type = tx.type || 'contribution';
  const now = new Date().toISOString();
  const date = tx.date || now.slice(0, 10);
  const units = Number(tx.units) || 0;
  const id = 'itx_' + crypto.randomBytes(8).toString('hex');

  db.exec('SAVEPOINT transaction_write;');
  try {
    db.prepare(`
      INSERT INTO investment_transactions (id, user_id, investment_id, type, amount, units, date, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, tx.investmentId, type, amount, units, date, tx.notes || null, now);

    if (type === 'contribution') {
      db.prepare(`
        UPDATE investments
        SET invested_amount = invested_amount + ?,
            current_value = current_value + ?,
            units = units + ?,
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(amount, amount, units, now, tx.investmentId, userId);

      if (tx.accountId) {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(amount, tx.accountId, userId);
        const invBucket = db.prepare(`SELECT id FROM buckets WHERE user_id = ? AND type = 'investments' LIMIT 1`).get(userId);
        if (invBucket) {
          db.prepare('UPDATE buckets SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, invBucket.id, userId);
        }
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, bucket_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, ?, 'transfer_bucket', ?, ?, ?, 'Investments & SIP', 'Necessary', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, tx.accountId, invBucket ? invBucket.id : null, amount, date, `Investment: ${investment.name}`, now);
      }
    } else if (type === 'withdrawal') {
      db.prepare(`
        UPDATE investments
        SET invested_amount = MAX(0, invested_amount - ?),
            current_value = MAX(0, current_value - ?),
            units = MAX(0, units - ?),
            updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(amount, amount, units, now, tx.investmentId, userId);

      if (tx.accountId) {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, tx.accountId, userId);
        const invBucket = db.prepare(`SELECT id FROM buckets WHERE user_id = ? AND type = 'investments' LIMIT 1`).get(userId);
        if (invBucket) {
          db.prepare('UPDATE buckets SET balance = MAX(0, balance - ?) WHERE id = ? AND user_id = ?').run(amount, invBucket.id, userId);
        }
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, bucket_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, ?, 'transfer_bucket', ?, ?, ?, 'Investments & SIP', 'Necessary', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, tx.accountId, invBucket ? invBucket.id : null, amount, date, `Withdrawal: ${investment.name}`, now);
      }
    } else if (type === 'valuation_update') {
      db.prepare(`
        UPDATE investments
        SET current_value = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(amount, now, tx.investmentId, userId);
    }

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { success: true, transactionId: id };
}

// 2. Lending & Borrowing (Receivables & Payables)
function getLendingRecords(db, userId, status = 'all') {
  let query = 'SELECT * FROM lending_records WHERE user_id = ?';
  const params = [userId];
  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }
  query += ' ORDER BY status ASC, date DESC';
  const records = db.prepare(query).all(...params);

  const repayments = db.prepare('SELECT * FROM lending_repayments WHERE user_id = ? ORDER BY date DESC').all(userId);
  const repByLending = {};
  for (const r of repayments) {
    if (!repByLending[r.lending_id]) repByLending[r.lending_id] = [];
    repByLending[r.lending_id].push(r);
  }

  const enriched = records.map(rec => ({
    ...rec,
    repayments: repByLending[rec.id] || []
  }));

  const totalLent = enriched.filter(r => r.type === 'lent' && r.status === 'active').reduce((s, r) => s + r.outstanding_amount, 0);
  const totalBorrowed = enriched.filter(r => r.type === 'borrowed' && r.status === 'active').reduce((s, r) => s + r.outstanding_amount, 0);

  return {
    records: enriched,
    summary: {
      totalLent,
      totalBorrowed,
      netBalance: totalLent - totalBorrowed,
      activeCount: enriched.filter(r => r.status === 'active').length
    }
  };
}

function recordLending(db, userId, data) {
  const id = data.id || 'lend_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const personName = String(data.personName || data.person_name || '').trim();
  if (!personName) throw new Error('Person name is required');
  const type = data.type === 'borrowed' ? 'borrowed' : 'lent';
  const totalAmount = Math.abs(Number(data.totalAmount || data.amount || data.total_amount));
  if (!totalAmount || totalAmount <= 0) throw new Error('Positive loan amount required');
  const date = data.date || now.slice(0, 10);
  const dueDate = data.dueDate || data.due_date || null;
  const personContact = data.personContact || data.person_contact || null;
  const notes = data.notes || null;
  const accountId = data.accountId || data.account_id || null;

  db.exec('SAVEPOINT transaction_write;');
  try {
    db.prepare(`
      INSERT INTO lending_records (
        id, user_id, type, person_name, person_contact, total_amount, repaid_amount,
        outstanding_amount, date, due_date, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, userId, type, personName, personContact, totalAmount, totalAmount, date, dueDate, notes, now, now);

    if (accountId) {
      if (type === 'lent') {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(totalAmount, accountId, userId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, 'transfer_account', ?, ?, ?, 'Lending', 'Optional', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, totalAmount, date, data.transactionDescription || `Lent to ${personName}`, now);
      } else {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(totalAmount, accountId, userId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, 'transfer_account', ?, ?, ?, 'Borrowing', 'Useful', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, totalAmount, date, data.transactionDescription || `Borrowed from ${personName}`, now);
      }
    }

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { id, type, personName, totalAmount, outstandingAmount: totalAmount, status: 'active' };
}

function recordLendingRepayment(db, userId, data) {
  const lendingId = data.lendingId || data.lending_id;
  const record = db.prepare('SELECT * FROM lending_records WHERE id = ? AND user_id = ?').get(lendingId, userId);
  if (!record) throw new Error('Lending record not found');

  const amount = Math.abs(Number(data.amount));
  if (!amount || amount <= 0) throw new Error('Positive repayment amount required');
  const now = new Date().toISOString();
  const date = data.date || now.slice(0, 10);
  const accountId = data.accountId || data.account_id || null;
  const notes = data.notes || null;
  const repId = 'rep_' + crypto.randomBytes(8).toString('hex');

  db.exec('SAVEPOINT transaction_write;');
  try {
    const newRepaid = record.repaid_amount + amount;
    const newOutstanding = Math.max(0, record.total_amount - newRepaid);
    const newStatus = newOutstanding === 0 ? 'repaid' : 'active';

    db.prepare(`
      UPDATE lending_records
      SET repaid_amount = ?, outstanding_amount = ?, status = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(newRepaid, newOutstanding, newStatus, now, lendingId, userId);

    db.prepare(`
      INSERT INTO lending_repayments (id, user_id, lending_id, amount, date, account_id, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repId, userId, lendingId, amount, date, accountId, notes, now);

    if (accountId) {
      if (record.type === 'lent') {
        db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, accountId, userId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, 'transfer_account', ?, ?, ?, 'Lending Repayment', 'Useful', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, amount, date, data.transactionDescription || `Repayment from ${record.person_name}`, now);
      } else {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(amount, accountId, userId);
        db.prepare(`
          INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
          VALUES (?, ?, ?, 'transfer_account', ?, ?, ?, 'Loan Repayment', 'Necessary', ?)
        `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, amount, date, data.transactionDescription || `Repaid to ${record.person_name}`, now);
      }
    }

    db.exec('RELEASE SAVEPOINT transaction_write;');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT transaction_write;');
    db.exec('RELEASE SAVEPOINT transaction_write;');
    throw err;
  }

  return { success: true, repaymentId: repId, remainingOutstanding: Math.max(0, record.total_amount - (record.repaid_amount + amount)) };
}

// 3. Split Expenses
function getSplitExpenses(db, userId) {
  const splits = db.prepare('SELECT * FROM split_expenses WHERE user_id = ? ORDER BY date DESC').all(userId);
  const participants = db.prepare('SELECT * FROM split_participants WHERE user_id = ?').all(userId);
  const pBySplit = {};
  for (const p of participants) {
    if (!pBySplit[p.split_id]) pBySplit[p.split_id] = [];
    pBySplit[p.split_id].push(p);
  }

  return splits.map(s => ({
    ...s,
    participants: pBySplit[s.id] || []
  }));
}

function recordSplitExpense(db, userId, data) {
  const id = data.id || 'split_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const title = String(data.title || 'Split Expense').trim();
  const totalAmount = Math.abs(Number(data.totalAmount || data.total_amount));
  const myShare = Math.abs(Number(data.myShare || data.my_share));
  if (!totalAmount || totalAmount <= 0) throw new Error('Valid total amount required');
  if (myShare === undefined || myShare < 0 || myShare > totalAmount) throw new Error('Valid personal share required');

  const payer = data.payer || 'me';
  const date = data.date || now.slice(0, 10);
  const category = data.category || 'Food & Dining';
  const notes = data.notes || null;
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const accountId = data.accountId || data.account_id || null;

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare(`
      INSERT INTO split_expenses (id, user_id, title, total_amount, my_share, payer, date, category, status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, userId, title, totalAmount, myShare, payer, date, category, notes, now);

    for (const p of participants) {
      const pId = 'sp_' + crypto.randomBytes(8).toString('hex');
      const share = Math.abs(Number(p.shareAmount || p.share_amount || 0));
      db.prepare(`
        INSERT INTO split_participants (id, split_id, user_id, name, share_amount, paid_amount, is_settled, created_at)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?)
      `).run(pId, id, userId, p.name.trim(), share, now);

      if (payer === 'me' && share > 0) {
        db.prepare(`
          INSERT INTO lending_records (
            id, user_id, type, person_name, total_amount, repaid_amount,
            outstanding_amount, date, status, notes, created_at, updated_at
          ) VALUES (?, ?, 'lent', ?, ?, 0, ?, ?, 'active', ?, ?, ?)
        `).run('lend_' + crypto.randomBytes(8).toString('hex'), userId, p.name.trim(), share, share, date, `Split: ${title}`, now, now);
      }
    }

    if (payer === 'me') {
      if (accountId) {
        db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ? AND user_id = ?').run(totalAmount, accountId, userId);
      }
      db.prepare(`
        INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
        VALUES (?, ?, ?, 'expense', ?, ?, ?, ?, 'Optional', ?)
      `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, myShare, date, `${title} (My share)`, category, now);
    } else {
      db.prepare(`
        INSERT INTO transactions (id, user_id, type, amount, date, description, category, necessity, created_at)
        VALUES (?, ?, 'expense', ?, ?, ?, ?, 'Optional', ?)
      `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, myShare, date, `${title} (My share)`, category, now);

      db.prepare(`
        INSERT INTO lending_records (
          id, user_id, type, person_name, total_amount, repaid_amount,
          outstanding_amount, date, status, notes, created_at, updated_at
        ) VALUES (?, ?, 'borrowed', ?, ?, 0, ?, ?, 'active', ?, ?, ?)
      `).run('lend_' + crypto.randomBytes(8).toString('hex'), userId, payer, myShare, myShare, date, `Split share owed for ${title}`, now, now);
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { id, title, totalAmount, myShare, status: 'pending' };
}

function settleSplitParticipant(db, userId, participantId, data) {
  const participant = db.prepare('SELECT * FROM split_participants WHERE id = ? AND user_id = ?').get(participantId, userId);
  if (!participant) throw new Error('Split participant not found');

  const amount = Math.abs(Number(data.amount || participant.share_amount));
  const now = new Date().toISOString();
  const date = data.date || now.slice(0, 10);
  const accountId = data.accountId || data.account_id || null;

  db.exec('BEGIN TRANSACTION;');
  try {
    db.prepare(`
      UPDATE split_participants
      SET paid_amount = paid_amount + ?, is_settled = 1
      WHERE id = ? AND user_id = ?
    `).run(amount, participantId, userId);

    if (accountId) {
      db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ? AND user_id = ?').run(amount, accountId, userId);
      db.prepare(`
        INSERT INTO transactions (id, user_id, account_id, type, amount, date, description, category, necessity, created_at)
        VALUES (?, ?, ?, 'transfer_account', ?, ?, ?, 'Split Settlement', 'Useful', ?)
      `).run('tx_' + crypto.randomBytes(8).toString('hex'), userId, accountId, amount, date, `Split settled: ${participant.name}`, now);
    }

    const unSettled = db.prepare(`SELECT COUNT(*) as c FROM split_participants WHERE split_id = ? AND user_id = ? AND is_settled = 0`).get(participant.split_id, userId).c;
    if (unSettled === 0) {
      db.prepare(`UPDATE split_expenses SET status = 'settled' WHERE id = ? AND user_id = ?`).run(participant.split_id, userId);
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  return { success: true, participantId };
}

// 4. Recurring Commitments
function getRecurringCommitments(db, userId) {
  return db.prepare(`
    SELECT r.*, COALESCE(a.name, 'Default Bank') as account_name, COALESCE(b.name, 'Spending') as bucket_name
    FROM recurring_commitments r
    LEFT JOIN accounts a ON a.id = r.account_id
    LEFT JOIN buckets b ON b.id = r.bucket_id
    WHERE r.user_id = ?
    ORDER BY r.next_date ASC
  `).all(userId);
}

function recordRecurringCommitment(db, userId, data) {
  const id = data.id || 'rec_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const name = String(data.name || '').trim();
  if (!name) throw new Error('Commitment name is required');
  const type = data.type || 'subscription';
  const amount = Math.abs(Number(data.amount));
  if (!amount || amount <= 0) throw new Error('Positive amount required');
  const frequency = data.frequency || 'monthly';
  const nextDate = data.nextDate || data.next_date || now.slice(0, 10);
  const accountId = data.accountId || data.account_id || null;
  const bucketId = data.bucketId || data.bucket_id || null;
  const notes = data.notes || null;

  db.prepare(`
    INSERT INTO recurring_commitments (id, user_id, name, type, amount, frequency, next_date, account_id, bucket_id, is_active, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, userId, name, type, amount, frequency, nextDate, accountId, bucketId, notes, now);

  return { id, name, type, amount, frequency, nextDate, is_active: 1 };
}

function updateRecurringCommitment(db, userId, id, data) {
  const existing = db.prepare('SELECT * FROM recurring_commitments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new Error('Commitment not found');

  const name = data.name !== undefined ? String(data.name).trim() : existing.name;
  const type = data.type !== undefined ? data.type : existing.type;
  const amount = data.amount !== undefined ? Math.abs(Number(data.amount)) : existing.amount;
  const frequency = data.frequency !== undefined ? data.frequency : existing.frequency;
  const nextDate = data.nextDate || data.next_date || existing.next_date;
  const isActive = data.isActive !== undefined ? (data.isActive ? 1 : 0) : (data.is_active !== undefined ? (data.is_active ? 1 : 0) : existing.is_active);
  const notes = data.notes !== undefined ? data.notes : existing.notes;

  db.prepare(`
    UPDATE recurring_commitments
    SET name = ?, type = ?, amount = ?, frequency = ?, next_date = ?, is_active = ?, notes = ?
    WHERE id = ? AND user_id = ?
  `).run(name, type, amount, frequency, nextDate, isActive, notes, id, userId);

  return { id, success: true };
}

function deleteRecurringCommitment(db, userId, id) {
  const existing = db.prepare('SELECT id FROM recurring_commitments WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) throw new Error('Commitment not found');
  db.prepare('DELETE FROM recurring_commitments WHERE id = ? AND user_id = ?').run(id, userId);
  return { success: true, deletedId: id };
}

function computeNextOccurrenceDate(currentDateStr, frequency) {
  const d = new Date(currentDateStr + 'T00:00:00');
  if (frequency === 'daily') {
    d.setDate(d.getDate() + 1);
  } else if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
  } else if (frequency === 'quarterly') {
    d.setMonth(d.getMonth() + 3);
  } else if (frequency === 'yearly') {
    d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setMonth(d.getMonth() + 1);
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 5. Financial Calendar Aggregator
function getFinancialCalendar(db, userId, startDate, endDate) {
  const now = new Date();
  const start = startDate || now.toISOString().slice(0, 10);
  const endD = new Date(now);
  endD.setDate(now.getDate() + 45);
  const end = endDate || endD.toISOString().slice(0, 10);

  const events = [];

  const recurrings = db.prepare('SELECT * FROM recurring_commitments WHERE user_id = ? AND is_active = 1').all(userId);
  for (const r of recurrings) {
    let curDate = r.next_date;
    let guard = 0;
    while (curDate <= end && guard < 60) {
      guard++;
      if (curDate >= start) {
        events.push({
          id: `rec_${r.id}_${curDate}`,
          sourceId: r.id,
          title: r.name,
          date: curDate,
          amount: r.amount,
          type: 'recurring',
          category: r.type,
          frequency: r.frequency,
          accountId: r.account_id,
          bucketId: r.bucket_id
        });
      }
      curDate = computeNextOccurrenceDate(curDate, r.frequency);
    }
  }

  const lendings = db.prepare(`SELECT * FROM lending_records WHERE user_id = ? AND status = 'active' AND due_date IS NOT NULL`).all(userId);
  for (const l of lendings) {
    if (l.due_date >= start && l.due_date <= end) {
      events.push({
        id: `lend_${l.id}`,
        sourceId: l.id,
        title: l.type === 'lent' ? `Repayment due from ${l.person_name}` : `Loan due to ${l.person_name}`,
        date: l.due_date,
        amount: l.outstanding_amount,
        type: 'lending',
        category: l.type === 'lent' ? 'Receivable' : 'Payable',
        personName: l.person_name
      });
    }
  }

  const goals = db.prepare(`SELECT * FROM goals WHERE user_id = ? AND target_date IS NOT NULL`).all(userId);
  for (const g of goals) {
    if (g.target_date >= start && g.target_date <= end) {
      events.push({
        id: `goal_${g.id}`,
        sourceId: g.id,
        title: `Goal: ${g.name}`,
        date: g.target_date,
        amount: g.target_amount,
        type: 'goal',
        category: 'Savings Goal'
      });
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date));
  return { startDate: start, endDate: end, events };
}

function postRecurringToLedger(db, userId, recurringId, postDate) {
  const commitment = db.prepare('SELECT * FROM recurring_commitments WHERE id = ? AND user_id = ?').get(recurringId, userId);
  if (!commitment) throw new Error('Recurring commitment not found');

  const now = new Date().toISOString();
  const date = postDate || commitment.next_date;
  const isIncome = commitment.type === 'recurring_income';
  const isSIP = commitment.type === 'sip';
  const txType = isIncome ? 'income' : (isSIP ? 'transfer_bucket' : 'expense');

  const tx = recordTransaction(db, userId, {
    account_id: commitment.account_id,
    bucket_id: commitment.bucket_id,
    type: txType,
    amount: commitment.amount,
    date,
    description: commitment.name,
    category: isSIP ? 'Investments & SIP' : (commitment.type === 'rent' ? 'Rent & Utilities' : (commitment.type === 'subscription' ? 'Subscriptions & Entertainment' : 'General')),
    necessity: isIncome ? 'Necessary' : (isSIP ? 'Planned' : (commitment.type === 'rent' ? 'Necessary' : 'Optional')),
    source: 'recurring_auto_post'
  });

  const nextDate = computeNextOccurrenceDate(commitment.next_date, commitment.frequency);
  db.prepare('UPDATE recurring_commitments SET next_date = ? WHERE id = ? AND user_id = ?').run(nextDate, recurringId, userId);

  return { success: true, transaction: tx, nextDate };
}

function migrateLegacyData(db, userId, legacyData) {
  if (!legacyData || typeof legacyData !== 'object') {
    return { migratedTransactions: 0, migratedPortfolio: 0 };
  }

  setupDefaultEntities(db, userId);

  const mainBank = db.prepare(`SELECT id FROM accounts WHERE user_id = ? AND type = 'bank' LIMIT 1`).get(userId);
  const spendingBkt = db.prepare(`SELECT id FROM buckets WHERE user_id = ? AND type = 'spending' LIMIT 1`).get(userId);
  const investBkt = db.prepare(`SELECT id FROM buckets WHERE user_id = ? AND type = 'investments' LIMIT 1`).get(userId);

  let txCount = 0;
  let pfCount = 0;

  function txKey(date, amount, desc) {
    const d = String(date || '').slice(0, 10);
    const a = Math.abs(Number(amount) || 0).toFixed(2);
    const n = String(desc || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${d}|${a}|${n}`;
  }

  // Migrate transactions
  if (Array.isArray(legacyData.transactions)) {
    const existingTx = db.prepare(`SELECT date, amount, description FROM transactions WHERE user_id = ?`).all(userId);
    const existingKeys = new Set(existingTx.map(r => txKey(r.date, r.amount, r.description)));

    for (const t of legacyData.transactions) {
      if (!t.date || !t.amount) continue;
      const amt = Math.abs(Number(t.amount));
      const desc = String(t.description || 'Imported transaction').trim();
      const k = txKey(t.date, amt, desc);
      if (existingKeys.has(k)) continue;

      const type = (t.type === 'income' || Number(t.amount) > 0) ? 'income' : 'expense';
      const isInvest = String(t.category || '').toLowerCase().includes('invest') || desc.toLowerCase().includes('sip');
      const bktId = isInvest && investBkt ? investBkt.id : (spendingBkt ? spendingBkt.id : null);

      recordTransaction(db, userId, {
        date: t.date,
        description: desc,
        category: t.category || (isInvest ? 'Investments' : 'General'),
        amount: amt,
        type,
        account_id: mainBank ? mainBank.id : null,
        bucket_id: bktId,
        source: 'legacy_v1_migration'
      });
      existingKeys.add(k);
      txCount++;
    }
  }

  // Migrate portfolio snapshots
  if (Array.isArray(legacyData.portfolio)) {
    const existingSnapshots = new Set(
      db.prepare(`SELECT kind || '|' || as_of as k FROM portfolio_snapshots WHERE user_id = ?`).all(userId).map(r => r.k)
    );
    const now = new Date().toISOString();
    for (const p of legacyData.portfolio) {
      if (!p.value || Number(p.value) <= 0) continue;
      const asOf = p.asOf || now.slice(0, 10);
      const kind = p.kind || 'Stocks';
      const k = `${kind}|${asOf}`;
      if (existingSnapshots.has(k)) continue;

      const id = 'pf_' + crypto.randomBytes(8).toString('hex');
      db.prepare(`
        INSERT INTO portfolio_snapshots (id, user_id, kind, value, as_of, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, kind, Number(p.value), asOf, 'legacy_v1_migration', now);
      existingSnapshots.add(k);
      pfCount++;
    }
  }

  return { migratedTransactions: txCount, migratedPortfolio: pfCount };
}

module.exports = {
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
  getChartData,
  migrateLegacyData,
  normalizeImportDate,
  previewStatementImport,
  commitStatementImport,
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
};
