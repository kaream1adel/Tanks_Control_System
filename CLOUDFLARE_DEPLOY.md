# Tank Control: deploying on Cloudflare

This plan moves the **whole app** to Cloudflare. The site runs 24/7 at a permanent address, even when your PC is off. **Code changes are made only on your PC** and pushed to the live site. All data lives in one place, the cloud, so every user sees the same thing.

> Status: **plan agreed, not built yet.** Sections marked ⏳ are decisions still open.

---

## 1. Decisions taken

| Topic | Decision |
|---|---|
| Hosting | Fully on Cloudflare (free plan): no PC needed to keep the site online |
| Server | **Cloudflare Workers** (the Express server is rewritten as a Worker, same API routes) |
| Database | **D1**: Cloudflare's SQLite, same tables and SQL as `data/app.sqlite` |
| Part files (PDF/images) | **Workers KV**: **no card needed**, 1 GB free, max 25 MB per file |
| Address | `https://tank-control.<your-account>.workers.dev`: permanent, no domain needed (a custom domain can be added later) |
| Who changes code | Only your PC. Edit → test locally → `Deploy App.bat` |
| Who changes data | Anyone with the **Editor** link + password; **Viewer** link + password = read-only (same as today) |
| Single source of truth | After migration, **the Cloudflare copy is the only real data**. The local app is no longer used for data entry |
| `data/` folder | Still **never committed to git** (database, files, dumps and migration batches all stay out of git) |

### Why KV for files (and not R2 or D1)
- Current files: **381 files, 77 MB**, mostly PDFs under 1 MB; only 2 files over 2 MB (largest 2.7 MB).
- KV: no card, 1 GB (about 13× today's size), 25 MB per file. Files are written once and read many times, which is exactly what KV is built for.
- R2 needs a card on file (free up to 10 GB). It's only worth it later, if files grow to several GB. Moving KV → R2 is a single copy job.
- D1 blobs are limited to 2 MB per value and would share the 500 MB database limit. Rejected.

---

## 2. Free-plan limits (and how the app stays inside them)

| Service | Free limit | Our usage / mitigation |
|---|---|---|
| Workers requests | 100,000 / day | Live sync polls every **10 s** (was 3 s) and **pauses when the tab is hidden**. Static files don't count. |
| Workers CPU | **10 ms per request** | Heavy work (Word/PDF/Excel **import** and **Excel export**) moves **into the browser** |
| D1 size | 500 MB per database | Database is about 0.4 MB today |
| D1 reads / writes | 5 M rows read, 100k rows written / day | Sync check reads **one row** (a `meta` version counter), not whole tables |
| KV storage | 1 GB, 25 MB per value | Photos are **auto-compressed in the browser on upload** (2–5 MB → ~300–500 KB); PDFs untouched |
| KV writes | 1,000 / day | One write per uploaded file. More than enough |
| KV consistency | New key may take up to ~60 s to appear in other regions | Files have unique IDs and are never changed after upload, so no conflicts. Part data (qty/status) is in D1 and appears for everyone at once |

---

## 3. What changes, feature by feature

| Feature | On Cloudflare |
|---|---|
| Tanks, parts, Delivered/Not Delivered, delivered qty | Ported 1:1 (same rules: qty = total → Delivered, toggle Delivered → qty = total) |
| Daily follow-up + weekly rollup | Ported 1:1 (day-total semantics, clamp to remaining) |
| Reports, overview, settings/options, tank types, templates | Ported 1:1 |
| File viewer (PDF/images, crop, preview) | Same UI; files served from KV via `/api/file/:id` |
| Import Excel / `.docx` / PDF | Parsing moves **into the browser** (SheetJS, mammoth, pdf.js browser builds). The parsed rows are sent to the API |
| Import old **`.doc` (Word 97)** | ⏳ **Not possible on Cloudflare** (Node-only library). Default: save as `.docx` first. *Open: confirm whether `.doc` is still used.* |
| Excel / Word / print exports | Excel built **in the browser** (ExcelJS browser build); Word/print HTML stays server-side (light) |
| Share page | Tunnel on/off button **removed** (site is always online). Editor/Viewer links + QR **always shown**, permanent, password-protected |
| Passwords | Editor/Viewer passwords stored **hashed in D1**, still changeable from the Share page (editor only) |
| Login | Required for every visitor (public internet). **Login rate-limit** (5 wrong tries → wait) |
| Backups | Replaced by **D1 Time Travel** (built-in 30-day restore, free) + **"Download backup"** button (zip of database + all files to your PC) |
| Live sync | `/api/version` every 10 s, paused when hidden |

---

## 4. One-time setup (on your PC)

### 4.1 Prerequisites
- Your Cloudflare account (the same one used for the A&M website).
- Node.js (the portable Node at `C:\Users\karea\node20` works).
- **No card needed** (KV, not R2).

### 4.2 Install the Cloudflare CLI and sign in
```bash
npm install -D wrangler
```
```bash
npx wrangler login
```
A browser window opens: **you** sign in and click *Allow* (Claude never enters your password).

### 4.3 Create the database and the file store
```bash
npx wrangler d1 create tank-control
```
```bash
npx wrangler kv namespace create FILES
```
Each command prints an **id**. Copy the ids into `wrangler.toml` (next step).

### 4.4 `wrangler.toml` (project root)
```toml
name = "tank-control"
main = "worker/index.js"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./public"      # UI files (contain no data)
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "tank-control"
database_id = "<id from d1 create>"

[[kv_namespaces]]
binding = "FILES"
id = "<id from kv namespace create>"
```

### 4.5 Secrets (never written in any file)
```bash
npx wrangler secret put COOKIE_SECRET
```
Type a long random value when asked. The first Editor/Viewer passwords are set on first login and can be changed later from the Share page.

---

## 5. Code structure after the port

```
tank-control-local/
├─ public/              UI (unchanged look; import/export moved into the browser)
├─ worker/
│  ├─ index.js          router (all /api/* routes, /m/:mode, /login, /logout)
│  ├─ db.js             D1 helpers: all/get/run (async), tx → DB.batch()
│  ├─ files.js          KV put/get/delete + metadata (name, type, size)
│  └─ auth.js           cookie signing, Editor/Viewer levels, rate-limit
├─ migrations/          D1 schema (same tables as today + meta + access)
├─ scripts/
│  ├─ export-db.mjs     app.sqlite → SQL dump (for D1 import)
│  └─ export-files.mjs  data/files → KV bulk batches (< 90 MB each)
├─ src/                 old local server (kept for reference / offline fallback)
├─ wrangler.toml
└─ Deploy App.bat
```

Key porting rules:
- `sql.js` sync calls → `await env.DB.prepare(sql).bind(...).all()/first()/run()`.
- `tx(() => …)` → collect statements → `env.DB.batch([...])` (atomic).
- `multer` uploads → `await request.formData()` → bytes to KV (`FILES.put(id, bytes, { metadata })`).
- `dataVersion()` → one-row `meta(version)` table, bumped on every write.
- View-only enforcement stays **server-side**: any non-GET from a `view` session → 403.

---

## 6. Test locally first (your real data is never touched)

```bash
npx wrangler d1 migrations apply tank-control --local
```
```bash
node scripts/export-db.mjs
```
```bash
npx wrangler d1 execute tank-control --local --file=data/migrate/dump.sql
```
```bash
npx wrangler dev
```
Open `http://localhost:8787` and check every page (tanks, parts toggle ↔ qty, daily, weekly, reports, files, import, export, share, view-only).

> The dump and KV batches are written to `data/migrate/`, inside `data/`, so **git ignores them**. Also add `.wrangler/` to `.gitignore`.

---

## 7. First deploy + data migration (one time)

1. **Stop entering data** in the local app (from this moment the cloud becomes the truth).
2. Export the latest data:
   ```bash
   node scripts/export-db.mjs
   ```
   ```bash
   node scripts/export-files.mjs
   ```
3. Create tables and import the data into the cloud database:
   ```bash
   npx wrangler d1 migrations apply tank-control --remote
   ```
   ```bash
   npx wrangler d1 execute tank-control --remote --file=data/migrate/dump.sql
   ```
4. Upload the files (one command per batch file the script made):
   ```bash
   npx wrangler kv bulk put data/migrate/kv-batch-1.json --binding FILES --remote
   ```
5. Deploy the app:
   ```bash
   npx wrangler deploy
   ```
6. Verify on the live address: counts of tanks/parts match, a few PDFs open, Editor and Viewer links work, viewer can't edit.
7. Share the new Editor/Viewer links (QR on the Share page). Retire the old `trycloudflare.com` links.

---

## 8. Updating the app later (code only)

`Deploy App.bat` (project root):
```bat
@echo off
cd /d %~dp0
call npx wrangler deploy
pause
```
Workflow: edit code on your PC → test with `npx wrangler dev` → commit + push to GitHub → double-click **Deploy App.bat**. The live site updates in seconds; **data is never touched** by a deploy. If the database schema changes, run `npx wrangler d1 migrations apply tank-control --remote` before deploying.

---

## 9. Backup & restore

- **Automatic:** D1 Time Travel keeps 30 days of history.
  ```bash
  npx wrangler d1 time-travel info tank-control
  ```
  ```bash
  npx wrangler d1 time-travel restore tank-control --timestamp=2026-10-20T12:00:00Z
  ```
- **Manual:** Settings → **Download backup** → one zip (database + all files) saved to your PC. Recommended weekly.
- KV files have no time travel, so the download-backup zip is their safety copy.

---

## 10. Rollback plan
- Bad code deploy → `npx wrangler rollback` (returns to the previous version instantly).
- Bad data change → D1 Time Travel restore (section 9).
- Cloudflare unusable → the old local app (`src/`) still works from the latest Download-backup zip.

---

## 11. Build order (each step tested before the next)

1. **Server port:** Worker + D1 + KV with all API routes, tested locally on a **copy** of the data.
2. **Browser-side import/export** + photo compression on upload.
3. **Share, login rate-limit, backup download** adapted.
4. **First deploy + data migration** (section 7), after a final check with you.

## 12. Open items ⏳
- Is old **`.doc`** import still needed? (Default: no, convert to `.docx`.)
- Custom domain later? (Optional, ~$10/year; `workers.dev` works fine meanwhile.)
