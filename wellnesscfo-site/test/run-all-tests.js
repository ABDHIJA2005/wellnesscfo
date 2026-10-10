'use strict';

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const root = path.join(__dirname, '..');
process.env.NODE_ENV = 'test';
let server;
let baseUrl;

async function reserveAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode != null) throw new Error(`Regression server exited unexpectedly with code ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Regression server did not become ready');
}

async function run() {
  try {
    const port = await reserveAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DB_PATH: ':memory:' },
      stdio: 'ignore'
    });
    await waitForServer();
    const tests = [
      'financial-engine.test.js',
      'integration.test.js',
      'phase2-core-cfo.test.js',
      'phase3-ai.test.js',
      'e2e-phase3-verification.js',
      'phase4-advanced.test.js',
      'e2e-phase4-verification.js',
      'phase5-import-privacy.test.js',
      'phase6-profile.test.js',
      'phase7-local-security.test.js',
      'phase8-local-data.test.js',
      'phase9-financial-insights.test.js'
    ];
    for (const test of tests) {
      const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
        cwd: root,
        env: { ...process.env, TEST_BASE_URL: baseUrl },
        stdio: 'inherit'
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status || 1;
        return;
      }
    }
  } finally {
    if (server && server.exitCode == null) server.kill();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
