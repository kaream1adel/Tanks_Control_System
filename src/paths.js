// Central place for all on-disk locations. Everything lives under the app
// folder so the whole thing is portable: copy the folder, run, done.
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const DATA_DIR = join(ROOT, 'data');
export const FILES_DIR = join(DATA_DIR, 'files');     // part PDFs / images live here
export const PUBLIC_DIR = join(ROOT, 'public');
export const DB_PATH = join(DATA_DIR, 'app.sqlite');
export const SEED_PATH = join(DATA_DIR, 'seed-templates.json');

// sql.js ships its wasm in node_modules; this resolves it in dev and when the
// node_modules folder travels alongside a bundled runtime.
export const SQLJS_WASM_DIR = join(ROOT, 'node_modules', 'sql.js', 'dist');

export function ensureDirs() {
  for (const d of [DATA_DIR, FILES_DIR]) fs.mkdirSync(d, { recursive: true });
}
