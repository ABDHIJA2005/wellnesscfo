// test/e2e-phase4-verification.js
// Verification of Phase 4 API endpoints and deterministic workflows against live server

const assert = require('assert');

const BASE_URL = 'http://localhost:3000';

async function runE2EPhase4() {
  console.log('=== STARTING PHASE 4 LIVE SERVER E2E VERIFICATION ===\n');

  // Step 1: Register/Login user
  const email = `phase4_user_${Date.now()}@example.com`;
  const password = 'Password@123';

  console.log('1. Registering user for Phase 4:', email);
  let regRes = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Phase 4 Tester' })
  });
  let regData = await regRes.json();
  assert.strictEqual(regRes.status, 201, 'Registration failed');
  const token = regData.token;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
  console.log('✓ User registered and authenticated.\n');

  // Initial deposit
  await fetch(`${BASE_URL}/api/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 60000,
      type: 'income',
      category: 'Income',
      description: 'Monthly Salary',
      date: new Date().toISOString().slice(0, 10)
    })
  });

  // Step 2: Test Investments API
  console.log('2. Testing Investments API...');
  let invCreateRes = await fetch(`${BASE_URL}/api/investments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Nifty 50 Index Fund',
      type: 'mutual_fund',
      invested_amount: 15000,
      current_value: 17250,
      units: 120,
      sip_amount: 2500,
      sip_day: 10
    })
  });
  let invCreateData = await invCreateRes.json();
  assert.strictEqual(invCreateRes.status, 201);
  const invId = invCreateData.investment.id;
  assert(invId);

  let invListRes = await fetch(`${BASE_URL}/api/investments`, { headers });
  let invListData = await invListRes.json();
  assert.strictEqual(invListData.investments.length, 1);
  assert.strictEqual(invListData.summary.totalInvested, 15000);
  assert.strictEqual(invListData.summary.totalValue, 17250);
  console.log('✓ Investment created and retrieved. Gain: ₹' + invListData.summary.totalGain);

  // Step 3: Test Lending API
  console.log('\n3. Testing Lending & Borrowing API...');
  let lendRes = await fetch(`${BASE_URL}/api/lending`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'lent',
      personName: 'Vikram',
      totalAmount: 4000,
      dueDate: '2026-11-15',
      notes: 'Lent for travel'
    })
  });
  let lendData = await lendRes.json();
  assert.strictEqual(lendRes.status, 201);
  const lendId = lendData.record.id;
  assert.strictEqual(lendData.record.outstandingAmount, 4000);

  // Partial repayment of ₹1,500
  let repRes = await fetch(`${BASE_URL}/api/lending/repayments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      lendingId: lendId,
      amount: 1500,
      date: new Date().toISOString().slice(0, 10)
    })
  });
  let repData = await repRes.json();
  assert.strictEqual(repRes.status, 201);
  assert.strictEqual(repData.remainingOutstanding, 2500);

  let lendListRes = await fetch(`${BASE_URL}/api/lending`, { headers });
  let lendListData = await lendListRes.json();
  assert.strictEqual(lendListData.summary.totalLent, 2500);
  console.log('✓ Lending record and partial repayment verified. Outstanding: ₹2,500');

  // Step 4: Test Split Expenses API
  console.log('\n4. Testing Split Expenses API...');
  let splitRes = await fetch(`${BASE_URL}/api/splits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Cafe Brunch',
      totalAmount: 1800,
      myShare: 600,
      payer: 'me',
      category: 'Food & Dining',
      participants: [
        { name: 'Aditi', shareAmount: 600 },
        { name: 'Karan', shareAmount: 600 }
      ]
    })
  });
  let splitData = await splitRes.json();
  assert.strictEqual(splitRes.status, 201);
  assert.strictEqual(splitData.split.myShare, 600);

  let splitListRes = await fetch(`${BASE_URL}/api/splits`, { headers });
  let splitListData = await splitListRes.json();
  assert.strictEqual(splitListData.splits.length, 1);
  assert.strictEqual(splitListData.splits[0].participants.length, 2);
  console.log('✓ Split expense verified: My share ₹600, total ₹1,800 across 3 people.');

  // Step 5: Test Recurring Commitments & Financial Calendar
  console.log('\n5. Testing Recurring Commitments & Financial Calendar...');
  let recRes = await fetch(`${BASE_URL}/api/recurring`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Internet Broadband',
      type: 'bill',
      amount: 999,
      frequency: 'monthly',
      nextDate: '2026-10-20'
    })
  });
  let recData = await recRes.json();
  assert.strictEqual(recRes.status, 201);
  const recId = recData.commitment.id;

  let calRes = await fetch(`${BASE_URL}/api/calendar?start=2026-10-01&end=2026-11-30`, { headers });
  let calData = await calRes.json();
  assert.strictEqual(calRes.status, 200);
  assert(calData.events.length > 0, 'Calendar events expected');
  const hasBill = calData.events.some(e => e.title === 'Internet Broadband');
  assert(hasBill, 'Broadband event should appear in calendar');
  console.log('✓ Financial calendar successfully aggregated upcoming events:', calData.events.length);

  // Step 6: Test Phase 4 Natural-Language Parse
  console.log('\n6. Testing Phase 4 Natural Language Parsing...');
  // 6a: ₹2,000 SIP
  let parseSipRes = await fetch(`${BASE_URL}/api/ai/parse-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '₹2,000 SIP' })
  });
  let parseSipData = await parseSipRes.json();
  assert.strictEqual(parseSipData.parsed.amount, 2000);
  assert.strictEqual(parseSipData.parsed.category, 'Investments & SIP');
  assert.strictEqual(parseSipData.parsed.isRecurring, true);
  console.log('✓ "₹2,000 SIP" parsed to Investments & SIP with isRecurring: true');

  // 6b: Lent ₹2,000 to Aakash
  let parseLendRes = await fetch(`${BASE_URL}/api/ai/parse-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: 'Lent ₹2,000 to Aakash' })
  });
  let parseLendData = await parseLendRes.json();
  assert.strictEqual(parseLendData.parsed.isAction, true);
  assert.strictEqual(parseLendData.parsed.actionType, 'record_lending');
  assert.strictEqual(parseLendData.parsed.amount, 2000);
  assert.strictEqual(parseLendData.parsed.personName, 'Aakash');
  console.log('✓ "Lent ₹2,000 to Aakash" parsed as lending action proposal');

  // 6c: Execute lending proposal via AI action endpoint
  let execLendRes = await fetch(`${BASE_URL}/api/ai/execute-action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ actionProposal: parseLendData.parsed })
  });
  let execLendData = await execLendRes.json();
  assert.strictEqual(execLendRes.status, 200);
  assert.strictEqual(execLendData.success, true);
  console.log('✓ Lending action confirmed and executed via AI Command.');

  // Step 7: Check Financial Summary Net Worth reflects Phase 4
  console.log('\n7. Verifying Financial Summary and Net Worth math...');
  let summaryRes = await fetch(`${BASE_URL}/api/summary`, { headers });
  let summaryData = await summaryRes.json();
  assert(summaryData.totalReceivables > 0, 'Receivables should be reflected in summary');
  assert(summaryData.netWorth > 0, 'Net worth must be positive');
  console.log('✓ Summary metrics: Total Investments = ₹' + summaryData.investments + ' | Receivables = ₹' + summaryData.totalReceivables + ' | Net Worth = ₹' + summaryData.netWorth);

  console.log('\n=== ALL PHASE 4 LIVE SERVER E2E TESTS PASSED 100% SUCCESSFULLY! ===');
}

runE2EPhase4().catch(err => {
  console.error('Phase 4 E2E Error:', err);
  process.exit(1);
});
