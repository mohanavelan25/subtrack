const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const notify = require('./notify');
const { CYCLES, today, addDays, addCycle, monthlyEquivalent, toCSV, parseCSV } = require('./lib');

const PORT = Number(process.env.PORT || 3000);
const CURRENCY = process.env.CURRENCY || 'INR';
const CATEGORIES = ['Streaming', 'Cloud & Hosting', 'Utilities', 'Software/AI', 'Insurance', 'Membership', 'Other'];
const FIELDS = ['name', 'category', 'amount', 'cycle', 'interval_days', 'next_due_date', 'payment_method', 'auto_renew', 'status', 'notes', 'url'];
const STATUSES = ['active', 'paused', 'cancelled'];

const httpErr = (m, status = 400) => Object.assign(new Error(m), { status });
const w = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const enrich = (s) => { const m = monthlyEquivalent(s); return { ...s, monthly_equivalent: m, annual_total: m * 12 }; };
const getSub = (id) => { const s = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id); if (!s) throw httpErr('Not found', 404); return s; };

function clean(b) {
  const o = {};
  o.name = String(b.name || '').trim();
  if (!o.name) throw httpErr('Name is required');
  o.category = String(b.category || '').trim() || 'Other';
  o.amount = Number(b.amount);
  if (!Number.isFinite(o.amount) || o.amount < 0) throw httpErr('Amount must be a positive number');
  o.cycle = b.cycle || 'monthly';
  if (!CYCLES.includes(o.cycle)) throw httpErr('Invalid billing cycle');
  o.interval_days = null;
  if (o.cycle === 'custom') {
    o.interval_days = parseInt(b.interval_days, 10);
    if (!(o.interval_days > 0)) throw httpErr('Custom cycle needs an interval in days');
  }
  o.next_due_date = String(b.next_due_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.next_due_date)) throw httpErr('Next due date must be YYYY-MM-DD');
  o.payment_method = String(b.payment_method || '').trim();
  o.auto_renew = [true, 1, '1', 'true', 'yes', 'TRUE'].includes(b.auto_renew) ? 1 : 0;
  o.status = b.status || 'active';
  if (!STATUSES.includes(o.status)) throw httpErr('Invalid status');
  o.notes = String(b.notes || '');
  o.url = String(b.url || '').trim();
  if (o.url && !/^https?:\/\//i.test(o.url)) throw httpErr('URL must start with http:// or https://');
  return o;
}

const insertSub = db.prepare(`INSERT INTO subscriptions (${FIELDS.join(',')}) VALUES (${FIELDS.map((f) => '@' + f).join(',')})`);
const insertPay = db.prepare('INSERT INTO payments (subscription_id,name,category,date_paid,amount,notes) VALUES (?,?,?,?,?,?)');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });

// Optional basic auth. Leave AUTH_USER/AUTH_PASS empty when auth is handled upstream (Authelia, Tailscale, etc.).
if (process.env.AUTH_USER && process.env.AUTH_PASS) {
  const h = (s) => crypto.createHash('sha256').update(s).digest();
  const want = [h(process.env.AUTH_USER), h(process.env.AUTH_PASS)];
  app.use((req, res, next) => {
    const [u, p] = Buffer.from((req.headers.authorization || '').slice(6), 'base64').toString().split(/:(.*)/s);
    if (u !== undefined && crypto.timingSafeEqual(h(u), want[0]) && crypto.timingSafeEqual(h(p || ''), want[1])) return next();
    res.set('WWW-Authenticate', 'Basic realm="SubTrack"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/config', (req, res) => res.json({ currency: CURRENCY, categories: CATEGORIES, cycles: CYCLES }));

// ---- Subscriptions
app.get('/api/subscriptions', (req, res) =>
  res.json(db.prepare('SELECT * FROM subscriptions ORDER BY next_due_date, name').all().map(enrich)));

app.post('/api/subscriptions', w((req, res) => {
  const id = insertSub.run(clean(req.body)).lastInsertRowid;
  res.status(201).json(enrich(getSub(id)));
}));

app.put('/api/subscriptions/:id', w((req, res) => {
  getSub(req.params.id);
  const o = { ...clean(req.body), id: req.params.id };
  db.prepare(`UPDATE subscriptions SET ${FIELDS.map((f) => `${f}=@${f}`).join(',')},
    last_notified_due = CASE WHEN next_due_date <> @next_due_date THEN NULL ELSE last_notified_due END,
    updated_at = datetime('now') WHERE id=@id`).run(o);
  res.json(enrich(getSub(req.params.id)));
}));

app.delete('/api/subscriptions/:id', w((req, res) => {
  getSub(req.params.id);
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(req.params.id);
  res.status(204).end();
}));

app.post('/api/subscriptions/:id/toggle', w((req, res) => {
  const s = getSub(req.params.id);
  const next = s.status === 'active' ? 'paused' : 'active';
  db.prepare("UPDATE subscriptions SET status=?, updated_at=datetime('now') WHERE id=?").run(next, s.id);
  res.json(enrich(getSub(s.id)));
}));

app.post('/api/subscriptions/:id/duplicate', w((req, res) => {
  const s = getSub(req.params.id);
  const o = Object.fromEntries(FIELDS.map((f) => [f, s[f]]));
  o.name = `${s.name} (copy)`;
  res.status(201).json(enrich(getSub(insertSub.run(o).lastInsertRowid)));
}));

// Mark as paid: log the payment and move the due date forward one cycle.
app.post('/api/subscriptions/:id/pay', w((req, res) => {
  const s = getSub(req.params.id), b = req.body || {};
  const amount = b.amount === undefined || b.amount === '' ? s.amount : Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) throw httpErr('Amount must be a positive number');
  const date = b.date_paid || today();
  db.transaction(() => {
    insertPay.run(s.id, s.name, s.category, date, amount, b.notes || '');
    db.prepare("UPDATE subscriptions SET next_due_date=?, last_notified_due=NULL, updated_at=datetime('now') WHERE id=?")
      .run(addCycle(s.next_due_date, s.cycle, s.interval_days), s.id);
  })();
  res.json(enrich(getSub(s.id)));
}));

// ---- Payments
app.get('/api/payments', (req, res) =>
  res.json(db.prepare('SELECT * FROM payments ORDER BY date_paid DESC, id DESC LIMIT ?').all(Math.min(Number(req.query.limit) || 500, 5000))));

app.post('/api/payments', w((req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) throw httpErr('Amount must be a positive number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date_paid || '')) throw httpErr('Date must be YYYY-MM-DD');
  const s = b.subscription_id ? getSub(b.subscription_id) : null;
  const name = s ? s.name : String(b.name || '').trim();
  if (!name) throw httpErr('Pick a subscription or enter a name');
  const id = insertPay.run(s ? s.id : null, name, s ? s.category : b.category || '', b.date_paid, amount, b.notes || '').lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM payments WHERE id=?').get(id));
}));

app.delete('/api/payments/:id', (req, res) => {
  db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
  res.status(204).end();
});

// ---- Summary
app.get('/api/summary', (req, res) => {
  const active = db.prepare("SELECT * FROM subscriptions WHERE status='active' ORDER BY next_due_date, name").all().map(enrich);
  const t = today();
  const dueWithin = (n) => {
    const lim = addDays(t, n), list = active.filter((s) => s.next_due_date <= lim);
    return { count: list.length, amount: list.reduce((a, s) => a + s.amount, 0) };
  };
  const cats = {};
  for (const s of active) {
    const c = (cats[s.category] ||= { category: s.category, monthly: 0, count: 0 });
    c.monthly += s.monthly_equivalent; c.count++;
  }
  const monthly = active.reduce((a, s) => a + s.monthly_equivalent, 0);
  const history = db.prepare('SELECT substr(date_paid,1,7) month, SUM(amount) total FROM payments GROUP BY month ORDER BY month DESC LIMIT 12').all().reverse();
  res.json({
    monthly, annual: monthly * 12, active: active.length,
    due7: dueWithin(7), due30: dueWithin(30),
    categories: Object.values(cats).sort((a, b) => b.monthly - a.monthly),
    upcoming: active.slice(0, 10), history,
  });
});

// ---- Settings & notifications
app.get('/api/settings', (req, res) => res.json(notify.getSettings()));
app.put('/api/settings', w((req, res) => {
  const b = req.body || {}, up = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const url = String(b.webhook_url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw httpErr('Webhook URL must start with http:// or https://');
  db.transaction(() => {
    up.run('webhook_url', url);
    up.run('webhook_type', ['discord', 'slack', 'ntfy', 'gotify', 'generic'].includes(b.webhook_type) ? b.webhook_type : 'generic');
    up.run('webhook_days', String(Math.max(0, parseInt(b.webhook_days, 10) || 0)));
  })();
  res.json(notify.getSettings());
}));
app.post('/api/notify/test', w(async (req, res) => { await notify.sendTest(); res.json({ ok: true }); }));
app.post('/api/notify/run', w(async (req, res) => res.json({ sent: await notify.checkAndNotify() })));

// ---- Export / import
const SUB_COLS = ['id', ...FIELDS];
const PAY_COLS = ['id', 'subscription_id', 'name', 'category', 'date_paid', 'amount', 'notes'];
app.get('/api/export.json', (req, res) => {
  res.set('Content-Disposition', `attachment; filename="subtrack-${today()}.json"`);
  res.json({
    version: 1, exported_at: new Date().toISOString(),
    subscriptions: db.prepare('SELECT * FROM subscriptions ORDER BY id').all(),
    payments: db.prepare('SELECT * FROM payments ORDER BY id').all(),
  });
});
app.get('/api/export.csv', (req, res) => {
  const pay = req.query.type === 'payments';
  const rows = db.prepare(`SELECT * FROM ${pay ? 'payments' : 'subscriptions'} ORDER BY id`).all();
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="subtrack-${pay ? 'payments' : 'subscriptions'}-${today()}.csv"` });
  res.send(toCSV(rows, pay ? PAY_COLS : SUB_COLS));
});

// JSON: { subscriptions, payments }. CSV: subscriptions only. mode=replace wipes existing data first.
app.post('/api/import', w((req, res) => {
  const data = req.is('json') ? req.body : { subscriptions: parseCSV(String(req.body || '')) };
  if (!Array.isArray(data.subscriptions)) throw httpErr('No subscriptions found in file');
  const map = {};
  let subs = 0, pays = 0;
  db.transaction(() => {
    if (req.query.mode === 'replace') { db.exec('DELETE FROM payments; DELETE FROM subscriptions;'); }
    data.subscriptions.forEach((x, i) => {
      try { map[x.id] = insertSub.run(clean(x)).lastInsertRowid; subs++; }
      catch (e) { throw httpErr(`Subscription row ${i + 1}: ${e.message}`); }
    });
    for (const p of data.payments || []) {
      if (!p.name || !p.date_paid || !Number.isFinite(Number(p.amount))) continue;
      insertPay.run(map[p.subscription_id] ?? null, p.name, p.category || '', p.date_paid, Number(p.amount), p.notes || '');
      pays++;
    }
  })();
  res.json({ subscriptions: subs, payments: pays });
}));

app.use((err, req, res, next) => {
  if (err.status !== 400 && err.status !== 404) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on the server' });
});

app.listen(PORT, '0.0.0.0', () => { console.log(`SubTrack listening on :${PORT}`); notify.start(); });
