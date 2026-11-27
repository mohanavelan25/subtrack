const db = require('./db');
const { today, addDays } = require('./lib');
const CURRENCY = process.env.CURRENCY || 'INR';

function getSettings() {
  const r = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((x) => [x.key, x.value]));
  return {
    webhook_url: r.webhook_url ?? process.env.WEBHOOK_URL ?? '',
    webhook_type: r.webhook_type || process.env.WEBHOOK_TYPE || 'generic',
    webhook_days: Number(r.webhook_days ?? process.env.WEBHOOK_DAYS ?? 3),
  };
}

async function send(type, url, title, text) {
  let headers = { 'Content-Type': 'application/json' }, body;
  if (type === 'discord') body = JSON.stringify({ content: `**${title}**\n${text}` });
  else if (type === 'slack') body = JSON.stringify({ text: `*${title}*\n${text}` });
  else if (type === 'gotify') body = JSON.stringify({ title, message: text, priority: 5 });
  else if (type === 'ntfy') { headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: title }; body = text; }
  else body = JSON.stringify({ title, message: text });
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
}

async function sendTest() {
  const s = getSettings();
  if (!s.webhook_url) throw new Error('Add a webhook URL first');
  await send(s.webhook_type, s.webhook_url, 'SubTrack test', 'Notifications are working.');
}

// Sends one message per due date; each subscription is notified once per cycle.
async function checkAndNotify() {
  const s = getSettings();
  if (!s.webhook_url || !(s.webhook_days >= 0)) return 0;
  const limit = addDays(today(), s.webhook_days);
  const rows = db.prepare(`SELECT * FROM subscriptions WHERE status='active' AND next_due_date <= ?
    AND (last_notified_due IS NULL OR last_notified_due <> next_due_date) ORDER BY next_due_date`).all(limit);
  if (!rows.length) return 0;
  const t = today();
  const lines = rows.map((r) => {
    const n = Math.round((Date.parse(r.next_due_date) - Date.parse(t)) / 864e5);
    const when = n < 0 ? `${-n}d overdue` : n === 0 ? 'today' : `in ${n}d`;
    return `- ${r.name}: ${r.amount} ${CURRENCY}, due ${r.next_due_date} (${when})`;
  });
  await send(s.webhook_type, s.webhook_url, `${rows.length} bill(s) due soon`, lines.join('\n'));
  const mark = db.prepare('UPDATE subscriptions SET last_notified_due = next_due_date WHERE id = ?');
  db.transaction(() => rows.forEach((r) => mark.run(r.id)))();
  return rows.length;
}

function start() {
  const run = () => checkAndNotify().catch((e) => console.error('[notify]', e.message));
  setTimeout(run, 30000);
  setInterval(run, 60 * 60 * 1000).unref();
}

module.exports = { getSettings, sendTest, checkAndNotify, start };
