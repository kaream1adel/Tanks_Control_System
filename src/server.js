import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { join, extname, basename } from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import os from 'os';
import { initDb, all, get, run, persist, tx, dataVersion } from './db.js';
import { ensureSeeded } from './seed.js';
import { parseAny } from './import.js';
import { backupNow } from './backup.js';
import { startTunnel, tunnelInfo } from './tunnel.js';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import { PUBLIC_DIR, FILES_DIR, DATA_DIR } from './paths.js';

const PORT = process.env.PORT || 4200;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const DONE = new Set(['Done', 'Delivered']);

// A part counts as "delivered" if its status is terminal OR it reached the
// Delivered phase. Single source of truth — used by the delivered_at trigger,
// the daily worksheet filter, the weekly rollup and the reports aggregation.
const isDeliveredPart = (p) => DONE.has(p.status) || p.phase === 'Delivered';

// write a human-readable audit entry (no persist here — caller flushes)
function logActivity(category, summary, opts = {}) {
  run('INSERT INTO activity(id,at,category,tank_name,item_code,summary) VALUES (?,?,?,?,?,?)',
    [uid(), now(), category, opts.tank || '', opts.itemCode || '', summary]);
}
const tankName = (id) => get('SELECT name FROM tanks WHERE id=?', [id])?.name || '';

// Real ISO-8601 week (Monday start, week of the first Thursday). One place only,
// so Reports throughput and the Follow-up weekly rollup never disagree.
function isoWeek(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (t.getUTCDay() + 6) % 7;            // Mon=0 … Sun=6
  const thu = new Date(t); thu.setUTCDate(t.getUTCDate() - dow + 3);
  const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((thu - firstThu) / (7 * 86400000));
  const mon = new Date(t); mon.setUTCDate(t.getUTCDate() - dow);
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  const fmt = (x) => x.toISOString().slice(0, 10);
  return { isoWeek: `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, weekStart: fmt(mon), weekEnd: fmt(sun) };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024, files: 3000 } });

// ── helpers ───────────────────────────────────────────────────
// strip a trailing duplicate marker like "_2" or " (3)" so multiple drawings
// for one part group together. Real item codes use hyphens (e.g. "3905480-1"),
// which are preserved.
const DUP = /(?:_\d+|\s*\(\d+\))$/;
const deriveCode = (stem) => String(stem ?? '').trim().replace(DUP, '').trim();
const normCode = (s) => deriveCode(s).toLowerCase().replace(/\s+/g, '');
function fileKind(name) {
  const e = extname(name).toLowerCase().replace('.', '');
  if (e === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(e)) return 'image';
  return 'file';
}

function optionsObject() {
  const byField = {};
  for (const r of all('SELECT field,value FROM options ORDER BY field, sort')) (byField[r.field] ||= []).push({ name: r.value });
  return {
    parts: { status: byField.status || [], phase: byField.phase || [], reworkReason: byField.reworkReason || [] },
    instances: { priority: byField.priority || [], status: byField.tankStatus || [] },
    people: { assignee: byField.assignee || [] },
  };
}
const validPhases = () => new Set(all("SELECT value FROM options WHERE field='phase'").map((r) => r.value));

// where each option field's values actually live, so a rename/delete can
// propagate to every dependent row. Note phase lives in TWO columns.
const OPTION_TARGETS = {
  status: [['parts', 'status']],
  phase: [['parts', 'phase'], ['template_parts', 'default_phase']],
  reworkReason: [['parts', 'rework_reason']],
  tankStatus: [['tanks', 'status']],
  priority: [['tanks', 'priority']],
  assignee: [['parts', 'assigned_to']],
};
const OPTION_FIELDS = new Set(Object.keys(OPTION_TARGETS));
// values that are wired into code (the DONE set) and must not be renamed/deleted
const RESERVED = { status: new Set(['Done', 'Delivered']), tankStatus: new Set(['Done', 'Delivered']) };
const countUsage = (field, value) =>
  (OPTION_TARGETS[field] || []).reduce((s, [t, c]) => s + (get(`SELECT COUNT(*) c FROM ${t} WHERE ${c}=?`, [value])?.c || 0), 0);

// ── mappers ───────────────────────────────────────────────────
const partProgress = (p) => {
  if (DONE.has(p.status)) return 100;
  if (p.qty_total > 0) return Math.round((p.qty_done / p.qty_total) * 100);
  return 0;
};
function mapPart(p) {
  return {
    id: p.id, tankId: p.tank_id, itemCode: p.item_code, partName: p.description || p.item_code,
    no: p.no, qtyTotal: p.qty_total, qtyDone: p.qty_done, progress: partProgress(p),
    description: p.description, phase: p.phase, status: p.status, deliveredAt: p.delivered_at, deliveredQty: p.delivered_qty || 0,
    reworkCount: p.rework_count, reworkReason: p.rework_reason, assignedTo: p.assigned_to, notes: p.notes,
    fileCount: get('SELECT COUNT(*) c FROM part_files WHERE tank_type_id=(SELECT tank_type_id FROM tanks WHERE id=?) AND item_code=?', [p.tank_id, p.item_code])?.c || 0,
  };
}
function tankSummary(t) {
  const parts = all('SELECT status, qty_total, qty_done, rework_count FROM parts WHERE tank_id=?', [t.id]);
  const total = parts.length;
  const done = parts.filter((p) => DONE.has(p.status)).length;
  const reworkParts = parts.filter((p) => p.rework_count > 0 || p.status === 'Rework').length;
  return {
    id: t.id, name: t.name, client: t.client, tankType: t.tank_type_name, tankTypeId: t.tank_type_id,
    status: t.status, priority: t.priority, startDate: t.start_date, deliveryDate: t.delivery_date, notes: t.notes,
    partsTotal: total, partsDone: done, reworkParts, completion: total ? Math.round((done / total) * 100) : 0,
  };
}
function tankTypeSummary(tt) {
  const total = get('SELECT COUNT(*) c FROM template_parts WHERE tank_type_id=?', [tt.id]).c;
  const withFiles = get(`SELECT COUNT(DISTINCT tp.item_code) c FROM template_parts tp
     JOIN part_files pf ON pf.tank_type_id=tp.tank_type_id AND pf.item_code=tp.item_code WHERE tp.tank_type_id=?`, [tt.id]).c;
  const fileCount = get('SELECT COUNT(*) c FROM part_files WHERE tank_type_id=?', [tt.id]).c;
  return { id: tt.id, name: tt.name, description: tt.description, partCount: total, partsWithFiles: withFiles, fileCount };
}

// ── generic PATCH ─────────────────────────────────────────────
function applyPatch(table, id, body, fieldMap) {
  const sets = [], vals = [];
  for (const [apiKey, col] of Object.entries(fieldMap)) {
    if (apiKey in body) { sets.push(`${col}=?`); vals.push(body[apiKey] === undefined ? null : body[apiKey]); }
  }
  if (!sets.length) return false;
  vals.push(id);
  run(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`, vals);
  persist();
  return true;
}

// ── app ───────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '4mb' }));

// Password gate (set APP_PASSWORD in the launcher). When the public tunnel is on
// we NEVER leave it open: if no password is set, auto-generate one (stored in
// data/auto-password.txt and shown on the Share page). Cookie holds a hash only.
const TUNNEL_ON = process.env.TUNNEL === '1';
function autoPassword() {
  const f = join(DATA_DIR, 'auto-password.txt');
  try { if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); } catch { /* recreate */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const pw = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  fs.writeFileSync(f, pw);
  return pw;
}
const AUTO_PW = (TUNNEL_ON && !process.env.APP_PASSWORD) ? autoPassword() : '';
const PW = process.env.APP_PASSWORD || AUTO_PW;
const AUTH = PW ? crypto.createHash('sha256').update('tankctl:' + PW).digest('hex').slice(0, 32) : '';
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
if (PW) {
  app.post('/login', (req, res) => {
    if ((req.body?.password || '') === PW) { res.setHeader('Set-Cookie', `tc_auth=${AUTH}; HttpOnly; SameSite=Lax; Max-Age=2592000; Path=/`); res.json({ ok: true }); }
    else res.status(401).json({ error: 'Wrong password' });
  });
  app.use((req, res, next) => {
    const open = req.path === '/login' || req.path === '/login.html' || req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path === '/favicon.ico';
    if (open || cookies(req).tc_auth === AUTH) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Auth required' });
    res.redirect('/login.html');
  });
}
// no-cache so the browser always picks up app.js / css / html updates after a
// `git pull` + restart, without needing a manual hard-refresh.
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('/api/bootstrap', (req, res) => {
  res.json({
    ready: true,
    tankTypes: all('SELECT * FROM tank_types ORDER BY name').map(tankTypeSummary),
    tanks: all('SELECT * FROM tanks ORDER BY created_at DESC').map(tankSummary),
    parts: all('SELECT * FROM parts').map(mapPart),
    options: optionsObject(),
  });
});
app.post('/api/sync', (req, res) => res.json({ ok: true })); // local: nothing to sync

// ── backups ───────────────────────────────────────────────────
let lastBackup = null;
function runBackup(reason) {
  try {
    lastBackup = { ...backupNow(), at: now(), reason };
    const summary = lastBackup.targets.map((t) => `${t.ok ? '✓' : '✗'} ${t.dir}`).join('   ');
    console.log(`  ⤓ backup (${reason}): ${summary}`);
  } catch (e) { console.log('  backup failed:', e.message); }
  return lastBackup;
}
app.get('/api/backup', (req, res) => res.json({ last: lastBackup, configured: process.env.BACKUP_DIRS || '(default: ./backups)' }));
app.post('/api/backup', (req, res) => res.json(runBackup('manual')));

// ── parts ─────────────────────────────────────────────────────
const PART_FIELDS = { status: 'status', phase: 'phase', qtyDone: 'qty_done', qtyTotal: 'qty_total', reworkCount: 'rework_count', reworkReason: 'rework_reason', assignedTo: 'assigned_to', notes: 'notes', description: 'description', no: 'no', itemCode: 'item_code' };
const PART_LOGGED = [['status', 'status', 'Status'], ['phase', 'phase', 'Phase'], ['qtyDone', 'qty_done', 'Qty done'], ['qtyTotal', 'qty_total', 'Qty total'], ['reworkCount', 'rework_count', 'Rework count'], ['reworkReason', 'rework_reason', 'Rework reason'], ['assignedTo', 'assigned_to', 'Assignee'], ['description', 'description', 'Description'], ['itemCode', 'item_code', 'Item code'], ['no', 'no', 'No']];
app.patch('/api/parts/:id', (req, res) => {
  const p = get('SELECT * FROM parts WHERE id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Part not found' });
  const body = req.body || {};
  tx(() => {
    // 1) field changes (same mapping applyPatch uses, but no inner persist —
    //    delivered_at is NEVER taken from the client, so it's not in PART_FIELDS)
    const sets = [], vals = [];
    for (const [apiKey, col] of Object.entries(PART_FIELDS)) {
      if (apiKey in body) { sets.push(`${col}=?`); vals.push(body[apiKey] === undefined ? null : body[apiKey]); }
    }
    if (sets.length) { vals.push(p.id); run(`UPDATE parts SET ${sets.join(',')} WHERE id=?`, vals); }
    // 2) delivered_at trigger (server-computed, both directions)
    const fresh = get('SELECT * FROM parts WHERE id=?', [p.id]);
    const was = isDeliveredPart(p), is = isDeliveredPart(fresh);
    if (is && !was && !fresh.delivered_at) run('UPDATE parts SET delivered_at=? WHERE id=?', [now(), p.id]);
    else if (was && !is) run('UPDATE parts SET delivered_at=NULL WHERE id=?', [p.id]);
    // 3) audit log for any tracked field that actually changed
    const tn = tankName(p.tank_id);
    for (const [apiKey, col, label] of PART_LOGGED) {
      if (apiKey in body && String(p[col] ?? '') !== String(body[apiKey] ?? '')) {
        logActivity('part', `${label}: ${p[col] ?? '—'} → ${body[apiKey] ?? '—'}`, { tank: tn, itemCode: p.item_code });
      }
    }
  });
  res.json(mapPart(get('SELECT * FROM parts WHERE id=?', [p.id])));
});

// files attached to a tank part (resolved via its tank type + item code)
app.get('/api/parts/:id/files', (req, res) => {
  const p = get('SELECT pa.item_code, t.tank_type_id FROM parts pa JOIN tanks t ON t.id=pa.tank_id WHERE pa.id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Part not found' });
  res.json(filesFor(p.tank_type_id, p.item_code));
});

// ── tanks ─────────────────────────────────────────────────────
const TANK_FIELDS = { name: 'name', client: 'client', status: 'status', priority: 'priority', startDate: 'start_date', deliveryDate: 'delivery_date', notes: 'notes' };
const TANK_LABELS = { name: 'Name', client: 'Client', status: 'Status', priority: 'Priority', startDate: 'Start date', deliveryDate: 'Delivery date', notes: 'Notes' };
app.patch('/api/tanks/:id', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  applyPatch('tanks', req.params.id, req.body, TANK_FIELDS);
  const fresh = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  for (const [k, col] of Object.entries(TANK_FIELDS)) {
    if (k in req.body && String(t[col] ?? '') !== String(fresh[col] ?? '')) logActivity('tank', `${TANK_LABELS[k]}: ${t[col] ?? '—'} → ${fresh[col] ?? '—'}`, { tank: fresh.name });
  }
  persist();
  res.json(tankSummary(fresh));
});

app.post('/api/tanks', (req, res) => {
  const { name, client = '', tankTypeId, priority = 'Normal', startDate, deliveryDate, notes = '' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Tank name is required' });
  const type = get('SELECT * FROM tank_types WHERE id=?', [tankTypeId]);
  if (!type) return res.status(400).json({ error: 'Pick a valid tank type' });
  const tankId = uid();
  run('INSERT INTO tanks(id,name,client,tank_type_id,tank_type_name,status,priority,start_date,delivery_date,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [tankId, name.trim(), client, type.id, type.name, 'Not Started', priority, startDate || null, deliveryDate || null, notes, now()]);
  const phases = validPhases();
  const tpl = all('SELECT * FROM template_parts WHERE tank_type_id=? ORDER BY no', [type.id]);
  for (const p of tpl) {
    run('INSERT INTO parts(id,tank_id,item_code,no,qty_total,qty_done,description,phase,status,rework_count,rework_reason,assigned_to,notes) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)',
      [uid(), tankId, p.item_code, p.no, p.qty ?? 1, 0, p.description, phases.has(p.default_phase) ? p.default_phase : '', 'Not Started', '', '', '']);
  }
  logActivity('tank', `Created tank from type "${type.name}" (${tpl.length} parts cloned)`, { tank: name.trim() });
  persist();
  res.json({ ...tankSummary(get('SELECT * FROM tanks WHERE id=?', [tankId])), clonedParts: tpl.length });
});

app.delete('/api/tanks/:id', (req, res) => {
  logActivity('tank', `Deleted tank`, { tank: tankName(req.params.id) });
  run('DELETE FROM part_logs WHERE tank_id=?', [req.params.id]);
  run('DELETE FROM part_events WHERE tank_id=?', [req.params.id]);
  run('DELETE FROM deliveries WHERE tank_id=?', [req.params.id]);
  run('DELETE FROM parts WHERE tank_id=?', [req.params.id]);
  run('DELETE FROM tanks WHERE id=?', [req.params.id]);
  persist();
  res.json({ ok: true });
});

// cheap change-detection for near-real-time multi-place sync
app.get('/api/version', (req, res) => res.json({ version: dataVersion() }));

// local network addresses of this host
const lanIPs = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

// Share info: the public tunnel link (if running) + LAN links + a QR for the link.
app.get('/api/share', async (req, res) => {
  const t = tunnelInfo();
  const lan = lanIPs().map((ip) => `http://${ip}:${PORT}`);
  const best = t.url || lan[0] || `http://localhost:${PORT}`;
  let qr = '';
  try { qr = await QRCode.toString(best, { type: 'svg', margin: 1, width: 200 }); } catch { /* ignore */ }
  res.json({ tunnel: t, lan, qr, qrFor: best, password: { set: !!PW, auto: AUTO_PW || null } });
});

// activity log — recent changes across the whole app (audit trail)
app.get('/api/activity', (req, res) => {
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 150));
  const q = (req.query.q || '').trim().toLowerCase();
  let rows = all('SELECT at, category, tank_name, item_code, summary FROM activity ORDER BY at DESC LIMIT ?', [q ? 1000 : limit]);
  if (q) rows = rows.filter((r) => `${r.tank_name} ${r.item_code} ${r.summary} ${r.category}`.toLowerCase().includes(q)).slice(0, limit);
  res.json({ items: rows.map((r) => ({ at: r.at, category: r.category, tank: r.tank_name, itemCode: r.item_code, summary: r.summary })) });
});

// ── daily / weekly follow-up (per tank) ───────────────────────
// Daily worksheet: parts not yet fully delivered, for one tank + date, merged
// with that date's saved log + delivery so the sheet pre-fills. Optional phase
// filter (?phase=Welding).
app.get('/api/tanks/:id/daily', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const date = (req.query.date || now().slice(0, 10));
  const phaseFilter = req.query.phase || '';
  const all0 = all('SELECT * FROM parts WHERE tank_id=? ORDER BY no', [t.id]).filter((p) => (p.delivered_qty || 0) < (p.qty_total || 0));
  const phases = [...new Set(all0.map((p) => p.phase).filter(Boolean))];
  const parts = all0.filter((p) => !phaseFilter || p.phase === phaseFilter).map((p) => {
    const mp = mapPart(p);
    const log = get('SELECT * FROM part_logs WHERE part_id=? AND log_date=?', [p.id, date]);
    const dlv = get('SELECT qty FROM deliveries WHERE part_id=? AND delivered_date=?', [p.id, date]);
    return {
      partId: p.id, itemCode: p.item_code, partName: mp.partName, no: p.no,
      qtyTotal: p.qty_total, qtyDone: p.qty_done, deliveredQty: p.delivered_qty || 0, phase: p.phase, status: p.status, progress: mp.progress,
      deliveredToday: dlv ? dlv.qty : null,
      log: log ? { qtyDoneToday: log.qty_done_today, note: log.note } : null,
    };
  });
  res.json({ tankId: t.id, date, phase: phaseFilter, phases, parts });
});

// Upsert a day's worksheet: a work log (done today / note) and a delivery
// (units delivered that day) per part. Re-saving a date overwrites it.
app.post('/api/tanks/:id/daily', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const { date, entries = [] } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date required' });
  let saved = 0;
  tx(() => {
    for (const e of entries) {
      // a) work log
      const qty = Number(e.qtyDoneToday) || 0, note = (e.note || '').trim();
      const ex = get('SELECT id FROM part_logs WHERE part_id=? AND log_date=?', [e.partId, date]);
      if (qty || note) {
        if (ex) run('UPDATE part_logs SET qty_done_today=?, note=? WHERE id=?', [qty, note, ex.id]);
        else run('INSERT INTO part_logs(id,part_id,tank_id,log_date,qty_done_today,status,phase,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [uid(), e.partId, t.id, date, qty, '', '', note, now()]);
        saved++;
      } else if (ex) run('DELETE FROM part_logs WHERE id=?', [ex.id]);
      // b) delivery for the day (partial delivery)
      if (e.deliveredToday !== undefined && e.deliveredToday !== null && e.deliveredToday !== '') {
        const dq = Math.max(0, Number(e.deliveredToday) || 0);
        const dex = get('SELECT id FROM deliveries WHERE part_id=? AND delivered_date=?', [e.partId, date]);
        if (dq > 0) {
          if (dex) run('UPDATE deliveries SET qty=? WHERE id=?', [dq, dex.id]);
          else run('INSERT INTO deliveries(id,part_id,tank_id,qty,delivered_date,created_at) VALUES (?,?,?,?,?,?)', [uid(), e.partId, t.id, dq, date, now()]);
        } else if (dex) run('DELETE FROM deliveries WHERE id=?', [dex.id]);
        const sum = get('SELECT COALESCE(SUM(qty),0) s FROM deliveries WHERE part_id=?', [e.partId]).s;
        run('UPDATE parts SET delivered_qty=? WHERE id=?', [sum, e.partId]);
        if (dq > 0) logActivity('delivery', `Delivered ${dq} on ${date}`, { tank: t.name, itemCode: get('SELECT item_code FROM parts WHERE id=?', [e.partId])?.item_code || '' });
        saved++;
      }
    }
  });
  res.json({ ok: true, saved });
});

// Weekly rollup: delivered QUANTITY grouped by ISO week (newest first).
app.get('/api/tanks/:id/weekly', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const rows = all('SELECT d.qty, d.delivered_date, p.no, p.item_code, p.description FROM deliveries d JOIN parts p ON p.id=d.part_id WHERE d.tank_id=?', [t.id]);
  const byWeek = new Map();
  for (const r of rows) {
    const w = isoWeek(r.delivered_date); if (!w) continue;
    if (!byWeek.has(w.isoWeek)) byWeek.set(w.isoWeek, { isoWeek: w.isoWeek, weekStart: w.weekStart, weekEnd: w.weekEnd, totalQty: 0, parts: [] });
    const g = byWeek.get(w.isoWeek);
    g.totalQty += r.qty;
    const pe = g.parts.find((x) => x.no === r.no && x.itemCode === r.item_code);
    if (pe) pe.qty += r.qty; else g.parts.push({ no: r.no, itemCode: r.item_code, partName: r.description || r.item_code, qty: r.qty });
  }
  const weeks = [...byWeek.values()].sort((a, b) => b.isoWeek.localeCompare(a.isoWeek));
  weeks.forEach((w) => w.parts.sort((a, b) => (a.no || 0) - (b.no || 0)));
  res.json({ tankId: t.id, weeks });
});

// ── reports (aggregated analytics) ────────────────────────────
app.get('/api/reports', (req, res) => {
  const nWeeks = Math.max(1, Math.min(52, Number(req.query.weeks) || 12));
  const parts = all('SELECT * FROM parts');
  const tanks = all('SELECT * FROM tanks ORDER BY created_at DESC');
  const total = parts.length, done = parts.filter(isDeliveredPart).length;
  const reworkParts = parts.filter((p) => (p.rework_count || 0) > 0 || p.status === 'Rework').length;

  const optVals = (field) => all('SELECT value FROM options WHERE field=? ORDER BY sort', [field]).map((o) => o.value);
  const cnt = (arr, keyFn) => { const m = new Map(); for (const x of arr) { const k = keyFn(x); if (!k) continue; m.set(k, (m.get(k) || 0) + 1); } return m; };
  const ordered = (m, ord) => { const keys = ord.filter((k) => m.has(k)); for (const k of m.keys()) if (!keys.includes(k)) keys.push(k); return keys.map((name) => ({ name, n: m.get(name) })); };

  const open = parts.filter((p) => !isDeliveredPart(p));
  const reworked = parts.filter((p) => (p.rework_count || 0) > 0);
  const wl = new Map();
  for (const p of parts) { const a = (p.assigned_to || '').trim(); if (!a) continue; const o = wl.get(a) || { name: a, open: 0, done: 0, total: 0 }; isDeliveredPart(p) ? o.done++ : o.open++; o.total++; wl.set(a, o); }

  const perTank = tanks.map((t) => {
    const tp = parts.filter((p) => p.tank_id === t.id);
    const td = tp.filter(isDeliveredPart).length;
    const completion = tp.length ? Math.round((td / tp.length) * 100) : 0;
    let overdue = false, daysToDue = null;
    const dd = t.delivery_date ? new Date(t.delivery_date) : null;
    if (dd && !isNaN(dd.getTime())) { daysToDue = Math.ceil((dd.getTime() - Date.now()) / 86400000); overdue = completion < 100 && daysToDue < 0; }
    return { id: t.id, name: t.name, completion, partsDone: td, partsTotal: tp.length, deliveryDate: t.delivery_date, overdue, daysToDue };
  });
  let onTime = 0, overdue = 0, noDate = 0, delivered = 0;
  for (const pt of perTank) { if (pt.completion === 100) delivered++; else if (!pt.deliveryDate) noDate++; else if (pt.overdue) overdue++; else onTime++; }

  const migratedAt = (get("SELECT v FROM meta WHERE k='migrated_at'")?.v || '').slice(0, 10);
  const wmap = new Map();
  for (const d of all('SELECT qty, delivered_date FROM deliveries')) { const w = isoWeek(d.delivered_date); if (w) wmap.set(w.isoWeek, (wmap.get(w.isoWeek) || 0) + (d.qty || 0)); }
  const throughput = [];
  for (let i = nWeeks - 1; i >= 0; i--) {
    const w = isoWeek(new Date(Date.now() - i * 7 * 86400000).toISOString());
    throughput.push({ week: w.isoWeek, from: w.weekStart, to: w.weekEnd, delivered: wmap.get(w.isoWeek) || 0, estimated: migratedAt ? w.weekEnd < migratedAt : false });
  }

  res.json({
    overall: { partsTotal: total, partsDone: done, completion: total ? Math.round((done / total) * 100) : 0, reworkParts },
    perTank,
    status: ordered(cnt(parts, (p) => p.status), optVals('status')),
    phasePipeline: ordered(cnt(open, (p) => p.phase), optVals('phase')).filter((e) => e.n > 0),
    reworkByReason: ordered(cnt(reworked, (p) => p.rework_reason), optVals('reworkReason')).filter((e) => e.n > 0),
    reworkByPhase: ordered(cnt(reworked, (p) => p.phase), optVals('phase')).filter((e) => e.n > 0),
    workload: [...wl.values()].sort((a, b) => b.total - a.total),
    tanksOnTime: { onTime, overdue, noDate, delivered },
    throughput,
  });
});

// ── tank types (templates) ────────────────────────────────────
app.get('/api/tank-types', (req, res) => res.json(all('SELECT * FROM tank_types ORDER BY name').map(tankTypeSummary)));

app.get('/api/tank-types/:id', (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  const parts = all('SELECT * FROM template_parts WHERE tank_type_id=? ORDER BY no', [tt.id]).map((p) => ({
    id: p.id, itemCode: p.item_code, no: p.no, qty: p.qty, description: p.description, defaultPhase: p.default_phase,
    files: filesFor(tt.id, p.item_code),
  }));
  res.json({ ...tankTypeSummary(tt), parts });
});

app.post('/api/tank-types', (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Type name is required' });
  const id = uid();
  run('INSERT INTO tank_types(id,name,description,created_at) VALUES (?,?,?,?)', [id, name.trim(), description, now()]);
  persist();
  res.json(tankTypeSummary(get('SELECT * FROM tank_types WHERE id=?', [id])));
});

app.patch('/api/tank-types/:id', (req, res) => {
  if (!get('SELECT id FROM tank_types WHERE id=?', [req.params.id])) return res.status(404).json({ error: 'Type not found' });
  applyPatch('tank_types', req.params.id, req.body, { name: 'name', description: 'description' });
  res.json(tankTypeSummary(get('SELECT * FROM tank_types WHERE id=?', [req.params.id])));
});

app.delete('/api/tank-types/:id', (req, res) => {
  logActivity('type', `Deleted tank type "${get('SELECT name FROM tank_types WHERE id=?', [req.params.id])?.name || ''}"`);
  run('DELETE FROM template_parts WHERE tank_type_id=?', [req.params.id]);
  run('DELETE FROM part_files WHERE tank_type_id=?', [req.params.id]);
  run('DELETE FROM tank_types WHERE id=?', [req.params.id]);
  persist();
  res.json({ ok: true });
});

// read PNG pixel dimensions from its IHDR (cropped photos are saved as PNG)
function pngSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  return { w: 0, h: 0 };
}
// Export a tank type to .xlsx mirroring the user's "Preparation Request" layout,
// embedding each part's CROPPED photo in the Image column.
app.get('/api/tank-types/:id/export.xlsx', async (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  const parts = all('SELECT * FROM template_parts WHERE tank_type_id=? ORDER BY no', [tt.id]);

  // exact styling lifted from the user's "Preparation Request" sheet
  const GRAY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; // White, Darker 15% — the "shadowing"
  const WHITE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const allThin = { top: thin, left: thin, right: thin, bottom: thin };
  const dbl = { style: 'double', color: { argb: 'FF3F3F3F' } };
  const boxDbl = { top: dbl, left: dbl, right: dbl, bottom: dbl };
  const center = { horizontal: 'center', vertical: 'middle' };
  const centerWrap = { horizontal: 'center', vertical: 'middle', wrapText: true };

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Preparation Request', { views: [{ state: 'frozen', ySplit: 6, zoomScale: 55 }] });
  ws.columns = [{ width: 13.43 }, { width: 70.71 }, { width: 16.29 }, { width: 153 }, { width: 80.57 }];
  for (let r = 1; r <= 5; r++) ws.mergeCells(`A${r}:B${r}`); // title block A:B merged, rows 1-5
  [85.15, 21, 21, 21, 21.75].forEach((h, i) => { ws.getRow(i + 1).height = h; });

  const title = (addr, text) => { const c = ws.getCell(addr); c.value = text; c.font = { bold: true, size: 18, name: 'Adobe Fan Heiti Std B' }; c.alignment = centerWrap; };
  title('A3', tt.name);
  title('A4', 'Accessories list');

  const header = ws.getRow(6);
  header.values = ['No.', 'ITEM CODE', 'Qty', 'Description', 'Image'];
  header.height = 21.75;
  header.eachCell((c) => { c.font = { bold: true, size: 16, name: 'Calibri' }; c.alignment = center; c.fill = WHITE; c.border = boxDbl; });

  let rowNum = 7;
  for (const p of parts) {
    const row = ws.getRow(rowNum);
    row.values = [p.no ?? '', p.item_code || '', p.qty ?? '', p.description || '', ''];
    row.height = 95.1;
    const f22 = { size: 22, name: 'Calibri' };
    const cells = [
      { c: 1, fill: GRAY, font: f22, al: center },                                  // No (shaded)
      { c: 2, fill: WHITE, font: f22, al: center },                                 // Item code
      { c: 3, fill: GRAY, font: f22, al: center },                                  // Qty (shaded)
      { c: 4, fill: WHITE, font: { ...f22, color: { argb: 'FFFF0000' } }, al: centerWrap }, // Description (red)
      { c: 5, fill: WHITE, font: { size: 11, name: 'Calibri' }, al: center },       // Image
    ];
    for (const s of cells) { const cc = row.getCell(s.c); cc.font = s.font; cc.fill = s.fill; cc.alignment = s.al; cc.border = allThin; }

    // embed cropped photo if present (most recent crop for this item code), centered in the Image cell
    const photo = get("SELECT path FROM part_files WHERE tank_type_id=? AND item_code=? AND kind='image' AND filename LIKE '%(crop)%' ORDER BY created_at DESC LIMIT 1", [tt.id, p.item_code]);
    if (photo) {
      try {
        const buf = fs.readFileSync(join(FILES_DIR, photo.path));
        const { w, h: ih } = pngSize(buf);
        const maxW = 360, maxH = 118; // fits the wide Image column / 95pt row
        const scale = Math.min(maxW / (w || maxW), maxH / (ih || maxH), 1);
        const dispW = Math.round((w || maxW) * scale), dispH = Math.round((ih || maxH) * scale);
        const imgId = wb.addImage({ buffer: buf, extension: 'png' });
        ws.addImage(imgId, { tl: { col: 4.15, row: rowNum - 1 + 0.08 }, ext: { width: dispW, height: dispH }, editAs: 'oneCell' });
      } catch { /* skip bad image */ }
    }
    rowNum++;
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(tt.name)}_parts.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Word / PDF export ────────────────────────────────────────────────────────
// One HTML builder renders the same "Preparation Request" layout (shaded No/Qty,
// red RTL-aware descriptions, embedded cropped photos) for both Word (served as
// an .doc that Word opens) and PDF (a print-optimized page the browser saves as
// PDF — handles Arabic shaping perfectly, no heavy server-side PDF/Chromium dep).
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function typeReportHtml(tt, parts, mode) {
  const rows = parts.map((p) => {
    let img = '';
    const photo = get("SELECT path FROM part_files WHERE tank_type_id=? AND item_code=? AND kind='image' AND filename LIKE '%(crop)%' ORDER BY created_at DESC LIMIT 1", [tt.id, p.item_code]);
    if (photo) {
      try { const buf = fs.readFileSync(join(FILES_DIR, photo.path)); img = `<img src="data:image/png;base64,${buf.toString('base64')}"/>`; } catch { /* skip */ }
    }
    return `<tr><td class="c sh">${escHtml(p.no ?? '')}</td><td class="c code">${escHtml(p.item_code || '')}</td>`
      + `<td class="c sh">${escHtml(p.qty ?? '')}</td><td class="desc" dir="auto">${escHtml(p.description || '')}</td><td class="c">${img}</td></tr>`;
  }).join('');
  const printBits = mode === 'print'
    ? `<div class="noprint" style="text-align:center;margin:0 0 14px"><button onclick="window.print()" style="padding:10px 22px;font-size:15px;border-radius:8px;border:1px solid #888;background:#f5a623;cursor:pointer">🖨 Print / Save as PDF</button></div>`
      + `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});<\/script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${escHtml(tt.name)} — Accessories list</title>
<style>
 body{font-family:Calibri,Arial,sans-serif;color:#111;margin:24px;background:#fff;}
 h1{font-size:22px;text-align:center;margin:0 0 2px;} h2{font-size:13px;text-align:center;color:#555;font-weight:normal;margin:0 0 16px;}
 table{border-collapse:collapse;width:100%;} th,td{border:1px solid #000;padding:6px 9px;font-size:14px;vertical-align:middle;}
 th{background:#fff;font-weight:bold;font-size:13px;text-align:center;border:2px solid #3f3f3f;}
 td.c{text-align:center;} td.sh{background:#d9d9d9;font-weight:600;} td.code{font-family:Consolas,monospace;}
 td.desc{color:#ff0000;font-weight:600;line-height:1.35;} img{display:block;margin:auto;max-width:340px;max-height:120px;object-fit:contain;}
 @media print{.noprint{display:none;} body{margin:0;} @page{margin:12mm;}}
</style></head><body>
${printBits}<h1>${escHtml(tt.name)}</h1><h2>Accessories list — ${parts.length} parts</h2>
<table><thead><tr><th style="width:55px">No.</th><th style="width:130px">ITEM CODE</th><th style="width:50px">Qty</th><th>Description</th><th style="width:350px">Image</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
}

app.get('/api/tank-types/:id/export.doc', (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  const parts = all('SELECT * FROM template_parts WHERE tank_type_id=? ORDER BY no', [tt.id]);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(tt.name)}_parts.doc"`);
  res.send(typeReportHtml(tt, parts, 'word'));
});

app.get('/api/tank-types/:id/print', (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).send('Type not found');
  const parts = all('SELECT * FROM template_parts WHERE tank_type_id=? ORDER BY no', [tt.id]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(typeReportHtml(tt, parts, 'print'));
});

// ── Per-TANK status report (live parts + delivery proofs) → Excel / Word / PDF ──
// Columns: No, Item code, Description, Phase, Status, Qty as delivered/total
// (green when fully delivered). After the table: the tank's delivery-proof images
// (PDF proofs are stored with a rendered PNG preview, so everything embeds).
const isDelivered = (p) => (p.qty_total || 0) > 0 && (p.delivered_qty || 0) >= (p.qty_total || 0);

function tankProofImages(tankId) {
  return all('SELECT * FROM tank_files WHERE tank_id=? ORDER BY created_at', [tankId]).map((f) => {
    const rel = f.preview || f.path;
    try {
      const buf = fs.readFileSync(join(FILES_DIR, rel));
      return { name: f.filename, buf, ext: (extname(rel).replace('.', '').toLowerCase() || 'png') };
    } catch { return null; }
  }).filter(Boolean);
}

function tankReportHtml(tank, parts, mode) {
  const delivered = parts.filter(isDelivered).length;
  const rows = parts.map((p) => {
    const dq = p.delivered_qty || 0, qt = p.qty_total || 0;
    const g = isDelivered(p) ? ' g' : '';
    return `<tr><td class="c">${escHtml(p.no ?? '')}</td><td class="c code">${escHtml(p.item_code || '')}</td>`
      + `<td class="desc" dir="auto">${escHtml(p.description || '')}</td><td class="c">${escHtml(p.phase || '')}</td>`
      + `<td class="c">${escHtml(p.status || '')}</td><td class="c qty${g}">${dq}/${qt}</td></tr>`;
  }).join('');
  const imgs = tankProofImages(tank.id);
  const proofs = imgs.length
    ? `<h3>Delivery proofs — ${imgs.length}</h3><div class="proofs">`
      + imgs.map((i) => `<figure><img src="data:image/${i.ext};base64,${i.buf.toString('base64')}"/><figcaption>${escHtml(i.name)}</figcaption></figure>`).join('')
      + '</div>'
    : '';
  const printBits = mode === 'print'
    ? `<div class="noprint" style="text-align:center;margin:0 0 14px"><button onclick="window.print()" style="padding:10px 22px;font-size:15px;border-radius:8px;border:1px solid #888;background:#f5a623;cursor:pointer">🖨 Print / Save as PDF</button></div>`
      + `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},400);});<\/script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${escHtml(tank.name)} — Status</title>
<style>
 body{font-family:Calibri,Arial,sans-serif;color:#111;margin:24px;background:#fff;}
 h1{font-size:22px;text-align:center;margin:0 0 2px;} h2{font-size:13px;text-align:center;color:#555;font-weight:normal;margin:0 0 16px;}
 h3{font-size:15px;margin:22px 0 10px;border-top:2px solid #ccc;padding-top:14px;}
 table{border-collapse:collapse;width:100%;} th,td{border:1px solid #000;padding:6px 9px;font-size:14px;vertical-align:middle;}
 th{background:#f2f2f2;font-weight:bold;font-size:13px;text-align:center;}
 td.c{text-align:center;} td.code{font-family:Consolas,monospace;} td.desc{line-height:1.35;}
 td.qty{font-weight:700;font-variant-numeric:tabular-nums;} td.qty.g{color:#1a9c33;}
 .proofs{display:flex;flex-wrap:wrap;gap:14px;} .proofs figure{margin:0;width:300px;}
 .proofs img{width:100%;border:1px solid #ccc;border-radius:6px;}
 .proofs figcaption{font-size:11px;color:#666;margin-top:4px;word-break:break-all;}
 @media print{.noprint{display:none;} body{margin:0;} @page{margin:12mm;} .proofs figure{break-inside:avoid;}}
</style></head><body>
${printBits}<h1>${escHtml(tank.name)}</h1>
<h2>${escHtml(tank.tank_type_name || '')} · Delivered: ${delivered} / ${parts.length} parts</h2>
<table><thead><tr><th style="width:50px">No.</th><th style="width:130px">Item code</th><th>Description</th><th style="width:110px">Phase</th><th style="width:110px">Status</th><th style="width:70px">Qty</th></tr></thead>
<tbody>${rows}</tbody></table>${proofs}</body></html>`;
}

app.get('/api/tanks/:id/report.doc', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const parts = all('SELECT * FROM parts WHERE tank_id=? ORDER BY no', [t.id]);
  res.setHeader('Content-Type', 'application/msword');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(t.name)}_status.doc"`);
  res.send(tankReportHtml(t, parts, 'word'));
});

app.get('/api/tanks/:id/report-print', (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).send('Tank not found');
  const parts = all('SELECT * FROM parts WHERE tank_id=? ORDER BY no', [t.id]);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(tankReportHtml(t, parts, 'print'));
});

app.get('/api/tanks/:id/report.xlsx', async (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const parts = all('SELECT * FROM parts WHERE tank_id=? ORDER BY no', [t.id]);
  const delivered = parts.filter(isDelivered).length;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Status');
  ws.columns = [{ width: 6 }, { width: 20 }, { width: 60 }, { width: 16 }, { width: 16 }, { width: 10 }];
  const thin = { style: 'thin', color: { argb: 'FF000000' } };
  const box = { top: thin, left: thin, right: thin, bottom: thin };
  ws.mergeCells('A1:F1'); const tc = ws.getCell('A1'); tc.value = t.name; tc.font = { bold: true, size: 16 }; tc.alignment = { horizontal: 'center' };
  ws.mergeCells('A2:F2'); const sc = ws.getCell('A2'); sc.value = `${t.tank_type_name || ''}   ·   Delivered: ${delivered} / ${parts.length} parts`; sc.font = { size: 11, color: { argb: 'FF555555' } }; sc.alignment = { horizontal: 'center' };
  const hr = ws.getRow(4); hr.values = ['No.', 'Item code', 'Description', 'Phase', 'Status', 'Qty'];
  hr.eachCell((c) => { c.font = { bold: true }; c.alignment = { horizontal: 'center' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; c.border = box; });
  let r = 5;
  for (const p of parts) {
    const dq = p.delivered_qty || 0, qt = p.qty_total || 0;
    const row = ws.getRow(r);
    row.values = [p.no ?? '', p.item_code || '', p.description || '', p.phase || '', p.status || '', `${dq}/${qt}`];
    row.getCell(1).alignment = { horizontal: 'center' };
    row.getCell(3).alignment = { horizontal: 'left', wrapText: true, readingOrder: 'rtl' };
    const q = row.getCell(6); q.alignment = { horizontal: 'center' }; q.font = { bold: true, color: { argb: isDelivered(p) ? 'FF1A9C33' : 'FF000000' } };
    row.eachCell((c) => { c.border = box; });
    r++;
  }
  const imgs = tankProofImages(t.id);
  if (imgs.length) {
    let imgRow = r + 1;
    const lbl = ws.getCell(`A${imgRow}`); lbl.value = `Delivery proofs — ${imgs.length}`; lbl.font = { bold: true, size: 13 };
    imgRow += 1;
    for (const im of imgs) {
      try {
        const { w, h } = pngSize(im.buf);
        const scale = Math.min(520 / (w || 520), 360 / (h || 360), 1);
        const dispW = Math.round((w || 520) * scale), dispH = Math.round((h || 360) * scale);
        const imgId = wb.addImage({ buffer: im.buf, extension: im.ext === 'jpg' ? 'jpeg' : im.ext });
        ws.addImage(imgId, { tl: { col: 0, row: imgRow - 1 }, ext: { width: dispW, height: dispH } });
        imgRow += Math.ceil(dispH / 20) + 2;
      } catch { /* skip bad image */ }
    }
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(t.name)}_status.xlsx"`);
  await wb.xlsx.write(res); res.end();
});

// ── Delivery proofs (per-tank photos / PDFs; stored with a PNG preview) ────────
function tankProofsList(tankId) {
  return all('SELECT id,filename,kind,size FROM tank_files WHERE tank_id=? ORDER BY created_at', [tankId])
    .map((f) => ({ id: f.id, filename: f.filename, kind: f.kind, size: f.size, url: `/api/tank-proof/${f.id}`, previewUrl: `/api/tank-proof/${f.id}/preview` }));
}
app.get('/api/tanks/:id/proofs', (req, res) => {
  if (!get('SELECT id FROM tanks WHERE id=?', [req.params.id])) return res.status(404).json({ error: 'Tank not found' });
  res.json({ proofs: tankProofsList(req.params.id) });
});
app.post('/api/tanks/:id/proofs', upload.fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]), (req, res) => {
  const t = get('SELECT * FROM tanks WHERE id=?', [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Tank not found' });
  const orig = req.files?.file?.[0];
  if (!orig) return res.status(400).json({ error: 'No file' });
  const prev = req.files?.preview?.[0];
  const destDir = join(FILES_DIR, 'proofs', t.id);
  fs.mkdirSync(destDir, { recursive: true });
  const id = uid();
  const name = Buffer.from(orig.originalname, 'latin1').toString('utf8');
  const origRel = join('proofs', t.id, `${id}${extname(name).toLowerCase()}`);
  fs.writeFileSync(join(FILES_DIR, origRel), orig.buffer);
  let previewRel = '';
  if (prev) { previewRel = join('proofs', t.id, `${id}_p.png`); fs.writeFileSync(join(FILES_DIR, previewRel), prev.buffer); }
  run('INSERT INTO tank_files(id,tank_id,filename,kind,path,preview,size,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, t.id, name, fileKind(name), origRel, previewRel, orig.size, now()]);
  logActivity('files', `Added delivery proof "${name}"`, { tank: t.name });
  persist();
  res.json({ ok: true, proofs: tankProofsList(t.id) });
});
app.get('/api/tank-proof/:id', (req, res) => {
  const f = get('SELECT * FROM tank_files WHERE id=?', [req.params.id]);
  if (!f) return res.status(404).send('Not found');
  const abs = join(FILES_DIR, f.path);
  if (!fs.existsSync(abs)) return res.status(404).send('Missing file');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
  res.sendFile(abs);
});
app.get('/api/tank-proof/:id/preview', (req, res) => {
  const f = get('SELECT * FROM tank_files WHERE id=?', [req.params.id]);
  if (!f) return res.status(404).send('Not found');
  const abs = join(FILES_DIR, f.preview || f.path);
  if (!fs.existsSync(abs)) return res.status(404).send('Missing file');
  res.sendFile(abs);
});
app.delete('/api/tank-proof/:id', (req, res) => {
  const f = get('SELECT * FROM tank_files WHERE id=?', [req.params.id]);
  if (f) {
    try { fs.unlinkSync(join(FILES_DIR, f.path)); } catch { /* ignore */ }
    if (f.preview) { try { fs.unlinkSync(join(FILES_DIR, f.preview)); } catch { /* ignore */ } }
    run('DELETE FROM tank_files WHERE id=?', [f.id]); persist();
  }
  res.json({ ok: true });
});

// import a parts list (xlsx/csv/docx/pdf) into a type (mode=append default, or replace)
app.post('/api/tank-types/:id/import', upload.single('file'), async (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let parsed;
  try { parsed = await parseAny(req.file.buffer, req.file.originalname); } catch (e) { return res.status(400).json({ error: 'Could not read file: ' + e.message }); }
  if (!parsed.parts.length) return res.status(400).json({ error: 'No parts table found in this file. Need a table with at least an item code or description column.' });
  if (req.query.mode === 'replace') run('DELETE FROM template_parts WHERE tank_type_id=?', [tt.id]);
  const base = req.query.mode === 'replace' ? 0 : (get('SELECT MAX(no) m FROM template_parts WHERE tank_type_id=?', [tt.id])?.m || 0);
  parsed.parts.forEach((p, i) => run('INSERT INTO template_parts(id,tank_type_id,item_code,no,qty,description,default_phase) VALUES (?,?,?,?,?,?,?)',
    [uid(), tt.id, p.itemCode, p.no || base + i + 1, p.qty, p.description, p.defaultPhase]));
  persist();
  res.json({ imported: parsed.parts.length, headerMap: parsed.headerMap, detectedColumns: parsed.headers, type: tankTypeSummary(get('SELECT * FROM tank_types WHERE id=?', [tt.id])) });
});

// one-step: create a new type from a parts list (xlsx/csv/docx/pdf)
app.post('/api/tank-types/new-from-file', upload.single('file'), async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Type name is required' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let parsed;
  try { parsed = await parseAny(req.file.buffer, req.file.originalname); } catch (e) { return res.status(400).json({ error: 'Could not read file: ' + e.message }); }
  if (!parsed.parts.length) return res.status(400).json({ error: 'No parts table found in this file. Need a table with at least an item code or description column.' });
  const id = uid();
  run('INSERT INTO tank_types(id,name,description,created_at) VALUES (?,?,?,?)', [id, name, req.body?.description || '', now()]);
  parsed.parts.forEach((p, i) => run('INSERT INTO template_parts(id,tank_type_id,item_code,no,qty,description,default_phase) VALUES (?,?,?,?,?,?,?)',
    [uid(), id, p.itemCode, p.no || i + 1, p.qty, p.description, p.defaultPhase]));
  persist();
  res.json({ imported: parsed.parts.length, headerMap: parsed.headerMap, type: tankTypeSummary(get('SELECT * FROM tank_types WHERE id=?', [id])) });
});

// ── template part CRUD (in-app forms) ─────────────────────────
app.post('/api/tank-types/:id/parts', (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  const { itemCode = '', qty = 1, description = '', defaultPhase = '' } = req.body || {};
  const no = (get('SELECT MAX(no) m FROM template_parts WHERE tank_type_id=?', [tt.id])?.m || 0) + 1;
  const id = uid();
  run('INSERT INTO template_parts(id,tank_type_id,item_code,no,qty,description,default_phase) VALUES (?,?,?,?,?,?,?)',
    [id, tt.id, itemCode.trim(), no, qty, description.trim(), defaultPhase]);
  persist();
  res.json({ ok: true, id });
});
app.patch('/api/template-parts/:id', (req, res) => {
  if (!get('SELECT id FROM template_parts WHERE id=?', [req.params.id])) return res.status(404).json({ error: 'Not found' });
  applyPatch('template_parts', req.params.id, req.body, { itemCode: 'item_code', qty: 'qty', description: 'description', defaultPhase: 'default_phase', no: 'no' });
  res.json({ ok: true });
});
app.delete('/api/template-parts/:id', (req, res) => { run('DELETE FROM template_parts WHERE id=?', [req.params.id]); persist(); res.json({ ok: true }); });

// ── files (PDFs / images, matched by item code) ───────────────
function filesFor(tankTypeId, itemCode) {
  return all('SELECT id,filename,kind,size FROM part_files WHERE tank_type_id=? AND item_code=? ORDER BY filename', [tankTypeId, itemCode])
    .map((f) => ({ id: f.id, filename: f.filename, kind: f.kind, size: f.size, url: `/api/file/${f.id}` }));
}

// upload many files; match each to a template part by item code (filename = code)
app.post('/api/tank-types/:id/files', upload.array('files'), (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  const codes = all('SELECT DISTINCT item_code FROM template_parts WHERE tank_type_id=?', [tt.id]).map((r) => r.item_code).filter(Boolean);
  const codeByNorm = new Map(codes.map((c) => [normCode(c), c]));
  const destDir = join(FILES_DIR, tt.id);
  fs.mkdirSync(destDir, { recursive: true });

  const matched = [], unmatched = [];
  for (const f of req.files) {
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer mangles non-ascii
    const stem = basename(original, extname(original)).trim();
    const code = codeByNorm.get(normCode(stem));
    if (!code) { unmatched.push(original); continue; }
    const id = uid();
    const safe = `${id}${extname(original).toLowerCase()}`;
    fs.writeFileSync(join(destDir, safe), f.buffer);
    run('INSERT INTO part_files(id,tank_type_id,item_code,filename,kind,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, tt.id, code, original, fileKind(original), join(tt.id, safe), f.size, now()]);
    matched.push({ file: original, itemCode: code });
  }
  if (matched.length) logActivity('files', `Uploaded ${matched.length} file(s) to type "${tt.name}"`);
  persist();
  res.json({ matched: matched.length, unmatched, matchedDetail: matched, type: tankTypeSummary(get('SELECT * FROM tank_types WHERE id=?', [tt.id])) });
});

// attach uploaded files DIRECTLY to one part (its item code), no filename match.
// `code` comes via query string so item codes with slashes/spaces are safe.
app.post('/api/tank-types/:id/add-files', upload.array('files'), (req, res) => {
  const tt = get('SELECT * FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  const code = (req.query.code || '').toString().trim();
  if (!code) return res.status(400).json({ error: 'This part has no item code yet — set an item code first, then add files.' });
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  const destDir = join(FILES_DIR, tt.id);
  fs.mkdirSync(destDir, { recursive: true });
  let added = 0;
  for (const f of req.files) {
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer mangles non-ascii
    const id = uid();
    const safe = `${id}${extname(original).toLowerCase()}`;
    fs.writeFileSync(join(destDir, safe), f.buffer);
    run('INSERT INTO part_files(id,tank_type_id,item_code,filename,kind,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, tt.id, code, original, fileKind(original), join(tt.id, safe), f.size, now()]);
    added++;
  }
  logActivity('files', `Added ${added} file(s) to item ${code}`, { itemCode: code });
  persist();
  res.json({ ok: true, added });
});

// save a cropped image as a photo for an item code (attaches like any file)
function savePhoto(typeId, itemCode, buffer) {
  const destDir = join(FILES_DIR, typeId);
  fs.mkdirSync(destDir, { recursive: true });
  const id = uid();
  fs.writeFileSync(join(destDir, `${id}.png`), buffer);
  run('INSERT INTO part_files(id,tank_type_id,item_code,filename,kind,path,size,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, typeId, itemCode, `${itemCode || 'crop'} (crop).png`, 'image', join(typeId, `${id}.png`), buffer.length, now()]);
  logActivity('files', `Saved cropped photo`, { itemCode });
  persist();
  return id;
}
app.post('/api/parts/:id/photo', upload.single('file'), (req, res) => {
  const p = get('SELECT pa.item_code, t.tank_type_id FROM parts pa JOIN tanks t ON t.id=pa.tank_id WHERE pa.id=?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'Part not found' });
  if (!req.file) return res.status(400).json({ error: 'No image' });
  const id = savePhoto(p.tank_type_id, p.item_code, req.file.buffer);
  res.json({ ok: true, id, url: `/api/file/${id}` });
});
app.post('/api/tank-types/:id/photo', upload.single('file'), (req, res) => {
  const tt = get('SELECT id FROM tank_types WHERE id=?', [req.params.id]);
  if (!tt) return res.status(404).json({ error: 'Type not found' });
  if (!req.file) return res.status(400).json({ error: 'No image' });
  const id = savePhoto(tt.id, (req.body?.itemCode || '').trim(), req.file.buffer);
  res.json({ ok: true, id, url: `/api/file/${id}` });
});

app.get('/api/file/:id', (req, res) => {
  const f = get('SELECT * FROM part_files WHERE id=?', [req.params.id]);
  if (!f) return res.status(404).send('Not found');
  const abs = join(FILES_DIR, f.path);
  if (!fs.existsSync(abs)) return res.status(404).send('Missing file');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);
  res.sendFile(abs);
});
app.delete('/api/file/:id', (req, res) => {
  const f = get('SELECT * FROM part_files WHERE id=?', [req.params.id]);
  if (f) { try { fs.unlinkSync(join(FILES_DIR, f.path)); } catch { /* ignore */ } run('DELETE FROM part_files WHERE id=?', [f.id]); logActivity('files', `Deleted file "${f.filename}"`, { itemCode: f.item_code }); persist(); }
  res.json({ ok: true });
});

// ── options (editable dropdown values) ────────────────────────
// list values for one field with usage counts (for the manager UI)
app.get('/api/options/:field', (req, res) => {
  const field = req.params.field;
  if (!OPTION_FIELDS.has(field)) return res.status(400).json({ error: 'Unknown field' });
  const values = all('SELECT value,sort FROM options WHERE field=? ORDER BY sort', [field]).map((r) => ({
    value: r.value, sort: r.sort, inUse: countUsage(field, r.value), reserved: !!(RESERVED[field] && RESERVED[field].has(r.value)),
  }));
  res.json({ field, values });
});

// add a value (idempotent). Used both by the manager and by "remember assignee".
app.post('/api/options/:field', (req, res) => {
  const field = req.params.field; const value = (req.body?.value || '').trim();
  if (!OPTION_FIELDS.has(field)) return res.status(400).json({ error: 'Unknown field' });
  if (!value) return res.status(400).json({ error: 'Value required' });
  if (get('SELECT 1 x FROM options WHERE field=? AND value=?', [field, value])) return res.json({ ok: true });
  const sort = (get('SELECT MAX(sort) m FROM options WHERE field=?', [field])?.m || 0) + 1;
  run('INSERT INTO options(field,value,sort) VALUES (?,?,?)', [field, value, sort]);
  persist();
  res.json({ ok: true, options: optionsObject() });
});

// rename a value and propagate to every dependent row (one flush)
app.patch('/api/options/:field/rename', (req, res) => {
  const field = req.params.field;
  if (!OPTION_FIELDS.has(field)) return res.status(400).json({ error: 'Unknown field' });
  const from = (req.body?.from || '').trim(), to = (req.body?.to || '').trim();
  if (!from || !to) return res.status(400).json({ error: 'Both names are required' });
  if (RESERVED[field]?.has(from)) return res.status(409).json({ error: `"${from}" is a reserved value and can't be renamed` });
  if (!get('SELECT 1 x FROM options WHERE field=? AND value=?', [field, from])) return res.status(404).json({ error: 'Value not found' });
  if (from !== to && get('SELECT 1 x FROM options WHERE field=? AND value=?', [field, to])) return res.status(409).json({ error: `"${to}" already exists for this field` });
  const renamed = countUsage(field, from);
  tx(() => {
    for (const [tbl, col] of OPTION_TARGETS[field]) run(`UPDATE ${tbl} SET ${col}=? WHERE ${col}=?`, [to, from]);
    run('UPDATE options SET value=? WHERE field=? AND value=?', [to, field, from]);
    logActivity('options', `Renamed ${field} "${from}" → "${to}" (${renamed} row(s) updated)`);
  });
  res.json({ ok: true, renamed, options: optionsObject() });
});

// delete a value; blocked if in use unless a reassignTo is given
app.delete('/api/options/:field', (req, res) => {
  const field = req.params.field;
  if (!OPTION_FIELDS.has(field)) return res.status(400).json({ error: 'Unknown field' });
  const value = (req.body?.value || '').trim(), reassignTo = (req.body?.reassignTo || '').trim();
  if (!value) return res.status(400).json({ error: 'value required' });
  if (RESERVED[field]?.has(value)) return res.status(409).json({ error: `"${value}" is reserved and can't be deleted` });
  if (!get('SELECT 1 x FROM options WHERE field=? AND value=?', [field, value])) return res.status(404).json({ error: 'Value not found' });
  const inUse = countUsage(field, value);
  if (inUse > 0 && !reassignTo) return res.status(409).json({ error: 'In use', inUse });
  if (reassignTo && !get('SELECT 1 x FROM options WHERE field=? AND value=?', [field, reassignTo])) return res.status(400).json({ error: 'reassignTo is not a valid value' });
  tx(() => {
    if (reassignTo) for (const [tbl, col] of OPTION_TARGETS[field]) run(`UPDATE ${tbl} SET ${col}=? WHERE ${col}=?`, [reassignTo, value]);
    run('DELETE FROM options WHERE field=? AND value=?', [field, value]);
    logActivity('options', `Deleted ${field} "${value}"${reassignTo ? ` → reassigned to "${reassignTo}"` : ''}`);
  });
  res.json({ ok: true, options: optionsObject() });
});

// reorder values for a field
app.patch('/api/options/:field/reorder', (req, res) => {
  const field = req.params.field;
  if (!OPTION_FIELDS.has(field)) return res.status(400).json({ error: 'Unknown field' });
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  tx(() => { order.forEach((v, i) => run('UPDATE options SET sort=? WHERE field=? AND value=?', [i, field, v])); });
  res.json({ ok: true, options: optionsObject() });
});

// ── boot ──────────────────────────────────────────────────────
await initDb();
ensureSeeded();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚙  Tank Control (local) → http://localhost:${PORT}`);
  const ips = lanIPs();
  if (ips.length) console.log(`  on this network:        ${ips.map((ip) => `http://${ip}:${PORT}`).join('   ')}`);
  console.log(`  data: app.sqlite  ·  ${all('SELECT 1 FROM tank_types').length} tank type(s)${PW ? '  ·  🔒 password on' : ''}${AUTO_PW ? ` (auto: ${AUTO_PW})` : ''}\n`);
  // durability: back up shortly after boot, then on a schedule
  const everyH = Number(process.env.BACKUP_EVERY_HOURS) || 6;
  setTimeout(() => runBackup('startup'), 4000);
  if (everyH > 0) setInterval(() => runBackup('scheduled'), everyH * 3600 * 1000);
  if (TUNNEL_ON) startTunnel(PORT); // public link for people on other networks
  if (process.env.OPEN === '1' && process.platform === 'win32') exec(`start "" "http://localhost:${PORT}"`);
});
