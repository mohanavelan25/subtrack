const CYCLES = ['monthly', 'quarterly', 'semi-annual', 'yearly', 'custom'];
const MONTHS = { monthly: 1, quarterly: 3, 'semi-annual': 6, yearly: 12 };
const iso = (d) => d.toISOString().slice(0, 10);
const today = () => new Date().toLocaleDateString('en-CA'); // local date (honours TZ)

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return iso(new Date(Date.UTC(y, m - 1, d + n)));
}

// Advance one billing cycle; month-end dates are clamped (Jan 31 -> Feb 28).
function addCycle(date, cycle, days) {
  const months = MONTHS[cycle];
  if (!months) return addDays(date, days || 30);
  const [y, m, d] = date.split('-').map(Number);
  const t = m - 1 + months;
  const ny = y + Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(ny, nm, Math.min(d, last))));
}

function monthlyEquivalent(s) {
  if (s.cycle === 'custom') return (s.amount * (365.25 / 12)) / (s.interval_days || 30);
  return s.amount / MONTHS[s.cycle];
}

function toCSV(rows, cols) {
  const q = (v) => {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

module.exports = { CYCLES, today, addDays, addCycle, monthlyEquivalent, toCSV, parseCSV };
