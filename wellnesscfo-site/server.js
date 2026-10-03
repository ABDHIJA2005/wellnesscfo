const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { initDatabase } = require('./server/db');
const { hashPassword, verifyPassword, createSession, getUserFromSession, deleteSession } = require('./server/auth');
const {
  setupDefaultEntities,
  recordTransaction,
  previewStatementImport,
  commitStatementImport,
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
} = require('./server/financial-engine');
const { parseNaturalLanguageTransaction } = require('./server/ai/deterministic-parser');
const { processAIQuery } = require('./server/ai/cfo-assistant');
const { parseCsvRecords } = require('./server/statement-import');
const { sanitizeForLogs } = require('./server/ai/privacy');
const {
  ensureUserProfile,
  getProfile,
  updateProfile,
  getPreferences,
  updatePreferences,
  saveAvatar,
  getAvatarDataUrl,
  deleteAvatar
} = require('./server/profile-store');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wellnesscfo.db');

const db = initDatabase(DB_PATH);

// Helper to parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) { // 10MB limit
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON responses
function sendJSON(res, statusCode, data, headers = {}) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    ...headers
  });
  res.end(json);
}

// Auth middleware helper
function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  let token = null;
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers.cookie) {
    const m = req.headers.cookie.match(/session=([a-f0-9]+)/);
    if (m) token = m[1];
  }
  if (!token) return null;
  return getUserFromSession(db, token);
}

// Static file MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  // --- API ROUTES ---
  if (pathname.startsWith('/api/')) {
    try {
      // 1. Auth: Sign up
      if (pathname === '/api/auth/signup' && method === 'POST') {
        const { email, password, name, motto } = await parseBody(req);
        if (!email || !password || !name) {
          return sendJSON(res, 400, { error: 'Email, password, and name are required' });
        }
        if (password.length < 6) {
          return sendJSON(res, 400, { error: 'Password must be at least 6 characters' });
        }

        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
          return sendJSON(res, 409, { error: 'An account with this email already exists' });
        }

        const userId = 'usr_' + crypto.randomBytes(8).toString('hex');
        const { hash, salt } = hashPassword(password);
        const now = new Date().toISOString();
        const avatar = (name.trim().charAt(0) || 'A').toUpperCase();

        db.prepare(`
          INSERT INTO users (id, email, password_hash, salt, name, motto, avatar_text, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, email.trim(), hash, salt, name.trim(), motto || null, avatar, now);

        ensureUserProfile(db, userId);

        setupDefaultEntities(db, userId);
        const session = createSession(db, userId);

        return sendJSON(res, 201, {
          user: { id: userId, email, name: name.trim(), motto, avatarText: avatar },
          token: session.token
        }, {
          'Set-Cookie': `session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
        });
      }

      // 2. Auth: Login
      if (pathname === '/api/auth/login' && method === 'POST') {
        const { email, password } = await parseBody(req);
        if (!email || !password) {
          return sendJSON(res, 400, { error: 'Email and password are required' });
        }

        const user = db.prepare(`
          SELECT id, email, password_hash, salt, name, motto, avatar_text
          FROM users WHERE email = ?
        `).get(email.trim());

        if (!user || !verifyPassword(password, user.password_hash, user.salt)) {
          return sendJSON(res, 401, { error: 'Invalid email or password' });
        }

        setupDefaultEntities(db, user.id);
        const session = createSession(db, user.id);

        return sendJSON(res, 200, {
          user: { id: user.id, email: user.email, name: user.name, motto: user.motto, avatarText: user.avatar_text },
          token: session.token
        }, {
          'Set-Cookie': `session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
        });
      }

      // 3. Auth: Current User
      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = authenticate(req);
        if (!user) {
          return sendJSON(res, 401, { error: 'Not authenticated' });
        }
        return sendJSON(res, 200, {
          user: { id: user.id, email: user.email, name: user.name, motto: user.motto, avatarText: user.avatar_text }
        });
      }

      // 4. Auth: Logout
      if (pathname === '/api/auth/logout' && method === 'POST') {
        const authHeader = req.headers['authorization'] || '';
        let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
        if (!token && req.headers.cookie) {
          const m = req.headers.cookie.match(/session=([a-f0-9]+)/);
          if (m) token = m[1];
        }
        if (token) deleteSession(db, token);
        return sendJSON(res, 200, { success: true }, {
          'Set-Cookie': 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        });
      }

      // Protected endpoints require valid authenticated user
      const user = authenticate(req);
      if (!user) {
        return sendJSON(res, 401, { error: 'Authentication required' });
      }

      // Phase 6: authenticated, user-scoped profile and preference APIs.
      if (pathname === '/api/profile' && method === 'GET') {
        return sendJSON(res, 200, { profile: getProfile(db, user.id) });
      }
      if (pathname === '/api/profile' && method === 'PUT') {
        const profile = await parseBody(req);
        return sendJSON(res, 200, { profile: updateProfile(db, user.id, profile) });
      }
      if (pathname === '/api/profile/preferences' && method === 'GET') {
        return sendJSON(res, 200, { preferences: getPreferences(db, user.id) });
      }
      if (pathname === '/api/profile/preferences' && method === 'PUT') {
        const preferences = await parseBody(req);
        return sendJSON(res, 200, { preferences: updatePreferences(db, user.id, preferences) });
      }
      if (pathname === '/api/profile/avatar' && method === 'GET') {
        return sendJSON(res, 200, { avatar: getAvatarDataUrl(db, user.id) }, { 'Cache-Control': 'no-store' });
      }
      if (pathname === '/api/profile/avatar' && method === 'PUT') {
        const { dataUrl } = await parseBody(req);
        return sendJSON(res, 200, saveAvatar(db, user.id, dataUrl), { 'Cache-Control': 'no-store' });
      }
      if (pathname === '/api/profile/avatar' && method === 'DELETE') {
        return sendJSON(res, 200, deleteAvatar(db, user.id));
      }

      // 5. Financial Summary
      if (pathname === '/api/summary' && method === 'GET') {
        const month = parsedUrl.searchParams.get('month') || new Date().toISOString().slice(0, 7);
        const summary = getFinancialSummary(db, user.id, month);
        return sendJSON(res, 200, summary);
      }

      // 6. Real Time-Series Charts
      if (pathname === '/api/charts' && method === 'GET') {
        const interval = parsedUrl.searchParams.get('interval') || 'monthly';
        const chartData = getChartData(db, user.id, interval);
        return sendJSON(res, 200, chartData);
      }

      // 7. Goals
      if (pathname === '/api/goals') {
        if (method === 'GET') {
          const goals = getGoals(db, user.id);
          return sendJSON(res, 200, { goals });
        }
        if (method === 'POST') {
          const { name, type, targetAmount, targetDate, monthlyTarget, bucketId } = await parseBody(req);
          if (!name || !targetAmount) {
            return sendJSON(res, 400, { error: 'Name and target amount required' });
          }
          const id = 'goal_' + crypto.randomBytes(8).toString('hex');
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO goals (id, user_id, bucket_id, name, type, target_amount, target_date, monthly_target, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, user.id, bucketId || null, name.trim(), type || 'custom', Number(targetAmount), targetDate || null, Number(monthlyTarget) || 0, now);
          return sendJSON(res, 201, { success: true, goalId: id });
        }
      }

      // 8. Emergency Fund Details
      if (pathname === '/api/emergency-fund' && method === 'GET') {
        const details = calculateEmergencyFund(db, user.id);
        return sendJSON(res, 200, details);
      }

      // 9. Business Fund Details
      if (pathname === '/api/business-fund' && method === 'GET') {
        const details = calculateBusinessFund(db, user.id);
        return sendJSON(res, 200, details);
      }

      // Phase 3 AI Endpoints
      // AI: Parse Natural Language Transaction
      if (pathname === '/api/ai/parse-transaction' && method === 'POST') {
        const body = await parseBody(req);
        const text = String(body.text || body.input || '').trim();
        if (!text) {
          return sendJSON(res, 400, { error: 'Text prompt is required' });
        }
        const accounts = db.prepare('SELECT id, name, type, balance FROM accounts WHERE user_id = ? AND is_active = 1').all(user.id);
        const buckets = db.prepare('SELECT id, name, type, balance FROM buckets WHERE user_id = ?').all(user.id);
        const parsed = parseNaturalLanguageTransaction(text, accounts, buckets);
        return sendJSON(res, 200, {
          success: true,
          ...parsed,
          parsed
        });
      }

      // AI: Query Command Center
      if (pathname === '/api/ai/query' && method === 'POST') {
        const body = await parseBody(req);
        const query = String(body.query || '').trim();
        if (!query) {
          return sendJSON(res, 400, { error: 'Query is required' });
        }
        const result = await processAIQuery(db, user.id, query);
        const responsePayload = {
          success: true,
          result,
          ...result
        };
        if (result.type === 'category_spending') {
          responsePayload.card = {
            title: `${result.category} Spending`,
            amount: result.total,
            count: result.count,
            transactions: result.transactions
          };
          responsePayload.text = result.message;
        } else if (result.type === 'money_leaks') {
          responsePayload.card = {
            title: result.title,
            items: result.data.leaks,
            detectedCount: result.data.detectedCount
          };
          responsePayload.text = result.message;
        } else if (result.intent === 'action_proposal') {
          responsePayload.requiresConfirmation = true;
          responsePayload.actionProposal = {
            action: result.actionType,
            amount: result.amount,
            fromBucket: result.fromBucketName,
            toBucket: result.toBucketName,
            fromBucketId: result.fromBucketId,
            toBucketId: result.toBucketId
          };
          responsePayload.text = result.message;
        } else if (result.type === 'affordability') {
          responsePayload.card = {
            type: 'affordability',
            verdict: result.verdict,
            amount: result.amount,
            itemName: result.itemName,
            availableSpending: result.availableCash,
            emergencyCoverage: result.emergencyCoverage,
            verdictTitle: result.verdictTitle
          };
          responsePayload.text = result.verdictTitle;
        } else if (result.type === 'opportunity_cost') {
          responsePayload.card = {
            type: 'opportunity_cost',
            principal: result.data.principal,
            table: result.data.projections.map(p => ({
              years: p.years,
              conservative: p.scenarios[0].lumpSumFV,
              moderate: p.scenarios[1].lumpSumFV,
              growth: p.scenarios[2].lumpSumFV
            })),
            disclaimer: result.data.disclaimer
          };
          responsePayload.text = result.message;
        }
        return sendJSON(res, 200, responsePayload);
      }

      // AI: Execute Confirmed Action
      if (pathname === '/api/ai/execute-action' && method === 'POST') {
        const body = await parseBody(req);
        const proposal = body.actionProposal || body;
        const actionType = proposal.action || proposal.actionType || 'transfer_bucket';
        const amount = Number(proposal.amount);
        let fromBucketId = proposal.fromBucketId;
        let toBucketId = proposal.toBucketId;

        if (actionType === 'transfer_bucket') {
          if (!fromBucketId && proposal.fromBucket) {
            const b = db.prepare('SELECT id FROM buckets WHERE user_id = ? AND LOWER(name) LIKE ?').get(user.id, `%${proposal.fromBucket.toLowerCase()}%`);
            if (b) fromBucketId = b.id;
          }
          if (!toBucketId && proposal.toBucket) {
            const b = db.prepare('SELECT id FROM buckets WHERE user_id = ? AND LOWER(name) LIKE ?').get(user.id, `%${proposal.toBucket.toLowerCase()}%`);
            if (b) toBucketId = b.id;
          }

          if (!fromBucketId || !toBucketId || !amount || amount <= 0) {
            return sendJSON(res, 400, { error: 'Valid fromBucket, toBucket, and positive amount required' });
          }

          const transfer = recordBucketTransfer(db, user.id, {
            fromBucketId,
            toBucketId,
            amount,
            description: proposal.description || proposal.note || 'AI Command Center transfer'
          });

          return sendJSON(res, 200, {
            success: true,
            message: `Successfully transferred ₹${amount.toLocaleString('en-IN')} between buckets.`,
            transfer
          });
        } else if (actionType === 'transfer_account') {
          const fromAccId = proposal.fromAccountId;
          const toAccId = proposal.toAccountId;
          if (!fromAccId || !toAccId || !amount || amount <= 0) {
            return sendJSON(res, 400, { error: 'Valid fromAccountId, toAccountId, and positive amount required' });
          }
          const transfer = recordAccountTransfer(db, user.id, {
            from_account_id: fromAccId,
            to_account_id: toAccId,
            amount,
            note: proposal.description || 'AI account transfer'
          });
          return sendJSON(res, 200, { success: true, transfer });
        } else if (actionType === 'record_lending') {
          const rec = recordLending(db, user.id, {
            type: 'lent',
            personName: proposal.personName || proposal.person || 'Friend',
            totalAmount: amount,
            date: proposal.date,
            dueDate: proposal.dueDate,
            notes: proposal.description || 'Lent via AI Command'
          });
          return sendJSON(res, 200, { success: true, message: `Recorded ₹${amount.toLocaleString('en-IN')} lent to ${rec.personName}.`, record: rec });
        } else if (actionType === 'record_borrowing') {
          const rec = recordLending(db, user.id, {
            type: 'borrowed',
            personName: proposal.personName || proposal.person || 'Lender',
            totalAmount: amount,
            date: proposal.date,
            dueDate: proposal.dueDate,
            notes: proposal.description || 'Borrowed via AI Command'
          });
          return sendJSON(res, 200, { success: true, message: `Recorded ₹${amount.toLocaleString('en-IN')} borrowed from ${rec.personName}.`, record: rec });
        }
        return sendJSON(res, 400, { error: `Unsupported action type: ${actionType}` });
      }

      // 10. Single Transaction Update / Delete
      const txMatch = pathname.match(/^\/api\/transactions\/([a-zA-Z0-9_-]+)$/);
      if (txMatch) {
        const txId = txMatch[1];
        if (method === 'PUT') {
          const updates = await parseBody(req);
          const updated = updateTransaction(db, user.id, txId, updates);
          return sendJSON(res, 200, { success: true, transaction: updated });
        }
        if (method === 'DELETE') {
          const resDel = deleteTransaction(db, user.id, txId);
          return sendJSON(res, 200, resDel);
        }
      }

      // 11. Transactions GET & POST
      if (pathname === '/api/transactions') {
        if (method === 'GET') {
          const type = parsedUrl.searchParams.get('type');
          const month = parsedUrl.searchParams.get('month');
          const category = parsedUrl.searchParams.get('category');
          let query = 'SELECT * FROM transactions WHERE user_id = ?';
          const params = [user.id];

          if (month) {
            query += ' AND date LIKE ?';
            params.push(month + '%');
          }
          if (type && type !== 'all') {
            if (type === 'income') {
              query += " AND (type = 'income' OR type = 'refund')";
            } else if (type === 'expense') {
              query += " AND type = 'expense'";
            } else if (type === 'transfers') {
              query += " AND (type = 'transfer_account' OR type = 'transfer_bucket')";
            } else if (type === 'investments') {
              query += " AND (category LIKE '%invest%' OR category LIKE '%sip%' OR type = 'transfer_bucket')";
            }
          }
          if (category && category !== 'all') {
            query += ' AND category = ?';
            params.push(category);
          }
          query += ' ORDER BY date DESC, created_at DESC LIMIT 150';

          const rows = db.prepare(query).all(...params);
          return sendJSON(res, 200, { transactions: rows });
        }

        if (method === 'POST') {
          const body = await parseBody(req);
          if (Array.isArray(body.transactions)) {
            const added = [];
            for (const t of body.transactions) {
              const resTx = recordTransaction(db, user.id, t);
              added.push(resTx);
            }
            return sendJSON(res, 201, { success: true, count: added.length, transactions: added });
          } else {
            const resTx = recordTransaction(db, user.id, body);
            return sendJSON(res, 201, { success: true, transaction: resTx });
          }
        }
      }

      if (pathname === '/api/import/preview' && method === 'POST') {
        const body = await parseBody(req);
        const rows = typeof body.csv === 'string' ? parseCsvRecords(body.csv) : Array.isArray(body.rows) ? body.rows : [];
        if (!rows.length) return sendJSON(res, 400, { error: 'No transaction rows were found in the statement.' });
        const preview = previewStatementImport(db, user.id, rows, {
          accountId: body.accountId || body.account_id || null,
          bucketId: body.bucketId || body.bucket_id || null
        });
        return sendJSON(res, 200, { success: true, ...preview });
      }

      if (pathname === '/api/import/commit' && method === 'POST') {
        const body = await parseBody(req);
        if (!Array.isArray(body.rows) || body.rows.length === 0) {
          return sendJSON(res, 400, { error: 'Rows to import are required' });
        }
        const commit = commitStatementImport(db, user.id, body.rows, {
          accountId: body.accountId || body.account_id || null,
          bucketId: body.bucketId || body.bucket_id || null
        });
        return sendJSON(res, 200, { success: true, ...commit });
      }

      // 12. Transfers
      if (pathname === '/api/transfers/account' && method === 'POST') {
        const body = await parseBody(req);
        const transfer = recordAccountTransfer(db, user.id, body);
        return sendJSON(res, 201, { success: true, transfer });
      }

      if (pathname === '/api/transfers/bucket' && method === 'POST') {
        const body = await parseBody(req);
        const transfer = recordBucketTransfer(db, user.id, body);
        return sendJSON(res, 201, { success: true, transfer });
      }

      // 13. Accounts: GET, POST, PUT, DELETE
      const accMatch = pathname.match(/^\/api\/accounts\/([a-zA-Z0-9_-]+)$/);
      if (accMatch) {
        const accId = accMatch[1];
        if (method === 'PUT') {
          const { name, type, balance } = await parseBody(req);
          db.prepare(`
            UPDATE accounts
            SET name = COALESCE(?, name), type = COALESCE(?, type), balance = COALESCE(?, balance)
            WHERE id = ? AND user_id = ?
          `).run(name ? name.trim() : null, type || null, balance !== undefined ? Number(balance) : null, accId, user.id);
          return sendJSON(res, 200, { success: true });
        }
        if (method === 'DELETE') {
          db.prepare(`UPDATE accounts SET is_active = 0 WHERE id = ? AND user_id = ?`).run(accId, user.id);
          return sendJSON(res, 200, { success: true });
        }
      }

      if (pathname === '/api/accounts') {
        if (method === 'GET') {
          const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC').all(user.id);
          return sendJSON(res, 200, { accounts });
        }
        if (method === 'POST') {
          const { name, type, startingBalance } = await parseBody(req);
          if (!name || !type) return sendJSON(res, 400, { error: 'Name and type are required' });
          const id = 'acc_' + crypto.randomBytes(8).toString('hex');
          const now = new Date().toISOString();
          const startBal = Number(startingBalance) || 0;

          db.prepare(`
            INSERT INTO accounts (id, user_id, name, type, balance, starting_balance, currency, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'INR', 1, ?)
          `).run(id, user.id, name.trim(), type, startBal, startBal, now);

          return sendJSON(res, 201, { success: true, account: { id, name, type, balance: startBal } });
        }
      }

      // 14. Buckets: GET, POST, PUT
      const bktMatch = pathname.match(/^\/api\/buckets\/([a-zA-Z0-9_-]+)$/);
      if (bktMatch) {
        const bktId = bktMatch[1];
        if (method === 'PUT') {
          const { name, targetAmount, targetDate, monthlyTarget } = await parseBody(req);
          db.prepare(`
            UPDATE buckets
            SET name = COALESCE(?, name), target_amount = COALESCE(?, target_amount),
                target_date = COALESCE(?, target_date), monthly_target = COALESCE(?, monthly_target)
            WHERE id = ? AND user_id = ?
          `).run(name ? name.trim() : null, targetAmount !== undefined ? Number(targetAmount) : null, targetDate || null, monthlyTarget !== undefined ? Number(monthlyTarget) : null, bktId, user.id);

          // Update linked goal target if exists
          if (targetAmount !== undefined) {
            db.prepare('UPDATE goals SET target_amount = ? WHERE bucket_id = ? AND user_id = ?').run(Number(targetAmount), bktId, user.id);
          }
          return sendJSON(res, 200, { success: true });
        }
      }

      if (pathname === '/api/buckets') {
        if (method === 'GET') {
          const buckets = db.prepare('SELECT * FROM buckets WHERE user_id = ? ORDER BY created_at ASC').all(user.id);
          return sendJSON(res, 200, { buckets });
        }
        if (method === 'POST') {
          const { name, type, targetAmount } = await parseBody(req);
          if (!name || !type) return sendJSON(res, 400, { error: 'Name and type are required' });
          const id = 'bkt_' + crypto.randomBytes(8).toString('hex');
          const now = new Date().toISOString();
          db.prepare(`
            INSERT INTO buckets (id, user_id, name, type, balance, target_amount, created_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
          `).run(id, user.id, name.trim(), type, Number(targetAmount) || 0, now);

          // Also create goal for this bucket
          const goalId = 'goal_' + crypto.randomBytes(8).toString('hex');
          db.prepare(`
            INSERT INTO goals (id, user_id, bucket_id, name, type, target_amount, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(goalId, user.id, id, name.trim(), type, Number(targetAmount) || 0, now);

          return sendJSON(res, 201, { success: true, bucket: { id, name, type, balance: 0 } });
        }
      }

      // 15. Portfolio Snapshots
      if (pathname === '/api/portfolio') {
        if (method === 'GET') {
          const snapshots = db.prepare('SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY as_of DESC').all(user.id);
          return sendJSON(res, 200, { snapshots });
        }
        if (method === 'POST') {
          const { kind, value, asOf, source } = await parseBody(req);
          if (!kind || !value || Number(value) <= 0) {
            return sendJSON(res, 400, { error: 'Valid portfolio kind and positive value required' });
          }
          const id = 'pf_' + crypto.randomBytes(8).toString('hex');
          const now = new Date().toISOString();
          const date = asOf || now.slice(0, 10);
          db.prepare(`
            INSERT INTO portfolio_snapshots (id, user_id, kind, value, as_of, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, user.id, kind, Number(value), date, source || 'manual_entry', now);
          return sendJSON(res, 201, { success: true, snapshot: { id, kind, value: Number(value), asOf: date } });
        }
      }

      // 16. Legacy Data Migration
      if (pathname === '/api/migrate' && method === 'POST') {
        const legacyData = await parseBody(req);
        const result = migrateLegacyData(db, user.id, legacyData);
        return sendJSON(res, 200, { success: true, ...result });
      }

      // --- PHASE 4 ADVANCED FINANCE ROUTES ---
      // 20. Advanced Investments & Holdings
      const invMatch = pathname.match(/^\/api\/investments\/([a-zA-Z0-9_-]+)$/);
      if (invMatch) {
        const invId = invMatch[1];
        if (method === 'PUT') {
          const body = await parseBody(req);
          const resUp = updateInvestment(db, user.id, invId, body);
          return sendJSON(res, 200, resUp);
        }
        if (method === 'DELETE') {
          const resDel = deleteInvestment(db, user.id, invId);
          return sendJSON(res, 200, resDel);
        }
      }

      if (pathname === '/api/investments') {
        if (method === 'GET') {
          const data = getInvestments(db, user.id);
          return sendJSON(res, 200, data);
        }
        if (method === 'POST') {
          const body = await parseBody(req);
          const inv = recordInvestment(db, user.id, body);
          return sendJSON(res, 201, { success: true, investment: inv });
        }
      }

      if (pathname === '/api/investments/transactions' && method === 'POST') {
        const body = await parseBody(req);
        const resTx = recordInvestmentTransaction(db, user.id, body);
        return sendJSON(res, 201, resTx);
      }

      // 21. Lending & Borrowing
      if (pathname === '/api/lending') {
        if (method === 'GET') {
          const status = parsedUrl.searchParams.get('status') || 'all';
          const data = getLendingRecords(db, user.id, status);
          return sendJSON(res, 200, data);
        }
        if (method === 'POST') {
          const body = await parseBody(req);
          const rec = recordLending(db, user.id, body);
          return sendJSON(res, 201, { success: true, record: rec });
        }
      }

      if (pathname === '/api/lending/repayments' && method === 'POST') {
        const body = await parseBody(req);
        const resRep = recordLendingRepayment(db, user.id, body);
        return sendJSON(res, 201, resRep);
      }

      // 22. Split Expenses
      if (pathname === '/api/splits') {
        if (method === 'GET') {
          const splits = getSplitExpenses(db, user.id);
          return sendJSON(res, 200, { splits });
        }
        if (method === 'POST') {
          const body = await parseBody(req);
          const split = recordSplitExpense(db, user.id, body);
          return sendJSON(res, 201, { success: true, split });
        }
      }

      if (pathname === '/api/splits/settle' && method === 'POST') {
        const body = await parseBody(req);
        const resSettle = settleSplitParticipant(db, user.id, body.participantId, body);
        return sendJSON(res, 200, resSettle);
      }

      // 23. Recurring Commitments
      const recMatch = pathname.match(/^\/api\/recurring\/([a-zA-Z0-9_-]+)$/);
      if (recMatch) {
        const recId = recMatch[1];
        if (method === 'PUT') {
          const body = await parseBody(req);
          const resUp = updateRecurringCommitment(db, user.id, recId, body);
          return sendJSON(res, 200, resUp);
        }
        if (method === 'DELETE') {
          const resDel = deleteRecurringCommitment(db, user.id, recId);
          return sendJSON(res, 200, resDel);
        }
      }

      if (pathname === '/api/recurring') {
        if (method === 'GET') {
          const commitments = getRecurringCommitments(db, user.id);
          return sendJSON(res, 200, { commitments });
        }
        if (method === 'POST') {
          const body = await parseBody(req);
          const rec = recordRecurringCommitment(db, user.id, body);
          return sendJSON(res, 201, { success: true, commitment: rec });
        }
      }

      // 24. Financial Calendar
      if (pathname === '/api/calendar' && method === 'GET') {
        const start = parsedUrl.searchParams.get('start');
        const end = parsedUrl.searchParams.get('end');
        const calendar = getFinancialCalendar(db, user.id, start, end);
        return sendJSON(res, 200, calendar);
      }

      if (pathname === '/api/calendar/post-occurrence' && method === 'POST') {
        const body = await parseBody(req);
        const resPost = postRecurringToLedger(db, user.id, body.recurringId, body.date);
        return sendJSON(res, 200, resPost);
      }

      return sendJSON(res, 404, { error: 'API route not found' });
    } catch (err) {
      const safeMessage = err && err.message ? String(err.message).replace(/\s+/g, ' ').slice(0, 200) : 'Internal server error';
      console.error('API Error:', sanitizeForLogs(safeMessage));
      return sendJSON(res, err && err.statusCode === 400 ? 400 : 500, { error: safeMessage || 'Internal server error' });
    }
  }

  // --- STATIC FILE SERVING ---
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(__dirname, 'index.html');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        return res.end('Error loading file');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
});

server.listen(PORT, () => {
  console.log(`WellnessCFO Server running at http://localhost:${PORT}`);
});
