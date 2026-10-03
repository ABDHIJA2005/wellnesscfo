const assert = require('node:assert');
const { initDatabase } = require('../server/db');
const { setupDefaultEntities, recordTransaction } = require('../server/financial-engine');
const { sanitizeText } = require('../server/ai/privacy');
const { extractAmount, parseNaturalLanguageTransaction } = require('../server/ai/deterministic-parser');
const {
  calculateOpportunityCost,
  evaluateAffordability,
  detectMoneyLeaks,
  generateMonthlyReview,
  processAIQuery
} = require('../server/ai/cfo-assistant');

console.log('--- STARTING PHASE 3 AI INTELLIGENCE & PRIVACY TESTS ---');

const db = initDatabase(':memory:');
const userA = 'usr_alice_p3';
const userB = 'usr_bob_p3';

db.prepare(`INSERT INTO users (id, email, password_hash, salt, name, created_at) VALUES (?, 'alice3@cfo.test', 'h', 's', 'Alice', '2026-10-03')`).run(userA);
db.prepare(`INSERT INTO users (id, email, password_hash, salt, name, created_at) VALUES (?, 'bob3@cfo.test', 'h', 's', 'Bob', '2026-10-03')`).run(userB);

setupDefaultEntities(db, userA);
setupDefaultEntities(db, userB);

const accountsA = db.prepare('SELECT id, name, type, balance FROM accounts WHERE user_id = ?').all(userA);
const bucketsA = db.prepare('SELECT id, name, type, balance FROM buckets WHERE user_id = ?').all(userA);

// Test 1: Privacy Sanitizer
console.log('Test 1: Privacy Sanitizer (PII Redaction)...');
const rawTextWithPII = 'Paid ₹5,000 from account 123456789012 to Aakash phone 9876543210 pan ABCDE1234F aadhaar 1234 5678 9012 with OTP 492019 at aakash@okhdfcbank';
const sanitized = sanitizeText(rawTextWithPII);
assert(!sanitized.includes('123456789012'), 'Bank account must be redacted');
assert(!sanitized.includes('9876543210'), 'Phone number must be redacted');
assert(!sanitized.includes('ABCDE1234F'), 'PAN must be redacted');
assert(!sanitized.includes('1234 5678 9012'), 'Aadhaar must be redacted');
assert(!sanitized.includes('492019'), 'OTP must be redacted');
assert(!sanitized.includes('aakash@okhdfcbank'), 'UPI ID must be redacted');
assert(sanitized.includes('[ACCOUNT_REDACTED]'));
assert(sanitized.includes('[PHONE_REDACTED]'));
assert(sanitized.includes('[PAN_REDACTED]'));
assert(sanitized.includes('[AADHAAR_REDACTED]'));
assert(sanitized.includes('[CODE_REDACTED]'));
assert(sanitized.includes('[UPI_REDACTED]'));

// Test 2: Natural Language Entry Parsing
console.log('Test 2: Natural Language Entry Parsing...');
// 2a: ₹280 dinner
const p1 = parseNaturalLanguageTransaction('₹280 dinner with friends', accountsA, bucketsA);
assert.strictEqual(p1.amount, 280, 'Amount should be 280');
assert.strictEqual(p1.type, 'expense');
assert.strictEqual(p1.category, 'Food & Dining');
assert.strictEqual(p1.necessity, 'Optional', 'Dinner with friends should be Optional');

// 2b: ₹20 pens for exam
const p2 = parseNaturalLanguageTransaction("₹20 pens for exam because I didn't have one", accountsA, bucketsA);
assert.strictEqual(p2.amount, 20);
assert.strictEqual(p2.type, 'expense');
assert.strictEqual(p2.category, 'Education & Stationery');
assert.strictEqual(p2.necessity, 'Necessary', 'Pens for exam should be Necessary');

// 2c: Got ₹27,000 stipend
const p3 = parseNaturalLanguageTransaction('Got ₹27,000 stipend', accountsA, bucketsA);
assert.strictEqual(p3.amount, 27000);
assert.strictEqual(p3.type, 'income');
assert.strictEqual(p3.category, 'Salary & Income');

// 2d: Transfer action
const p4 = parseNaturalLanguageTransaction('Move ₹1,000 from savings to business', accountsA, bucketsA);
assert.strictEqual(p4.isAction, true, 'Should detect transfer action');
assert.strictEqual(p4.actionType, 'transfer_bucket');
assert.strictEqual(p4.amount, 1000);
assert.strictEqual(p4.fromBucketName, 'Savings');
assert.strictEqual(p4.toBucketName, 'Business Fund');

// 2e: Ambiguous input
const p5 = parseNaturalLanguageTransaction('Bought something for ₹500', accountsA, bucketsA);
assert.strictEqual(p5.amount, 500);
assert.strictEqual(p5.category, 'Uncategorised', 'Ambiguous input must not guess false category');
assert.strictEqual(p5.necessity, 'Unclear');
assert.strictEqual(p5.isAmbiguous, true);

// Test 3: Affordability Engine
console.log('Test 3: Affordability Engine...');
// Fund Alice's account with ₹50,000 income
const bankA = accountsA.find(a => a.type === 'bank');
const spendingA = bucketsA.find(b => b.type === 'spending');

recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingA.id,
  type: 'income',
  amount: 50000,
  date: '2026-10-01',
  description: 'Salary'
});

const afford1 = evaluateAffordability(db, userA, 'Can I afford ₹3,000 shoes?');
assert.strictEqual(afford1.success, true);
assert.strictEqual(afford1.amount, 3000);
assert.strictEqual(afford1.verdict, 'affordable');
assert(afford1.metrics.availableCash >= 50000);

const affordHuge = evaluateAffordability(db, userA, 'Can I afford ₹80,000 international flight?');
assert.strictEqual(affordHuge.verdict, 'unaffordable', '80k exceeds 50k cash');

// Test 4: Opportunity Cost & Compound Growth Projections
console.log('Test 4: Opportunity Cost Projections...');
const opp = calculateOpportunityCost(3000);
assert.strictEqual(opp.principal, 3000);
assert(opp.disclaimer.includes('Illustrative estimate'));
const y10 = opp.projections.find(p => p.years === 10);
assert(y10, 'Should have 10-year projection');
const mod12 = y10.scenarios.find(s => s.rate === 12);
// 3000 * (1.12)^10 = ~9318
assert(mod12.lumpSumFV > 9000 && mod12.lumpSumFV < 9500, 'Compound math should accurately project ~9,318');

// Test 5: AI Command Queries matching Database Truth
console.log('Test 5: AI Command Queries against live ledger...');
// Add food transactions for Alice
recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingA.id,
  type: 'expense',
  amount: 1480,
  category: 'Food & Dining',
  date: '2026-10-02',
  description: 'Zepto Groceries'
});

recordTransaction(db, userA, {
  account_id: bankA.id,
  bucket_id: spendingA.id,
  type: 'expense',
  amount: 600,
  category: 'Food & Dining',
  date: '2026-10-02',
  description: 'Dinner with friends'
});

(async () => {
  const foodQuery = await processAIQuery(db, userA, 'How much did I spend on food this month?');
  assert.strictEqual(foodQuery.type, 'category_spending');
  assert.strictEqual(foodQuery.total, 2080, 'Total food spending must be 1480 + 600 = 2080');

  // Test 6: User Isolation in AI Queries
  console.log('Test 6: User Isolation in AI Queries...');
  const bobFoodQuery = await processAIQuery(db, userB, 'How much did I spend on food this month?');
  assert.strictEqual(bobFoodQuery.total, 0, 'Bob must have 0 food spending');

  // Test 7: Money Leak Analysis
  console.log('Test 7: Money Leak Analysis...');
  const leaks = detectMoneyLeaks(db, userA);
  assert(leaks.leaks !== undefined);

  // Test 8: Monthly CFO Review
  console.log('Test 8: Monthly CFO Review...');
  const review = generateMonthlyReview(db, userA, '2026-10');
  assert.strictEqual(review.cashFlow.income, 50000);
  assert.strictEqual(review.cashFlow.spending, 2080);
  assert.strictEqual(review.cashFlow.netSurplus, 50000 - 2080);

  console.log('--- ALL PHASE 3 AI INTELLIGENCE & PRIVACY TESTS PASSED! ---');
})();
