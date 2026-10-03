'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = 35100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const productionPort = port + 1000;
const productionBase = `http://127.0.0.1:${productionPort}`;
const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: ':memory:' },
  stdio: 'ignore'
});
const productionServer = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(productionPort), DB_PATH: ':memory:', DATABASE_URL: '' },
  stdio: 'ignore'
});

async function waitForServer(url, processHandle) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (processHandle.exitCode != null) throw new Error(`Security test server exited (${processHandle.exitCode})`);
    try {
      const response = await fetch(`${url}/api/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Security test server did not become ready');
}

async function request(route, { method = 'GET', body, cookie, origin } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {})
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function run() {
  try {
    await waitForServer(base, server);
    await waitForServer(productionBase, productionServer);
    console.log('--- PHASE 7 LOCAL SECURITY HARDENING TESTS ---');

    const preflight = await request('/api/profile', { method: 'OPTIONS', origin: 'https://attacker.example' });
    assert.equal(preflight.response.status, 204);
    assert.equal(preflight.response.headers.get('access-control-allow-origin'), null, 'The API does not grant wildcard CORS access');

    const badOrigin = await request('/api/auth/signup', {
      method: 'POST', origin: 'https://attacker.example',
      body: { name: 'Blocked', email: 'blocked@example.test', password: 'long-enough-password' }
    });
    assert.equal(badOrigin.response.status, 403, 'Cross-origin state changes are rejected');

    const signup = await request('/api/auth/signup', {
      method: 'POST', origin: base,
      body: { name: 'Cookie User', email: `phase7-${crypto.randomUUID()}@example.test`, password: 'long-enough-password' }
    });
    assert.equal(signup.response.status, 201);
    assert.equal(typeof signup.body.token, 'string', 'Development test clients retain bearer-token compatibility');
    const setCookie = signup.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    const cookie = setCookie.split(';', 1)[0];

    const me = await request('/api/auth/me', { cookie });
    assert.equal(me.response.status, 200, 'Same-origin browser session authenticates with its cookie');
    assert.equal(me.response.headers.get('cache-control'), 'no-store', 'API data responses are not cacheable');

    const insightResponse = await request('/api/insights?month=2026-10', { cookie });
    assert.equal(insightResponse.response.status, 200, 'Authenticated local SQLite account can load monthly insights');
    assert.equal(insightResponse.body.month, '2026-10');
    assert.equal(insightResponse.response.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/api/insights?month=2026-99', { cookie })).response.status, 400, 'Invalid insight periods are rejected');
    const estimateResponse = await request('/api/insights/affordability', { method: 'POST', cookie, origin: base, body: { purchaseAmount: 500, targetBalance: 0 } });
    assert.equal(estimateResponse.response.status, 200);
    assert.equal(estimateResponse.body.purchaseAmount, 500);
    assert.equal(typeof estimateResponse.body.remainingAfterPurchase, 'number');
    assert.equal((await request('/api/insights', {})).response.status, 401, 'Insights require authentication');

    const malformed = await request('/api/profile', { method: 'PUT', cookie, origin: base, body: '{' });
    assert.equal(malformed.response.status, 400, 'Malformed JSON is a client error');

    const tooLarge = await request('/api/profile', {
      method: 'PUT', cookie, origin: base,
      body: JSON.stringify({ name: 'A'.repeat(3 * 1024 * 1024 + 16) })
    });
    assert.equal(tooLarge.response.status, 413, 'Oversized request bodies are rejected');

    const internalError = await request('/api/transactions', { method: 'POST', cookie, origin: base, body: 'null' });
    assert.equal(internalError.response.status, 500);
    assert.deepEqual(internalError.body, { error: 'Internal server error' }, 'Internal exception details are not returned to clients');

    const logout = await request('/api/auth/logout', { method: 'POST', cookie, origin: base });
    assert.equal(logout.response.status, 200);
    assert.match(logout.response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await request('/api/auth/me', { cookie })).response.status, 401, 'Logout invalidates the cookie session');

    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.equal(html.includes('demo-login-btn'), false, 'The demo account control is not shipped');
    assert.equal(html.includes('Password123!'), false, 'Demo credentials are not shipped');

    const clientScript = await (await fetch(`${base}/app.js`)).text();
    assert.equal(clientScript.includes('demo@wellnesscfo.com'), false, 'Demo account credentials are absent from client code');
    assert.equal(clientScript.includes("localStorage.getItem('wellnesscfo-token')"), false, 'The browser does not read bearer tokens from local storage');
    assert(clientScript.includes('DETERMINISTIC FINANCIAL INTELLIGENCE') === false, 'Insight UI markup is served in HTML, not injected by inline client code');
    assert((await (await fetch(`${base}/`)).text()).includes('Purchase balance estimate'));

    const productionPage = await fetch(productionBase);
    assert.equal(productionPage.status, 200, 'Production mode starts locally without a PostgreSQL URL');
    assert.equal(productionPage.headers.get('content-security-policy').includes('fonts.googleapis.com'), false, 'The app does not depend on remote font services');
    const productionSignup = await fetch(`${productionBase}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: productionBase },
      body: JSON.stringify({ name: 'Local Production', email: `phase7-prod-${crypto.randomUUID()}@example.test`, password: 'long-enough-password' })
    });
    assert.equal(productionSignup.status, 201, 'Production mode can create a local SQLite-backed account');
    assert.match(productionSignup.headers.get('set-cookie'), /__Host-wellnesscfo=.*;.*HttpOnly;.*Secure/);
    assert.equal(Object.hasOwn(await productionSignup.json(), 'token'), false, 'Production auth does not expose the session token in JSON');

    console.log('✓ Same-origin cookie auth, CORS denial, CSRF origin check, bounded bodies, safe errors, security headers, demo removal, offline assets, and local SQLite startup in production mode');
  } finally {
    server.kill();
    productionServer.kill();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
