// One-time seeding: bring the exported Notion TEMPLATES (tank types + their
// parts checklist) and the option sets into the local DB. Tank orders are NOT
// migrated (user chose "templates only"). Safe to run repeatedly.
import fs from 'fs';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { initDb, run, get, all, persist } from './db.js';
import { SEED_PATH } from './paths.js';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const DEFAULT_OPTIONS = {
  status: ['Not Started', 'In Progress', 'Rework', 'Done', 'Blocked'],
  phase: ['Manefacturing', 'Welding', 'Sand Blast', 'Painting', 'Finish', 'Visual', 'Delivered'],
  priority: ['High', 'Normal', 'Low'],
  reworkReason: ['Wrong dimensions', 'Weld defect', 'Paint defect', 'Material flaw', 'Assembly error', 'Other'],
  tankStatus: ['Not Started', 'In Progress', 'On Hold', 'Done', 'Delivered'],
};

function seedOptions(seed) {
  if (get('SELECT COUNT(*) c FROM options').c > 0) return;
  const o = seed?.options || {};
  const fromSeed = (path) => path?.map((x) => x.name).filter(Boolean);
  const sets = {
    status: fromSeed(o.parts?.status) || DEFAULT_OPTIONS.status,
    phase: fromSeed(o.parts?.phase) || DEFAULT_OPTIONS.phase,
    reworkReason: fromSeed(o.parts?.reworkReason)?.length ? fromSeed(o.parts.reworkReason) : DEFAULT_OPTIONS.reworkReason,
    priority: fromSeed(o.instances?.priority) || DEFAULT_OPTIONS.priority,
    tankStatus: fromSeed(o.instances?.status) || DEFAULT_OPTIONS.tankStatus,
  };
  for (const [field, values] of Object.entries(sets)) {
    values.forEach((v, i) => run('INSERT INTO options(field,value,sort) VALUES (?,?,?)', [field, v, i]));
  }
  console.log('  seeded options:', Object.keys(sets).map((k) => `${k}(${sets[k].length})`).join(', '));
}

function seedTemplates(seed) {
  if (get('SELECT COUNT(*) c FROM tank_types').c > 0) return;
  const types = seed.types || [];
  for (const typeName of types) {
    const parts = (seed.templateParts || []).filter((p) => p.tankType === typeName);
    const typeId = uid();
    run('INSERT INTO tank_types(id,name,description,created_at) VALUES (?,?,?,?)', [typeId, typeName, '', now()]);
    let n = 0;
    for (const p of parts.sort((a, b) => (a.no || 0) - (b.no || 0))) {
      const code = (p.itemCode || '').trim();
      const desc = (p.description || '').trim();
      if (!code && !desc) continue; // skip empty stub rows
      run('INSERT INTO template_parts(id,tank_type_id,item_code,no,qty,description,default_phase) VALUES (?,?,?,?,?,?,?)',
        [uid(), typeId, code, p.no ?? null, p.qty ?? 1, desc, (p.defaultPhase || '').trim()]);
      n++;
    }
    console.log(`  seeded type "${typeName}" with ${n} parts`);
  }
}

// Backfill the "assignee" option set from any names already on parts, so the
// remembered-assignee picker shows existing data. Idempotent (NOT EXISTS guard).
function seedAssignees() {
  const names = all("SELECT DISTINCT TRIM(assigned_to) v FROM parts WHERE TRIM(assigned_to) <> ''").map((r) => r.v);
  let sort = (get("SELECT MAX(sort) m FROM options WHERE field='assignee'")?.m || 0);
  for (const name of names) {
    if (get("SELECT 1 x FROM options WHERE field='assignee' AND value=?", [name])) continue;
    run('INSERT INTO options(field,value,sort) VALUES (?,?,?)', ['assignee', name, ++sort]);
  }
}

export function ensureSeeded({ reset = false } = {}) {
  if (reset) {
    for (const t of ['parts', 'tanks', 'template_parts', 'tank_types', 'part_files', 'options']) run(`DELETE FROM ${t}`);
    console.log('  reset: cleared all tables');
  }
  let seed = {};
  if (fs.existsSync(SEED_PATH)) { try { seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8')); } catch { /* ignore */ } }
  seedOptions(seed);
  seedTemplates(seed);
  seedAssignees();
  persist();
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reset = process.argv.includes('--reset');
  await initDb();
  console.log(reset ? '\n  Re-seeding (reset)…' : '\n  Seeding (if empty)…');
  ensureSeeded({ reset });
  console.log('  done.\n');
}
