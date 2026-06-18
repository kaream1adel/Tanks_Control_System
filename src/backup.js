// Durable backups. Each run writes a timestamped copy of the (small) SQLite DB
// and mirrors the part files into every configured target — typically a second
// drive/USB AND a synced cloud folder (Google Drive / OneDrive), so the data
// survives disk failure, ransomware, and mistakes.
//
// Configure targets with BACKUP_DIRS (semicolon-separated) in the launcher:
//   set BACKUP_DIRS=D:\TankBackups;C:\Users\karea\Google Drive\TankBackups
// Defaults to <app>\backups if unset.
import fs from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DB_PATH, FILES_DIR, ROOT } from './paths.js';

function targets() {
  const raw = process.env.BACKUP_DIRS || join(ROOT, 'backups');
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}
function stamp() {
  return new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
}
// keep only the most recent N db-*.sqlite snapshots per target
function prune(dir, keep) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^db-.*\.sqlite$/.test(f)).sort(); } catch { return; }
  for (let i = 0; i < files.length - keep; i++) { try { fs.rmSync(join(dir, files[i]), { force: true }); } catch { /* ignore */ } }
}
// part files are immutable (uuid names) → only copy what's missing
function mirrorFiles(src, dest) {
  let copied = 0;
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(join(src, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else { const d = join(dest, r); if (!fs.existsSync(d)) { fs.mkdirSync(join(dest, rel), { recursive: true }); fs.copyFileSync(join(src, r), d); copied++; } }
    }
  };
  fs.mkdirSync(dest, { recursive: true });
  walk('');
  return copied;
}

export function backupNow() {
  const s = stamp();
  const keep = Number(process.env.BACKUP_KEEP) || 30;
  const out = [];
  for (const base of targets()) {
    try {
      fs.mkdirSync(base, { recursive: true });
      if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, join(base, `db-${s}.sqlite`));
      prune(base, keep);
      const newFiles = mirrorFiles(FILES_DIR, join(base, 'files'));
      out.push({ dir: base, ok: true, newFiles });
    } catch (e) {
      out.push({ dir: base, ok: false, error: e.message });
    }
  }
  return { stamp: s, targets: out };
}

// CLI: `node src/backup.js` (or `npm run backup`) — back up without the server
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = backupNow();
  console.log(`\n  Backup ${r.stamp}`);
  for (const t of r.targets) console.log(t.ok ? `   ✓ ${t.dir}  (+${t.newFiles} new files)` : `   ✗ ${t.dir}: ${t.error}`);
  console.log('');
}
