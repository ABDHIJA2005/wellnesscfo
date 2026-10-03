const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

function initDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);

  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  // Schema creation
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      motto TEXT,
      avatar_text TEXT DEFAULT 'A',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Phase 6: keep personal settings separate from financial records.
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      something_love TEXT,
      finance_motto TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
      date_format TEXT NOT NULL DEFAULT 'en-IN' CHECK (date_format IN ('en-IN', 'numeric')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_avatars (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
      image_data BLOB NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 524288),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'bank', 'cash', 'wallet', 'credit_card', 'investment'
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT DEFAULT 'INR',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS buckets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'spending', 'savings', 'emergency', 'investments', 'business', 'other'
      balance REAL NOT NULL DEFAULT 0,
      target_amount REAL DEFAULT 0,
      target_date TEXT,
      monthly_target REAL DEFAULT 0,
      is_essential INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'emergency', 'business', 'savings', 'investment', 'custom'
      target_amount REAL NOT NULL,
      target_date TEXT,
      monthly_target REAL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS category_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      is_essential INTEGER DEFAULT 0,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL,
      to_bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL,
      type TEXT NOT NULL, -- 'income', 'expense', 'transfer_account', 'transfer_bucket', 'refund', 'initial_balance'
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'Uncategorised',
      necessity TEXT DEFAULT 'Unclear',
      notes TEXT,
      source TEXT,
      is_recurring INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, -- 'Stocks', 'Mutual funds', 'Other'
      value REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL
    );

    -- Phase 4: Advanced Investments & SIP Tracking
    CREATE TABLE IF NOT EXISTS investments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'mutual_fund', 'stock', 'etf', 'gold', 'crypto', 'other'
      invested_amount REAL NOT NULL DEFAULT 0,
      current_value REAL NOT NULL DEFAULT 0,
      units REAL DEFAULT 0,
      sip_amount REAL DEFAULT 0,
      sip_day INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS investment_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      investment_id TEXT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'contribution', 'withdrawal', 'valuation_update', 'dividend'
      amount REAL NOT NULL,
      units REAL DEFAULT 0,
      date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    -- Phase 4: Lending & Borrowing (Receivables & Payables)
    CREATE TABLE IF NOT EXISTS lending_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- 'lent' (receivable), 'borrowed' (payable)
      person_name TEXT NOT NULL,
      person_contact TEXT,
      total_amount REAL NOT NULL,
      repaid_amount REAL NOT NULL DEFAULT 0,
      outstanding_amount REAL NOT NULL,
      date TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- 'active', 'repaid', 'written_off'
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lending_repayments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lending_id TEXT NOT NULL REFERENCES lending_records(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    -- Phase 4: Split Expenses
    CREATE TABLE IF NOT EXISTS split_expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      total_amount REAL NOT NULL,
      my_share REAL NOT NULL,
      payer TEXT NOT NULL DEFAULT 'me',
      date TEXT NOT NULL,
      category TEXT DEFAULT 'Food & Dining',
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'settled', 'partial'
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS split_participants (
      id TEXT PRIMARY KEY,
      split_id TEXT NOT NULL REFERENCES split_expenses(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      share_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      is_settled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Phase 4: Recurring Commitments
    CREATE TABLE IF NOT EXISTS recurring_commitments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'bill', 'subscription', 'sip', 'rent', 'recurring_transfer', 'recurring_income'
      amount REAL NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'monthly', -- 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
      next_date TEXT NOT NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_buckets_user ON buckets(user_id);
    CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
    CREATE INDEX IF NOT EXISTS idx_investments_user ON investments(user_id);
    CREATE INDEX IF NOT EXISTS idx_lending_user ON lending_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_splits_user ON split_expenses(user_id);
    CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring_commitments(user_id);
  `);

  // Safe column migration for existing databases
  const bucketCols = db.prepare('PRAGMA table_info(buckets)').all().map(c => c.name);
  if (!bucketCols.includes('target_date')) {
    db.exec('ALTER TABLE buckets ADD COLUMN target_date TEXT;');
  }
  if (!bucketCols.includes('monthly_target')) {
    db.exec('ALTER TABLE buckets ADD COLUMN monthly_target REAL DEFAULT 0;');
  }
  if (!bucketCols.includes('is_essential')) {
    db.exec('ALTER TABLE buckets ADD COLUMN is_essential INTEGER DEFAULT 0;');
  }

  const accountCols = db.prepare('PRAGMA table_info(accounts)').all().map(c => c.name);
  if (!accountCols.includes('starting_balance')) {
    db.exec('ALTER TABLE accounts ADD COLUMN starting_balance REAL DEFAULT 0;');
  }

  db.exec(`
    INSERT OR IGNORE INTO user_profiles (user_id, name, finance_motto)
      SELECT id, name, motto FROM users;
    INSERT OR IGNORE INTO user_preferences (user_id) SELECT id FROM users;
  `);

  return db;
}

module.exports = { initDatabase };
