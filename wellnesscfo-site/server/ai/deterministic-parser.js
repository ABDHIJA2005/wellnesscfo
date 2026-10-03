// Deterministic NLP & Heuristic Parser for Transaction Entry

const CATEGORY_MAP = [
  {
    category: 'Food & Dining',
    keywords: ['dinner', 'lunch', 'breakfast', 'brunch', 'food', 'meal', 'swiggy', 'zomato', 'restaurant', 'cafe', 'coffee', 'starbucks', 'chai', 'tea', 'snack', 'pizza', 'burger', 'bar', 'drinks', 'mcdonalds']
  },
  {
    category: 'Groceries',
    keywords: ['groceries', 'grocery', 'zepto', 'blinkit', 'instamart', 'bigbasket', 'milk', 'vegetables', 'veggies', 'fruits', 'supermarket', 'provisions', 'bread', 'eggs']
  },
  {
    category: 'Education & Stationery',
    keywords: ['pen', 'pens', 'pencil', 'notebook', 'book', 'books', 'exam', 'stationery', 'paper', 'course', 'tuition', 'class', 'udemy', 'coursera', 'textbook']
  },
  {
    category: 'Travel & Commute',
    keywords: ['uber', 'ola', 'auto', 'rickshaw', 'cab', 'taxi', 'metro', 'train', 'bus', 'flight', 'petrol', 'fuel', 'diesel', 'toll', 'parking', 'ticket']
  },
  {
    category: 'Investments & SIP',
    keywords: ['sip', 'mutual fund', 'stocks', 'zerodha', 'groww', 'etf', 'shares', 'equity', 'gold', 'crypto', 'parag parikh', 'index fund', 'nifty', 'investment']
  },
  {
    category: 'Rent & Utilities',
    keywords: ['rent', 'electricity', 'bescom', 'water', 'wifi', 'broadband', 'airtel', 'jio', 'recharge', 'maintenance', 'lpg', 'gas', 'cylinder', 'utility', 'bills']
  },
  {
    category: 'Shopping',
    keywords: ['shopping', 'amazon', 'flipkart', 'myntra', 'shoes', 'clothes', 'shirt', 'pants', 'dress', 'electronics', 'gadget', 'headphones', 'watch', 'jacket', 'nike', 'zara']
  },
  {
    category: 'Health & Medical',
    keywords: ['medicine', 'medical', 'pharmacy', 'doctor', 'clinic', 'hospital', 'apollo', 'tablet', 'consultation', 'health', 'dentist', 'lab test']
  },
  {
    category: 'Subscriptions & Entertainment',
    keywords: ['netflix', 'spotify', 'prime', 'amazon prime', 'hotstar', 'youtube premium', 'icloud', 'chatgpt', 'gym', 'movie', 'cinema', 'theatre', 'subscription']
  },
  {
    category: 'Salary & Income',
    keywords: ['salary', 'stipend', 'bonus', 'freelance', 'dividend', 'interest', 'cashback', 'incentive', 'consulting fee']
  }
];

function extractAmount(text) {
  // Support: ₹280, Rs. 280, 280rs, 280 inr, ₹27,000, 1.5k, 1 lakh, 50k
  const clean = text.replace(/,/g, '');

  // 1. Lakh match: 1.5 lakh -> 150000
  const lakhMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:lakhs?|lacs?)\b/i);
  if (lakhMatch) {
    return Math.round(parseFloat(lakhMatch[1]) * 100000);
  }

  // 2. 'k' match: 5k -> 5000, 27k -> 27000
  const kMatch = clean.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) {
    return Math.round(parseFloat(kMatch[1]) * 1000);
  }

  // 3. Currency symbol or suffix match: ₹280, Rs 280, 280 rs, 280 inr
  const curMatch = clean.match(/(?:₹|rs\.?|inr)\s*(\d+(?:\.\d+)?)/i) || clean.match(/(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|inr|rupees?)\b/i);
  if (curMatch) {
    return Math.round(parseFloat(curMatch[1]));
  }

  // 4. Standalone number that is not a date or phone
  const numMatch = clean.match(/\b(\d{1,8}(?:\.\d{1,2})?)\b/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    if (val > 0 && val < 10000000) {
      return Math.round(val);
    }
  }

  return null;
}

function parseNaturalLanguageTransaction(rawText, userAccounts = [], userBuckets = []) {
  const text = String(rawText || '').trim();
  const lower = text.toLowerCase();

  const amount = extractAmount(text);
  if (!amount) {
    return {
      success: false,
      error: 'Could not detect an amount. Please specify an amount, e.g., ₹280 or 500.'
    };
  }

  // 1. Detect if this is an internal Transfer command: "Move ₹1,000 from savings to business"
  const isTransfer = /\b(move|moved|transfer|transferred|shift|shifted|allocate|allocated)\b/i.test(lower) && /\bto\b/i.test(lower);
  if (isTransfer) {
    let fromBucket = null;
    let toBucket = null;

    for (const b of userBuckets) {
      const bLower = b.name.toLowerCase();
      const bType = b.type.toLowerCase();
      if (lower.includes(`from ${bLower}`) || lower.includes(`from ${bType}`)) {
        fromBucket = b;
      }
      if (lower.includes(`to ${bLower}`) || lower.includes(`to ${bType}`)) {
        toBucket = b;
      }
    }

    // Default fallback if "from" keyword omitted
    if (!fromBucket) {
      if (lower.includes('savings')) fromBucket = userBuckets.find(b => b.type === 'savings');
      else if (lower.includes('emergency')) fromBucket = userBuckets.find(b => b.type === 'emergency');
      else fromBucket = userBuckets.find(b => b.type === 'spending');
    }
    if (!toBucket) {
      if (lower.includes('business')) toBucket = userBuckets.find(b => b.type === 'business');
      else if (lower.includes('investment')) toBucket = userBuckets.find(b => b.type === 'investments');
      else if (lower.includes('savings')) toBucket = userBuckets.find(b => b.type === 'savings');
    }

    return {
      success: true,
      isAction: true,
      actionType: 'transfer_bucket',
      amount,
      fromBucketId: fromBucket?.id || null,
      fromBucketName: fromBucket?.name || 'Savings',
      toBucketId: toBucket?.id || null,
      toBucketName: toBucket?.name || 'Business Fund',
      date: new Date().toISOString().slice(0, 10),
      description: text,
      confidence: (fromBucket && toBucket) ? 0.95 : 0.75,
      preview: {
        headline: `Move ₹${amount.toLocaleString('en-IN')}`,
        subline: `${fromBucket?.name || 'Source'} → ${toBucket?.name || 'Destination'}`,
        impactNote: 'Internal allocation: Available cash and net worth remain unchanged.'
      }
    };
  }

  // Phase 4: Detect Lending ("Lent ₹2,000 to Aakash for two weeks")
  const isLending = /\b(lent|loaned|gave)\b/i.test(lower) && /\b(to)\b/i.test(lower) && amount > 0;
  if (isLending) {
    const toMatch = lower.match(/(?:to\s+)([a-zA-Z]{2,20})/i);
    const person = toMatch ? toMatch[1].charAt(0).toUpperCase() + toMatch[1].slice(1) : 'Friend';
    return {
      success: true,
      isAction: true,
      actionType: 'record_lending',
      type: 'lent',
      amount,
      personName: person,
      date: new Date().toISOString().slice(0, 10),
      description: text,
      confidence: 0.94,
      preview: {
        headline: `Lend ₹${amount.toLocaleString('en-IN')}`,
        subline: `To: ${person}`,
        impactNote: 'Asset tracking: Treated as money owed to you (receivable). Does not inflate monthly spending.'
      }
    };
  }

  // Phase 4: Detect Borrowing ("Borrowed ₹1,500 from Rohit")
  const isBorrowing = /\b(borrowed|took loan)\b/i.test(lower) && amount > 0;
  if (isBorrowing) {
    const fromMatch = lower.match(/(?:from\s+)([a-zA-Z]{2,20})/i);
    const person = fromMatch ? fromMatch[1].charAt(0).toUpperCase() + fromMatch[1].slice(1) : 'Lender';
    return {
      success: true,
      isAction: true,
      actionType: 'record_borrowing',
      type: 'borrowed',
      amount,
      personName: person,
      date: new Date().toISOString().slice(0, 10),
      description: text,
      confidence: 0.94,
      preview: {
        headline: `Borrow ₹${amount.toLocaleString('en-IN')}`,
        subline: `From: ${person}`,
        impactNote: 'Liability tracking: Treated as debt (payable). Does not count as earned income.'
      }
    };
  }

  // Phase 4: Detect SIP ("₹2,000 SIP")
  if (/\bsip\b/i.test(lower) && amount > 0) {
    const invBucket = userBuckets.find(b => b.type === 'investments');
    const mainBank = userAccounts.find(a => a.type === 'bank') || userAccounts[0] || null;
    return {
      success: true,
      isAction: false,
      amount,
      type: 'expense',
      category: 'Investments & SIP',
      merchant: 'Monthly SIP',
      description: 'Monthly SIP',
      date: new Date().toISOString().slice(0, 10),
      accountId: mainBank?.id || null,
      accountName: mainBank?.name || 'Main Bank Account',
      bucketId: invBucket?.id || null,
      bucketName: invBucket?.name || 'Investments',
      necessity: 'Planned',
      necessityExplanation: 'Systematic Investment Plan contribution toward long-term wealth goals.',
      isRecurring: true,
      confidence: 0.95,
      isAmbiguous: false
    };
  }

  // 2. Detect Income vs Expense
  const isIncome = /\b(got|received|credited|stipend|salary|bonus|dividend|cashback|refund|earn|earned|income)\b/i.test(lower)
    && !/\b(spent|paid|for)\s+(?:salary|stipend)\b/i.test(lower);

  const type = isIncome ? 'income' : 'expense';

  // 3. Category Detection
  let detectedCategory = 'Uncategorised';
  let categoryConfidence = 0.5;

  if (isIncome) {
    detectedCategory = 'Salary & Income';
    categoryConfidence = 0.9;
  } else {
    for (const group of CATEGORY_MAP) {
      if (group.keywords.some(kw => lower.includes(kw))) {
        detectedCategory = group.category;
        categoryConfidence = 0.9;
        break;
      }
    }
  }

  // Check for ambiguous "bought something for 500"
  if (/\b(bought|got|spent)\s+(?:something|stuff|things?)\b/i.test(lower)) {
    detectedCategory = 'Uncategorised';
    categoryConfidence = 0.4;
  }

  // 4. Necessity Intelligence & Explanation
  let necessity = 'Unclear';
  let necessityExplanation = 'Insufficient context to determine necessity automatically.';

  if (isIncome) {
    necessity = 'Planned';
    necessityExplanation = 'Inflow / income is classified as planned capital.';
  } else {
    // Necessary heuristics
    if (/\b(exam|didn't have|did not have|essential|survival|rent|medicine|doctor|hospital|emergency|urgent)\b/i.test(lower)) {
      necessity = 'Necessary';
      necessityExplanation = 'Marked as necessary because this fulfilled an essential academic, health, or living requirement.';
    }
    // Useful heuristics
    else if (/\b(book|course|study|work|productivity|laptop|tools?)\b/i.test(lower)) {
      necessity = 'Useful';
      necessityExplanation = 'Marked as useful for work, learning, or productivity enhancement.';
    }
    // Planned heuristics
    else if (/\b(sip|investment|saving|insurance|bills|electricity|bescom)\b/i.test(lower)) {
      necessity = 'Planned';
      necessityExplanation = 'Marked as planned recurring commitment or investment.';
    }
    // Avoidable / Wasteful heuristics
    else if (/\b(already had|didn't need|impulse|regret|duplicate|waste)\b/i.test(lower)) {
      necessity = 'Avoidable';
      necessityExplanation = 'Marked as potentially avoidable because similar items were already owned or noted as an impulse buy.';
    }
    // Optional heuristics
    else if (/\b(friends?|dinner|party|drinks|movie|cinema|cafe|starbucks|outing|weekend|shoes|clothes)\b/i.test(lower)) {
      necessity = 'Optional';
      necessityExplanation = 'Marked as optional discretionary spending for leisure or social enjoyment.';
    }
    else if (detectedCategory === 'Food & Dining') {
      necessity = 'Optional';
      necessityExplanation = 'Dining out is treated as discretionary/optional by default.';
    }
    else if (detectedCategory === 'Groceries' || detectedCategory === 'Health & Medical') {
      necessity = 'Necessary';
      necessityExplanation = 'Essential daily nutrition or healthcare necessity.';
    }
  }

  // 5. Account & Bucket Matching
  let targetAccount = userAccounts.find(a => a.type === 'bank') || userAccounts[0] || null;
  if (lower.includes('cash') || lower.includes('wallet')) {
    const cashAcc = userAccounts.find(a => a.type === 'cash' || a.type === 'wallet');
    if (cashAcc) targetAccount = cashAcc;
  }

  let targetBucket = null;
  if (detectedCategory === 'Investments & SIP') {
    targetBucket = userBuckets.find(b => b.type === 'investments');
  } else if (lower.includes('business')) {
    targetBucket = userBuckets.find(b => b.type === 'business');
  } else if (isIncome) {
    targetBucket = userBuckets.find(b => b.type === 'spending');
  } else {
    targetBucket = userBuckets.find(b => b.type === 'spending');
  }

  // Clean Merchant / Description: remove raw amounts
  let merchant = text
    .replace(/(?:₹|rs\.?|inr)\s*\d+(?:,\d+)*(?:\.\d+)?/gi, '')
    .replace(/\b\d+(?:,\d+)*(?:\.\d+)?\s*(?:rs|inr|rupees?|k|lakhs?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If merchant became empty, generate a polite label
  if (!merchant || merchant.length < 2) {
    merchant = isIncome ? 'Income deposit' : `${detectedCategory} expense`;
  } else {
    // Capitalize first letter
    merchant = merchant.charAt(0).toUpperCase() + merchant.slice(1);
  }

  const confidence = (amount && detectedCategory !== 'Uncategorised') ? 0.92 : 0.65;

  return {
    success: true,
    isAction: false,
    amount,
    type,
    category: detectedCategory,
    merchant,
    description: merchant,
    date: new Date().toISOString().slice(0, 10),
    accountId: targetAccount?.id || null,
    accountName: targetAccount?.name || 'Main Bank Account',
    bucketId: targetBucket?.id || null,
    bucketName: targetBucket?.name || 'Spending',
    necessity,
    necessityExplanation,
    isRecurring: detectedCategory === 'Investments & SIP' || detectedCategory === 'Subscriptions & Entertainment',
    confidence,
    isAmbiguous: detectedCategory === 'Uncategorised' || confidence < 0.8
  };
}

module.exports = {
  extractAmount,
  parseNaturalLanguageTransaction,
  CATEGORY_MAP
};
