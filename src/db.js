const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'subtrack.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Append new migrations to the end; never edit existing ones.
const migrations = [
  `CREATE TABLE subscriptions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     category TEXT NOT NULL DEFAULT 'Other',
     amount REAL NOT NULL DEFAULT 0,
     cycle TEXT NOT NULL DEFAULT 'monthly',
     interval_days INTEGER,
     next_due_date TEXT NOT NULL,
     payment_method TEXT DEFAULT '',
     auto_renew INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active',
     notes TEXT DEFAULT '',
     url TEXT DEFAULT '',
     last_notified_due TEXT,
     created_at TEXT DEFAULT (datetime('now')),
     updated_at TEXT DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_subs_due ON subscriptions(next_due_date);
   CREATE TABLE payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
     name TEXT NOT NULL,
     category TEXT DEFAULT '',
     date_paid TEXT NOT NULL,
     amount REAL NOT NULL,
     notes TEXT DEFAULT '',
     created_at TEXT DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_pay_date ON payments(date_paid);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`,
];

const current = db.pragma('user_version', { simple: true });
for (let i = current; i < migrations.length; i++) {
  db.transaction(() => { db.exec(migrations[i]); db.pragma(`user_version = ${i + 1}`); })();
}

if (process.env.SEED_DEMO === 'true' && !db.prepare('SELECT 1 FROM subscriptions LIMIT 1').get()) {
  const { addDays, today } = require('./lib');
  const ins = db.prepare(`INSERT INTO subscriptions (name,category,amount,cycle,next_due_date,payment_method,auto_renew,status)
    VALUES (?,?,?,?,?,?,?, 'active')`);
  const t = today();
  ins.run('Netflix', 'Streaming', 649, 'monthly', addDays(t, 4), 'Credit card', 1);
  ins.run('Domain renewal', 'Cloud & Hosting', 1100, 'yearly', addDays(t, 20), 'UPI', 0);
  ins.run('Home insurance', 'Insurance', 6000, 'quarterly', addDays(t, 12), 'Bank debit', 1);
}

module.exports = db;
