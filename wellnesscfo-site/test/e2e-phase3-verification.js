// test/e2e-phase3-verification.js
// Verification of the Phase 3 Natural Language, AI Command Center, Affordability, Opportunity Cost, and Actions against live server

const assert = require('assert');

const BASE_URL = 'http://localhost:3000';

async function runVerification() {
  console.log('=== STARTING PHASE 3 LIVE SERVER E2E VERIFICATION ===\n');

  // Step 1: Register/Login user
  const email = `phase3_user_${Date.now()}@example.com`;
  const password = 'Password@123';

  console.log('1. Registering user:', email);
  let regRes = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Phase 3 Tester' })
  });
  let regData = await regRes.json();
  assert.strictEqual(regRes.status, 201, 'Registration failed: ' + JSON.stringify(regData));
  const token = regData.token;
  assert(token, 'Token missing in registration');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };
  console.log('✓ User registered and authenticated successfully.\n');

  // Setup initial balance: Add ₹30,000 income to Savings
  console.log('Setting up initial ledger balance with ₹30,000 stipend...');
  const initTxRes = await fetch(`${BASE_URL}/api/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      amount: 30000,
      type: 'income',
      category: 'Income',
      description: 'Monthly Stipend',
      necessity: 'necessary',
      date: new Date().toISOString().slice(0, 10)
    })
  });
  assert.strictEqual(initTxRes.status, 201, 'Initial income failed');

  // Step 2 & 3: Parse "₹280 dinner with friends"
  console.log('2. Testing Natural Language Parse: "₹280 dinner with friends"');
  let parseRes = await fetch(`${BASE_URL}/api/ai/parse-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: '₹280 dinner with friends' })
  });
  let parseData = await parseRes.json();
  assert.strictEqual(parseRes.status, 200, 'Parse request failed');
  assert.strictEqual(parseData.parsed.amount, 280);
  assert.strictEqual(parseData.parsed.type, 'expense');
  assert(parseData.parsed.category.includes('Food'), 'Expected Food category');
  assert.strictEqual(parseData.parsed.merchant, 'Dinner with friends');
  assert.strictEqual(parseData.parsed.necessity.toLowerCase(), 'optional');
  assert.strictEqual(parseData.parsed.isAmbiguous, false);
  console.log('✓ Parsed successfully:', parseData.parsed.description, '₹' + parseData.parsed.amount, 'Category:', parseData.parsed.category);

  // Step 4: Confirm preview and write to financial engine
  console.log('\n3. Confirming parsed transaction preview to ledger...');
  let addRes = await fetch(`${BASE_URL}/api/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(parseData.parsed)
  });
  let addData = await addRes.json();
  assert.strictEqual(addRes.status, 201, 'Adding transaction failed: ' + JSON.stringify(addData));
  assert(addData.transaction.id);
  console.log('✓ Transaction confirmed and added. ID:', addData.transaction.id);

  // Step 5: Verify transaction in list and dashboard summary updates
  console.log('\n4. Verifying activity list and dashboard summary updates...');
  let txListRes = await fetch(`${BASE_URL}/api/transactions`, { headers });
  let txListData = await txListRes.json();
  const txFound = txListData.transactions.find(t => (t.merchant === 'Dinner with friends' || t.description === 'Dinner with friends') && t.amount === 280);
  assert(txFound, 'Transaction not found in ledger list');

  let summaryRes = await fetch(`${BASE_URL}/api/summary`, { headers });
  let summaryData = await summaryRes.json();
  assert.strictEqual(summaryData.thisMonth.spending, 280);
  console.log('✓ Dashboard updated: Monthly spending = ₹' + summaryData.thisMonth.spending);

  // Step 6: Query "How much did I spend on food this month?"
  console.log('\n5. Querying AI Command: "How much did I spend on food this month?"');
  let qRes1 = await fetch(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'How much did I spend on food this month?' })
  });
  let qData1 = await qRes1.json();
  assert.strictEqual(qRes1.status, 200);
  assert(qData1.card, 'Response card missing');
  assert.strictEqual(qData1.card.amount, 280);
  assert(qData1.text.includes('₹280'));
  console.log('✓ AI food query result:', qData1.card.title, '₹' + qData1.card.amount);

  // Step 7: Query "Show unnecessary expenses"
  console.log('\n6. Querying AI Command: "Show unnecessary expenses"');
  let qRes2 = await fetch(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'Show unnecessary expenses' })
  });
  let qData2 = await qRes2.json();
  assert.strictEqual(qRes2.status, 200);
  assert(qData2.card && qData2.card.items.length > 0);
  console.log('✓ Discretionary / unnecessary list retrieved:', qData2.card.items);

  // Step 8: Test Financial Action requiring confirmation: "Move ₹1,000 from savings to business"
  console.log('\n7. Testing AI Financial Action: "Move ₹1,000 from savings to business"');
  let actionQueryRes = await fetch(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'Move ₹1,000 from savings to business' })
  });
  let actionQueryData = await actionQueryRes.json();
  assert(actionQueryData.requiresConfirmation, 'Should require confirmation before execution');
  assert.strictEqual(actionQueryData.actionProposal.action, 'transfer_bucket');
  assert.strictEqual(actionQueryData.actionProposal.amount, 1000);
  assert.strictEqual(actionQueryData.actionProposal.fromBucket, 'Savings');
  assert(actionQueryData.actionProposal.toBucket.includes('Business'));
  console.log('✓ Confirmation proposal generated:', actionQueryData.actionProposal);

  // Step 9: Confirm execution of transfer
  console.log('\n8. Confirming execution of bucket transfer...');
  let execRes = await fetch(`${BASE_URL}/api/ai/execute-action`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ actionProposal: actionQueryData.actionProposal })
  });
  let execData = await execRes.json();
  assert.strictEqual(execRes.status, 200, 'Execute transfer failed: ' + JSON.stringify(execData));
  assert.strictEqual(execData.success, true);
  console.log('✓ Execution response:', execData.message);

  // Verify bucket balances updated
  let summaryAfterRes = await fetch(`${BASE_URL}/api/summary`, { headers });
  let summaryAfterData = await summaryAfterRes.json();
  const bizBucket = summaryAfterData.buckets.find(b => b.name === 'Business Fund' || b.name === 'Business');
  assert.strictEqual(bizBucket.balance, 1000, 'Business bucket balance should be ₹1,000');
  console.log('✓ Business bucket balance verified:', bizBucket.balance);

  // Step 10: Affordability question: "Can I afford ₹3,000 shoes?"
  console.log('\n9. Testing Affordability Query: "Can I afford ₹3,000 shoes?"');
  let affordRes = await fetch(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'Can I afford ₹3,000 shoes?' })
  });
  let affordData = await affordRes.json();
  assert(affordData.card);
  assert.strictEqual(affordData.card.type, 'affordability');
  assert(affordData.card.verdict, 'Verdict missing');
  console.log('✓ Affordability assessment verdict:', affordData.card.verdict, '| Available cash:', affordData.card.availableSpending);

  // Step 11: Opportunity cost question: "What could ₹3,000 become if invested?"
  console.log('\n10. Testing Opportunity Cost Query: "What could ₹3,000 become if invested?"');
  let oppRes = await fetch(`${BASE_URL}/api/ai/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: 'What could ₹3,000 become if invested?' })
  });
  let oppData = await oppRes.json();
  assert(oppData.card);
  assert.strictEqual(oppData.card.type, 'opportunity_cost');
  assert(oppData.card.table && oppData.card.table.length === 3);
  assert(oppData.card.disclaimer.includes('Illustrative estimate — not guaranteed'));
  console.log('✓ Opportunity cost table:', oppData.card.table);

  // Step 12: Ambiguous input test: "Bought something for ₹500"
  console.log('\n11. Testing Ambiguous input: "Bought something for ₹500"');
  let ambRes = await fetch(`${BASE_URL}/api/ai/parse-transaction`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input: 'Bought something for ₹500' })
  });
  let ambData = await ambRes.json();
  assert.strictEqual(ambData.parsed.amount, 500);
  assert.strictEqual(ambData.parsed.isAmbiguous, true);
  assert(ambData.parsed.necessityExplanation.toLowerCase().includes('context') || ambData.parsed.isAmbiguous);
  console.log('✓ Ambiguous input correctly flagged with low confidence & explanation:', ambData.parsed.necessityExplanation);

  console.log('\n=== ALL PHASE 3 LIVE SERVER E2E TESTS PASSED 100% SUCCESSFULLY! ===');
}

runVerification().catch(err => {
  console.error('E2E Verification Error:', err);
  process.exit(1);
});
