const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { cfg: { currency: 'INR', categories: [], cycles: [] }, subs: [], sum: null, pay: [], set: {}, view: 'dashboard', f: { q: '', cat: '', status: 'active', sort: 'next_due_date' } };
const today = () => new Date().toLocaleDateString('en-CA');
const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: S.cfg.currency, maximumFractionDigits: 2 }).format(n || 0);
const daysTo = (d) => Math.round((Date.parse(d) - Date.parse(today())) / 864e5);
const CY = { monthly: 'month', quarterly: 'quarter', 'semi-annual': '6 months', yearly: 'year' };
const cycleLabel = (x) => (x.cycle === 'custom' ? `every ${x.interval_days} days` : `per ${CY[x.cycle]}`);
const dueLabel = (d) => { const n = daysTo(d); return n < 0 ? `${-n}d overdue` : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `in ${n}d`; };
const dueCls = (d) => { const n = daysTo(d); return n < 0 ? 'over' : n <= 7 ? 'soon' : 'ok'; };

async function api(url, method = 'GET', body, ct) {
  const o = { method, headers: {} };
  if (body !== undefined) { o.headers['Content-Type'] = ct || 'application/json'; o.body = ct ? body : JSON.stringify(body); }
  const r = await fetch(url, o);
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  return r.status === 204 ? null : r.json();
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

async function load() {
  const [subs, sum, pay, set] = await Promise.all([api('/api/subscriptions'), api('/api/summary'), api('/api/payments'), api('/api/settings')]);
  Object.assign(S, { subs, sum, pay, set });
  render();
}

function render() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view));
  $('#view').innerHTML = { dashboard: vDash, subs: vSubs, history: vHistory, settings: vSettings }[S.view]();
  if (S.view === 'subs') renderTable();
}

function vDash() {
  const s = S.sum;
  const stat = (l, v, sub = '') => `<div class="stat"><div class="lbl">${l}</div><div class="val">${v}</div><div class="sub">${sub}</div></div>`;
  const maxC = Math.max(...s.categories.map((c) => c.monthly), 1);
  const maxH = Math.max(...s.history.map((h) => h.total), 1);
  return `<div class="stats">
    ${stat('Monthly spend', money(s.monthly), 'normalized')}
    ${stat('Annual spend', money(s.annual), 'normalized')}
    ${stat('Due in 7 days', s.due7.count, money(s.due7.amount))}
    ${stat('Due in 30 days', s.due30.count, money(s.due30.amount))}
    ${stat('Active', s.active, 'subscriptions and bills')}
  </div>
  <div class="grid"><div>
    <div class="panel"><h3>Upcoming renewals</h3>
    ${s.upcoming.length ? s.upcoming.map((x) => `<div class="up"><div class="days ${dueCls(x.next_due_date)}">${dueLabel(x.next_due_date)}</div>
      <div><b>${esc(x.name)}</b><div class="muted">${x.next_due_date} · ${esc(x.category)}</div></div><div>${money(x.amount)}</div>
      <button class="sm" data-act="pay" data-id="${x.id}">Mark paid</button></div>`).join('') : '<div class="empty">Nothing due yet. Add your first subscription.</div>'}
    </div></div>
    <div><div class="panel"><h3>Monthly spend by category</h3>
    ${s.categories.map((c) => `<div class="bar"><span>${esc(c.category)}</span><div class="t"><i style="width:${(c.monthly / maxC) * 100}%"></i></div><span class="r">${money(c.monthly)}</span></div>`).join('') || '<div class="muted">No active items.</div>'}
    </div>
    <div class="panel"><h3>Payments per month</h3>
    ${s.history.length ? `<div class="hist">${s.history.map((h) => `<div style="height:${(h.total / maxH) * 100}%" title="${h.month}: ${money(h.total)}"></div>`).join('')}</div>
    <div class="hist-l">${s.history.map((h) => `<span>${h.month.slice(2)}</span>`).join('')}</div>` : '<div class="muted">Payments you log will show up here.</div>'}
    </div></div></div>`;
}

function vSubs() {
  const cats = [...new Set(S.subs.map((x) => x.category))].sort();
  return `<div class="toolbar">
    <input id="fq" type="search" placeholder="Search name, notes or payment method" value="${esc(S.f.q)}">
    <select id="fc"><option value="">All categories</option>${cats.map((c) => `<option ${c === S.f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="fs">${['active', 'paused', 'cancelled', ''].map((v) => `<option value="${v}" ${v === S.f.status ? 'selected' : ''}>${v || 'All statuses'}</option>`).join('')}</select>
    <select id="fo">${[['next_due_date', 'Sort by due date'], ['name', 'Sort by name'], ['monthly_equivalent', 'Sort by monthly cost']].map(([v, l]) => `<option value="${v}" ${v === S.f.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="primary" data-act="add">Add subscription</button></div>
    <div class="tw"><table><thead><tr><th>Name</th><th>Category</th><th class="r">Amount</th><th class="r">Monthly</th><th>Next due</th><th></th></tr></thead><tbody id="tbody"></tbody></table></div>`;
}

function renderTable() {
  const { q, cat, status, sort } = S.f, ql = q.toLowerCase();
  const list = S.subs.filter((x) => (!cat || x.category === cat) && (!status || x.status === status) &&
    (!ql || [x.name, x.notes, x.payment_method, x.category].join(' ').toLowerCase().includes(ql)))
    .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'monthly_equivalent' ? b.monthly_equivalent - a.monthly_equivalent : a.next_due_date.localeCompare(b.next_due_date)));
  $('#tbody').innerHTML = list.length ? list.map((x) => `<tr class="${x.status !== 'active' ? 'dim' : ''}">
    <td><b>${esc(x.name)}</b>${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener" aria-label="Open website">↗</a>` : ''}
      <div class="muted">${esc(x.payment_method)}${x.payment_method && x.auto_renew ? ' · ' : ''}${x.auto_renew ? 'auto-renews' : ''}${x.notes ? `<br>${esc(x.notes)}` : ''}</div></td>
    <td>${esc(x.category)}</td>
    <td class="r">${money(x.amount)}<div class="muted">${cycleLabel(x)}</div></td>
    <td class="r">${money(x.monthly_equivalent)}</td>
    <td>${x.next_due_date}<div class="${x.status === 'active' ? dueCls(x.next_due_date) : 'muted'}">${x.status === 'active' ? dueLabel(x.next_due_date) : x.status}</div></td>
    <td class="acts">${x.status !== 'cancelled' ? `<button class="sm" data-act="pay" data-id="${x.id}">Mark paid</button>` : ''}
      ${x.status !== 'cancelled' ? `<button class="sm" data-act="toggle" data-id="${x.id}">${x.status === 'active' ? 'Pause' : 'Resume'}</button>` : ''}
      <button class="sm" data-act="edit" data-id="${x.id}">Edit</button>
      <button class="sm" data-act="dup" data-id="${x.id}">Duplicate</button>
      <button class="sm danger" data-act="del" data-id="${x.id}">Delete</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">No subscriptions match. Change the filters or add a new one.</td></tr>`;
}

function vHistory() {
  const total = S.pay.reduce((a, p) => a + p.amount, 0);
  return `<div class="toolbar"><div class="muted" style="flex:1;align-self:center">${S.pay.length} payments · ${money(total)} total</div>
    <button class="ghost" data-act="exp-pay">Export CSV</button><button class="primary" data-act="logpay">Log a payment</button></div>
    <div class="tw"><table><thead><tr><th>Date</th><th>Name</th><th>Notes</th><th class="r">Amount</th><th></th></tr></thead><tbody>
    ${S.pay.map((p) => `<tr><td>${p.date_paid}</td><td>${esc(p.name)}<div class="muted">${esc(p.category)}</div></td><td>${esc(p.notes)}</td><td class="r">${money(p.amount)}</td>
      <td class="acts"><button class="sm danger" data-act="delpay" data-id="${p.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No payments yet. Mark a bill as paid to start the log.</td></tr>'}
    </tbody></table></div>`;
}

function vSettings() {
  const s = S.set;
  return `<div class="panel" style="max-width:640px"><h2>Due-date alerts</h2>
    <form id="setForm"><label>Webhook URL<input name="webhook_url" type="url" value="${esc(s.webhook_url)}" placeholder="https://ntfy.sh/your-topic"></label>
    <div class="row"><label>Service<select name="webhook_type">${['generic', 'discord', 'slack', 'ntfy', 'gotify'].map((t) => `<option ${t === s.webhook_type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Alert when due within (days)<input name="webhook_days" type="number" min="0" value="${esc(s.webhook_days)}"></label></div>
    <div class="btns"><button class="primary">Save alerts</button><button type="button" class="ghost" data-act="test">Send test</button></div></form></div>
  <div class="panel" style="max-width:640px"><h2>Backup and migration</h2>
    <div class="btns"><button class="ghost" data-act="exp-json">Export JSON (everything)</button><button class="ghost" data-act="exp-subs">Export subscriptions CSV</button></div>
    <div class="btns" style="margin-top:14px"><select id="impMode" style="width:auto"><option value="merge">Add to existing data</option><option value="replace">Replace all existing data</option></select>
    <button class="ghost" data-act="import">Import JSON or CSV</button></div>
    <p class="muted">JSON restores subscriptions and payment history. CSV imports subscriptions only.</p></div>`;
}

// ---- dialogs
const EF = ['name', 'category', 'amount', 'cycle', 'interval_days', 'next_due_date', 'payment_method', 'status', 'notes', 'url'];
function openEdit(id) {
  const x = id ? S.subs.find((s) => s.id == id) : { category: '', cycle: 'monthly', next_due_date: today(), status: 'active', auto_renew: 1, interval_days: 30 };
  const f = $('#editForm');
  f.reset();
  $('#editTitle').textContent = id ? 'Edit subscription' : 'Add subscription';
  f.elements._id.value = id || '';
  EF.forEach((k) => (f.elements[k].value = x[k] ?? ''));
  f.elements.auto_renew.checked = !!x.auto_renew;
  syncCycle();
  $('#editDlg').showModal();
}
const syncCycle = () => ($('#intervalWrap').hidden = $('#editForm').elements.cycle.value !== 'custom');

function openPay(id) {
  const f = $('#payForm');
  f.reset();
  f.elements.subscription_id.innerHTML = '<option value="">Select…</option>' + S.subs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  f.elements.subscription_id.value = id || '';
  f.elements.date_paid.value = today();
  f.dataset.advance = id ? '1' : '';
  const s = id && S.subs.find((x) => x.id == id);
  f.elements.amount.value = s ? s.amount : '';
  $('#payTitle').textContent = id ? 'Mark as paid' : 'Log a payment';
  $('#payHint').textContent = id ? 'The next due date moves forward by one billing cycle.' : 'Logging a past payment does not change the due date.';
  $('#payDlg').showModal();
}

// ---- events
document.addEventListener('click', guard(async (e) => {
  if (e.target.closest('[data-close]')) return e.target.closest('dialog').close();
  const nav = e.target.closest('#nav button');
  if (nav) { S.view = nav.dataset.v; return render(); }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  const done = async (m) => { await load(); if (m) toast(m); };
  if (act === 'add') openEdit();
  else if (act === 'edit') openEdit(id);
  else if (act === 'pay') openPay(id);
  else if (act === 'logpay') openPay();
  else if (act === 'dup') { await api(`/api/subscriptions/${id}/duplicate`, 'POST'); await done('Duplicated'); }
  else if (act === 'toggle') { await api(`/api/subscriptions/${id}/toggle`, 'POST'); await done('Updated'); }
  else if (act === 'del') { if (confirm('Delete this subscription? Its payment history stays.')) { await api(`/api/subscriptions/${id}`, 'DELETE'); await done('Deleted'); } }
  else if (act === 'delpay') { if (confirm('Delete this payment entry?')) { await api(`/api/payments/${id}`, 'DELETE'); await done('Deleted'); } }
  else if (act === 'test') { await api('/api/notify/test', 'POST'); toast('Test alert sent'); }
  else if (act === 'exp-json') location.href = '/api/export.json';
  else if (act === 'exp-subs') location.href = '/api/export.csv';
  else if (act === 'exp-pay') location.href = '/api/export.csv?type=payments';
  else if (act === 'import') $('#importFile').click();
}));

document.addEventListener('input', (e) => {
  const m = { fq: 'q', fc: 'cat', fs: 'status', fo: 'sort' }[e.target.id];
  if (m) { S.f[m] = e.target.value; renderTable(); }
  if (e.target.name === 'cycle') syncCycle();
  if (e.target.name === 'subscription_id' && e.target.form.id === 'payForm') {
    const s = S.subs.find((x) => x.id == e.target.value); if (s) e.target.form.elements.amount.value = s.amount;
  }
});

$('#editForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target, body = Object.fromEntries(EF.map((k) => [k, f.elements[k].value]));
  body.auto_renew = f.elements.auto_renew.checked;
  const id = f.elements._id.value;
  await api(id ? `/api/subscriptions/${id}` : '/api/subscriptions', id ? 'PUT' : 'POST', body);
  $('#editDlg').close(); await load(); toast('Saved');
}));

$('#payForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const f = e.target, body = Object.fromEntries(new FormData(f));
  if (f.dataset.advance) await api(`/api/subscriptions/${body.subscription_id}/pay`, 'POST', body);
  else await api('/api/payments', 'POST', body);
  $('#payDlg').close(); await load(); toast('Payment saved');
}));

document.addEventListener('submit', guard(async (e) => {
  if (e.target.id !== 'setForm') return;
  e.preventDefault();
  S.set = await api('/api/settings', 'PUT', Object.fromEntries(new FormData(e.target)));
  toast('Alerts saved');
}));

$('#importFile').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const mode = $('#impMode')?.value || 'merge';
  if (mode === 'replace' && !confirm('This deletes all current data before importing. Continue?')) return;
  const r = await api(`/api/import?mode=${mode}`, 'POST', await file.text(), file.name.endsWith('.json') ? 'application/json' : 'text/csv');
  await load(); toast(`Imported ${r.subscriptions} subscriptions and ${r.payments} payments`);
}));

(async () => {
  try {
    S.cfg = await api('/api/config');
    $('#editForm').elements.category.innerHTML = '<option value="">Select category</option>' +
      S.cfg.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#editForm').elements.cycle.innerHTML = S.cfg.cycles.map((c) => `<option>${c}</option>`).join('');
    await load();
  } catch (e) { toast(e.message); }
})();
