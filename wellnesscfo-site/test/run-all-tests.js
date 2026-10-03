'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  cwd: root,
  env: { ...process.env, PORT: '3000', DB_PATH: ':memory:' },
  stdio: 'ignore'
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode != null) throw new Error(`Regression server exited (${server.exitCode}); port 3000 may already be in use`);
    try {
      const response = await fetch('http://127.0.0.1:3000/api/auth/me');
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Regression server did not become ready');
}

async function run() {
  try {
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
      'phase7-local-security.test.js'
    ];
    for (const test of tests) {
      const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
        cwd: root,
        env: process.env,
        stdio: 'inherit'
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        process.exitCode = result.status || 1;
        return;
      }
    }
  } finally {
    server.kill();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
