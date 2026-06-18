// Pure-JS SQLite (sql.js / WASM). No native module → never breaks when the
// app folder is copied to another PC. The DB lives entirely in memory and is
// flushed to data/app.sqlite after every mutation.
import initSqlJs from 'sql.js';
import fs from 'fs';
import { DB_PATH, SQLJS_WASM_DIR, ensureDirs } from './paths.js';
import { join } from 'path';

let db = null;
let SQL = null;
let _version = 0; // bumps on every persisted write, for cheap change-detection
export const dataVersion = () => _version;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tank_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE IF NOT EXISTS template_parts (
  id TEXT PRIMARY KEY, tank_type_id TEXT NOT NULL, item_code TEXT DEFAULT '',
  no INTEGER, qty INTEGER DEFAULT 1, description TEXT DEFAULT '', default_phase TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS part_files (
  id TEXT PRIMARY KEY, tank_type_id TEXT NOT NULL, item_code TEXT NOT NULL,
  filename TEXT, kind TEXT, path TEXT, size INTEGER, created_at TEXT
);
CREATE TABLE IF NOT EXISTS tanks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT DEFAULT '',
  tank_type_id TEXT, tank_type_name TEXT DEFAULT '',
  status TEXT DEFAULT 'Not Started', priority TEXT DEFAULT 'Normal',
  start_date TEXT, delivery_date TEXT, notes TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY, tank_id TEXT NOT NULL, item_code TEXT DEFAULT '',
  no INTEGER, qty_total INTEGER DEFAULT 1, qty_done INTEGER DEFAULT 0,
  description TEXT DEFAULT '', phase TEXT DEFAULT '', status TEXT DEFAULT 'Not Started',
  rework_count INTEGER DEFAULT 0, rework_reason TEXT DEFAULT '',
  assigned_to TEXT DEFAULT '', notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS options (
  field TEXT NOT NULL, value TEXT NOT NULL, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS part_logs (
  id TEXT PRIMARY KEY, part_id TEXT NOT NULL, tank_id TEXT NOT NULL,
  log_date TEXT NOT NULL, qty_done_today INTEGER DEFAULT 0,
  status TEXT DEFAULT '', phase TEXT DEFAULT '', note TEXT DEFAULT '', created_at TEXT
);
CREATE TABLE IF NOT EXISTS part_events (
  id TEXT PRIMARY KEY, part_id TEXT NOT NULL, tank_id TEXT NOT NULL,
  field TEXT NOT NULL, old_value TEXT DEFAULT '', new_value TEXT DEFAULT '', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, part_id TEXT NOT NULL, tank_id TEXT NOT NULL,
  qty INTEGER DEFAULT 0, delivered_date TEXT NOT NULL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, category TEXT DEFAULT '',
  tank_name TEXT DEFAULT '', item_code TEXT DEFAULT '', summary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_parts_tank ON parts(tank_id);
CREATE INDEX IF NOT EXISTS idx_tpl_type ON template_parts(tank_type_id);
CREATE INDEX IF NOT EXISTS idx_files_key ON part_files(tank_type_id, item_code);
CREATE INDEX IF NOT EXISTS idx_logs_tank_date ON part_logs(tank_id, log_date);
CREATE INDEX IF NOT EXISTS idx_logs_part ON part_logs(part_id);
CREATE INDEX IF NOT EXISTS idx_events_at ON part_events(at);
CREATE INDEX IF NOT EXISTS idx_events_part ON part_events(part_id);
CREATE INDEX IF NOT EXISTS idx_deliv_tank ON deliveries(tank_id);
CREATE INDEX IF NOT EXISTS idx_deliv_date ON deliveries(delivered_date);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
`;

export async function initDb() {
  ensureDirs();
  if (!SQL) SQL = await initSqlJs({ locateFile: (f) => join(SQLJS_WASM_DIR, f) });
  const bytes = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  db.run(SCHEMA);
  migrate();
  persist();
  return db;
}

// add a column to an existing table only if it isn't there yet (guarded so
// re-runs never throw "duplicate column name"). The only safe way to extend a
// table that already holds live rows — CREATE TABLE IF NOT EXISTS is a no-op.
function addColumnIfMissing(table, col, decl) {
  const cols = all(`PRAGMA table_info(${table})`).map((r) => r.name);
  if (!cols.includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

function migrate() {
  addColumnIfMissing('parts', 'delivered_at', 'TEXT');
  addColumnIfMissing('parts', 'delivered_qty', 'INTEGER DEFAULT 0'); // cumulative units delivered (partial delivery)
  // stamp the migration moment once so reports can flag pre-migration (estimated) history
  if (!get("SELECT v FROM meta WHERE k='migrated_at'")) {
    run("INSERT INTO meta(k,v) VALUES ('migrated_at', ?)", [new Date().toISOString()]);
  }
  // best-effort backfill: any already-delivered part gets a delivered_at
  // (real tank delivery date if known, else the migration time). Idempotent — NULLs only.
  run(`UPDATE parts SET delivered_at = COALESCE(
         (SELECT t.delivery_date FROM tanks t WHERE t.id = parts.tank_id),
         (SELECT v FROM meta WHERE k='migrated_at'))
       WHERE delivered_at IS NULL AND (status IN ('Done','Delivered') OR phase = 'Delivered')`);
}

// flush the in-memory DB to disk (called after every write). Atomic: write a
// temp file then rename over the real one, so a crash mid-write can never leave
// a half-written / corrupt app.sqlite.
export function persist() {
  if (!db) return;
  _version++;
  const data = Buffer.from(db.export());
  const tmp = `${DB_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, DB_PATH); // atomic replace on the same volume
  } catch {
    fs.writeFileSync(DB_PATH, data); // fallback: never block a save
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// ── query helpers (synchronous, sql.js style) ─────────────────
export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
export function get(sql, params = []) { return all(sql, params)[0] || null; }
export function run(sql, params = []) { db.run(sql, params); }

// run several writes, then flush once
export function tx(fn) { const r = fn(); persist(); return r; }

export function rawExport() { return Buffer.from(db.export()); }
