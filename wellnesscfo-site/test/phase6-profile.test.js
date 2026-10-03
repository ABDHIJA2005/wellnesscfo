'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const port = 34100 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const testPassword = crypto.randomBytes(24).toString('base64url');
const serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), DB_PATH: ':memory:' },
  stdio: 'ignore'
});

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    if (serverProcess.exitCode != null) throw new Error(`Profile test server exited (${serverProcess.exitCode})`);
    try {
      const response = await fetch(`${base}/api/profile`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Profile test server did not start');
}

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function createUser(name, email) {
  const response = await request('/api/auth/signup', {
    method: 'POST',
    body: { name, email, password: testPassword }
  });
  assert.equal(response.status, 201);
  return response.body.token;
}

async function run() {
  try {
    await waitForServer();
    console.log('--- PHASE 6 PROFILE, PREFERENCES & AUTH TESTS ---');

    const unauthorized = await request('/api/profile');
    assert.equal(unauthorized.status, 401, 'Profile APIs require authentication');
    assert.equal((await request('/api/profile/preferences')).status, 401, 'Preferences require authentication');
    assert.equal((await request('/api/profile/avatar')).status, 401, 'Avatar access requires authentication');

    const emailA = `phase6-a-${Date.now()}@example.test`;
    const emailB = `phase6-b-${Date.now()}@example.test`;
    const tokenA = await createUser('Profile User A', emailA);
    const tokenB = await createUser('Profile User B', emailB);
    const initialA = await request('/api/profile', { token: tokenA });
    const initialB = await request('/api/profile', { token: tokenB });
    assert.equal(initialA.status, 200);
    assert.equal(initialA.body.profile.name, 'Profile User A');
    assert.equal(initialA.body.profile.somethingILove, '');
    assert.equal(initialA.body.profile.financeMotto, '');
    assert.equal(initialA.body.profile.email, emailA);
    assert.equal(initialB.body.profile.name, 'Profile User B');
    console.log('✓ Authenticated profile creation/read and genuinely empty optional fields');

    const savedA = await request('/api/profile', {
      method: 'PUT', token: tokenA,
      body: { name: 'A Updated', email: emailB, somethingILove: 'Singing', financeMotto: 'Save with intention' }
    });
    assert.equal(savedA.status, 200);
    assert.equal(savedA.body.profile.name, 'A Updated');
    assert.equal(savedA.body.profile.somethingILove, 'Singing');
    assert.equal(savedA.body.profile.financeMotto, 'Save with intention');
    assert.equal(savedA.body.profile.email, emailA, 'Email stays read-only even if a client submits another value');
    assert.equal((await request('/api/auth/me', { token: tokenA })).body.user.name, 'A Updated', 'Existing authenticated UI receives the updated name');
    assert.equal((await request('/api/profile', { token: tokenB })).body.profile.name, 'Profile User B');
    assert.equal((await request('/api/profile', { method: 'PUT', token: tokenA, body: { userId: 'user-b', name: 'Injected', financeMotto: '', somethingILove: '' } })).body.profile.name, 'Injected');
    assert.equal((await request('/api/profile', { token: tokenB })).body.profile.name, 'Profile User B', 'Client supplied user IDs cannot modify another profile');
    assert.equal((await request('/api/profile', { method: 'PUT', token: tokenA, body: { name: '' } })).status, 400);
    assert.equal((await request('/api/profile', { method: 'PUT', token: tokenA, body: { name: 'A', financeMotto: 'x'.repeat(161) } })).status, 400);
    console.log('✓ Profile updates persist, validate optional fields, and ignore cross-user IDs');

    assert.deepEqual((await request('/api/profile/preferences', { token: tokenA })).body.preferences, { currency: 'INR', dateFormat: 'en-IN' });
    const preferencesA = await request('/api/profile/preferences', {
      method: 'PUT', token: tokenA, body: { currency: 'INR', dateFormat: 'numeric' }
    });
    assert.equal(preferencesA.status, 200);
    assert.deepEqual(preferencesA.body.preferences, { currency: 'INR', dateFormat: 'numeric' });
    assert.equal((await request('/api/profile/preferences', { token: tokenB })).body.preferences.dateFormat, 'en-IN');
    assert.equal((await request('/api/profile/preferences', { method: 'PUT', token: tokenA, body: { currency: 'USD' } })).status, 400);
    assert.equal((await request('/api/profile/preferences', { method: 'PUT', token: tokenA, body: { dateFormat: 'unsupported' } })).status, 400);
    assert.equal((await request('/api/profile/preferences', { token: tokenA })).body.preferences.dateFormat, 'numeric');
    console.log('✓ Preferences persist per user; INR-only currency and supported date styles are enforced');

    const pixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
    const avatarA = await request('/api/profile/avatar', { method: 'PUT', token: tokenA, body: { dataUrl: pixelPng } });
    assert.equal(avatarA.status, 200);
    assert.equal((await request('/api/profile/avatar', { token: tokenA })).body.avatar, pixelPng);
    assert.equal((await request('/api/profile', { token: tokenA })).body.profile.hasAvatar, true);
    assert.equal((await request('/api/profile/avatar', { token: tokenB })).body.avatar, null);
    const avatarBBytes = Buffer.from(pixelPng.split(',')[1], 'base64');
    avatarBBytes[28] ^= 1;
    const avatarB = `data:image/png;base64,${avatarBBytes.toString('base64')}`;
    assert.equal((await request('/api/profile/avatar', { method: 'PUT', token: tokenB, body: { dataUrl: avatarB } })).status, 200);
    assert.equal((await request('/api/profile/avatar?userId=user-b', { token: tokenA })).body.avatar, pixelPng, 'Avatar reads are bound to the session even if a foreign ID is supplied');
    assert.equal((await request('/api/profile/avatar', { method: 'PUT', token: tokenA, body: { dataUrl: avatarB } })).status, 200, 'A user can replace their own avatar');
    assert.equal((await request('/api/profile/avatar', { token: tokenA })).body.avatar, avatarB);
    assert.equal((await request('/api/profile/avatar', { method: 'PUT', token: tokenA, body: { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' } })).status, 400);
    assert.equal((await request('/api/profile/avatar', { method: 'PUT', token: tokenA, body: { dataUrl: 'data:image/png;base64,SGVsbG8=' } })).status, 400, 'Declared MIME type must match image bytes');
    const oversized = `data:image/png;base64,${Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(512 * 1024)]).toString('base64')}`;
    assert.equal((await request('/api/profile/avatar', { method: 'PUT', token: tokenA, body: { dataUrl: oversized } })).status, 400);
    assert.equal((await request('/api/profile/avatar', { method: 'DELETE', token: tokenA })).body.hasAvatar, false);
    assert.equal((await request('/api/profile/avatar', { token: tokenA })).body.avatar, null, 'Avatar fallback is available after removal');
    console.log('✓ PNG upload, invalid/oversized rejection, replacement storage, fallback, and avatar isolation');

    assert.equal((await request('/api/auth/logout', { method: 'POST', token: tokenA })).status, 200);
    assert.equal((await request('/api/profile', { token: tokenA })).status, 401, 'Logout invalidates the active session');
    const relogin = await request('/api/auth/login', {
      method: 'POST', body: { email: emailA, password: testPassword }
    });
    assert.equal(relogin.status, 200, 'A valid login creates a fresh session');
    const restoredProfile = await request('/api/profile', { token: relogin.body.token });
    assert.equal(restoredProfile.body.profile.name, 'Injected');
    assert.equal(restoredProfile.body.profile.somethingILove, '');
    assert.equal((await request('/api/profile/preferences', { token: relogin.body.token })).body.preferences.dateFormat, 'numeric');
    console.log('✓ Logout invalidates the old session; a new login restores backend profile and preferences');
  } finally {
    serverProcess.kill();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
