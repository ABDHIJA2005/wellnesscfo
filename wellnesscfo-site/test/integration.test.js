const assert = require('node:assert');
const http = require('node:http');

// Helper to make HTTP requests
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runIntegrationTests() {
  console.log('--- STARTING API INTEGRATION TESTS ---');
  const host = 'localhost';
  const port = process.env.TEST_PORT || 3001;

  process.env.PORT = port;
  process.env.DB_PATH = ':memory:';

  // Import and spin up server
  require('../server.js');
  await new Promise(r => setTimeout(r, 500));

  // Test 1: Signup User Alice
  console.log('Integration Test 1: User Signup...');
  const resAlice = await request({
    host, port, path: '/api/auth/signup', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'alice@cfo.test',
    password: 'Password123!',
    name: 'Alice Smith',
    motto: 'Intentional Living'
  });

  assert.strictEqual(resAlice.status, 201, 'Alice signup should return 201');
  assert(resAlice.body.token, 'Should receive session token');
  const tokenAlice = resAlice.body.token;

  // Test 2: Signup User Bob
  const resBob = await request({
    host, port, path: '/api/auth/signup', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'bob@cfo.test',
    password: 'Password456!',
    name: 'Bob Jones'
  });
  assert.strictEqual(resBob.status, 201, 'Bob signup should return 201');
  const tokenBob = resBob.body.token;

  // Test 3: Financial Summary initial state
  console.log('Integration Test 2: Initial financial summary...');
  const summaryRes = await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  });
  assert.strictEqual(summaryRes.status, 200);
  assert.strictEqual(summaryRes.body.availableCash, 0);
  assert.strictEqual(summaryRes.body.netWorth, 0);
  const bankAcc = summaryRes.body.accounts.find(a => a.type === 'bank');
  const cashAcc = summaryRes.body.accounts.find(a => a.type === 'cash');
  const spendingBkt = summaryRes.body.buckets.find(b => b.type === 'spending');
  const savingsBkt = summaryRes.body.buckets.find(b => b.type === 'savings');
  const investBkt = summaryRes.body.buckets.find(b => b.type === 'investments');

  // Test 4: Income: Add ₹27,000
  console.log('Integration Test 3: Record ₹27,000 income...');
  const incomeRes = await request({
    host, port, path: '/api/transactions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAlice}` }
  }, {
    account_id: bankAcc.id,
    bucket_id: spendingBkt.id,
    amount: 27000,
    type: 'income',
    date: '2026-10-03',
    description: 'October Salary'
  });
  assert.strictEqual(incomeRes.status, 201);

  const summaryAfterIncome = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  })).body;
  assert.strictEqual(summaryAfterIncome.availableCash, 27000, 'Available cash should be 27,000');
  assert.strictEqual(summaryAfterIncome.netWorth, 27000, 'Net worth should be 27,000');
  assert.strictEqual(summaryAfterIncome.thisMonth.income, 27000, 'Monthly income should be 27,000');

  // Test 5: Expense: Add ₹500
  console.log('Integration Test 4: Record ₹500 expense...');
  const expenseRes = await request({
    host, port, path: '/api/transactions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAlice}` }
  }, {
    account_id: bankAcc.id,
    bucket_id: spendingBkt.id,
    amount: 500,
    type: 'expense',
    date: '2026-10-03',
    description: 'Groceries'
  });
  assert.strictEqual(expenseRes.status, 201);

  const summaryAfterExpense = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  })).body;
  assert.strictEqual(summaryAfterExpense.availableCash, 26500, 'Available cash should be 26,500');
  assert.strictEqual(summaryAfterExpense.thisMonth.spending, 500, 'Monthly spending should be 500');

  // Test 6: Bucket transfer: Move ₹1,000 from Savings -> Investments
  console.log('Integration Test 5: Bucket transfer (Savings -> Investments)...');
  // First allocate 5000 to Savings
  await request({
    host, port, path: '/api/transfers/bucket', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAlice}` }
  }, {
    fromBucketId: spendingBkt.id,
    toBucketId: savingsBkt.id,
    amount: 5000,
    description: 'Initial savings allocation'
  });

  const bktTransferRes = await request({
    host, port, path: '/api/transfers/bucket', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAlice}` }
  }, {
    fromBucketId: savingsBkt.id,
    toBucketId: investBkt.id,
    amount: 1000,
    description: 'Savings to Investments'
  });
  assert.strictEqual(bktTransferRes.status, 201);

  const summaryAfterBktTransfer = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  })).body;
  assert.strictEqual(summaryAfterBktTransfer.thisMonth.spending, 500, 'Spending must NOT increase on bucket transfer');
  assert.strictEqual(summaryAfterBktTransfer.netWorth, 26500, 'Net worth must NOT decrease on bucket transfer');
  const sBkt = summaryAfterBktTransfer.buckets.find(b => b.id === savingsBkt.id);
  const iBkt = summaryAfterBktTransfer.buckets.find(b => b.id === investBkt.id);
  assert.strictEqual(sBkt.balance, 4000, 'Savings bucket decreased by 1,000');
  assert.strictEqual(iBkt.balance, 1000, 'Investments bucket increased by 1,000');

  // Test 7: Multiple accounts transfer: Bank -> Cash (₹2,000)
  console.log('Integration Test 6: Account transfer (Bank -> Cash)...');
  const accTransferRes = await request({
    host, port, path: '/api/transfers/account', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenAlice}` }
  }, {
    fromAccountId: bankAcc.id,
    toAccountId: cashAcc.id,
    amount: 2000,
    description: 'ATM withdrawal'
  });
  assert.strictEqual(accTransferRes.status, 201);

  const summaryAfterAccTransfer = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenAlice}` }
  })).body;
  assert.strictEqual(summaryAfterAccTransfer.availableCash, 26500, 'Available cash remains unchanged');
  assert.strictEqual(summaryAfterAccTransfer.netWorth, 26500, 'Net worth remains unchanged');
  assert.strictEqual(summaryAfterAccTransfer.thisMonth.spending, 500, 'Spending remains unchanged');
  const bAcc = summaryAfterAccTransfer.accounts.find(a => a.id === bankAcc.id);
  const cAcc = summaryAfterAccTransfer.accounts.find(a => a.id === cashAcc.id);
  assert.strictEqual(bAcc.balance, 24500); // 27000 - 500 - 2000 = 24500
  assert.strictEqual(cAcc.balance, 2000);  // 0 + 2000 = 2000

  // Test 8: User Isolation Check
  console.log('Integration Test 7: User Isolation...');
  const summaryBob = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenBob}` }
  })).body;
  assert.strictEqual(summaryBob.availableCash, 0, 'Bob has zero available cash');
  assert.strictEqual(summaryBob.thisMonth.income, 0, 'Bob has zero income');

  // Bob tries to execute transfer on Alice's accounts
  const crossTransferRes = await request({
    host, port, path: '/api/transfers/account', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenBob}` }
  }, {
    fromAccountId: bankAcc.id, // Alice's bank account
    toAccountId: summaryBob.accounts[0].id,
    amount: 5000
  });
  assert.strictEqual(crossTransferRes.status, 500, 'Cross user transfer must be rejected');

  // Test 9: Legacy migration via API
  console.log('Integration Test 8: Legacy data migration via API...');
  const legacyPayload = {
    transactions: [
      { date: '2026-10-02', description: 'Acme Salary', category: 'Income', amount: 80000, type: 'income' },
      { date: '2026-10-01', description: 'Coffee', category: 'Food', amount: -250, type: 'expense' }
    ],
    portfolio: [
      { kind: 'Mutual funds', value: 150000, asOf: '2026-10-01' }
    ]
  };

  const migrateRes = await request({
    host, port, path: '/api/migrate', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenBob}` }
  }, legacyPayload);

  assert.strictEqual(migrateRes.status, 200);
  assert.strictEqual(migrateRes.body.migratedTransactions, 2);
  assert.strictEqual(migrateRes.body.migratedPortfolio, 1);

  const bobAfterMigration = (await request({
    host, port, path: '/api/summary', method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenBob}` }
  })).body;
  assert.strictEqual(bobAfterMigration.availableCash, 79750); // 80000 - 250
  assert.strictEqual(bobAfterMigration.investments, 150000);
  assert.strictEqual(bobAfterMigration.netWorth, 79750 + 150000);

  console.log('--- ALL API INTEGRATION TESTS PASSED! ---');
  process.exit(0);
}

runIntegrationTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
