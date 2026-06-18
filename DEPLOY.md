# Deploy — persistent, durable, reliable

Your data is two things on disk inside this folder:

- `data/app.sqlite` — the database
- `data/files/` — every part PDF / image

Keep **one** running copy of the app (one machine = one database). Both places
connect to that same machine, so there's a single source of truth. Running two
separate copies would split your data — don't do that.

---

## 1. Run it (the host machine)

Double‑click **`Start Tank Control.bat`**. It prints, e.g.:

```
⚙  Tank Control (local) → http://localhost:4200
on this network:        http://192.168.1.50:4200
```

- On the **host** open `http://localhost:4200`.
- Other devices **on the same Wi‑Fi/LAN** open the `192.168.x.x` address.

Leave the window open while people use it. (You chose to launch manually — no
auto‑start service.)

## 2. Access from a 2nd place (recommended: Tailscale)

To reach the host from another location securely, without exposing it to the
public internet, use a private network:

1. Make a free account at **tailscale.com**.
2. Install Tailscale on the **host PC** and on the device(s) at the **2nd place**; sign in to the same account on all of them.
3. On the host, Tailscale shows an IP like `100.x.y.z`. From the 2nd place open
   `http://100.x.y.z:4200`. Works from anywhere, encrypted, only your devices.

**Turn on the password** first (so it's private even on Tailscale): edit
`Start Tank Control.bat` and set `set APP_PASSWORD=yourpassword`, then restart.

> Alternative — a public URL: a **Cloudflare Tunnel** (`cloudflared`) can expose
> `http://localhost:4200` at an `https://…` address. If you go public, the
> `APP_PASSWORD` is mandatory (or add Cloudflare Access).

## 3. Backups (durability)

Configured in `Start Tank Control.bat`:

```
set BACKUP_DIRS=D:\TankBackups;C:\Users\karea\Google Drive\TankBackups
set BACKUP_EVERY_HOURS=6
set BACKUP_KEEP=30
```

- Point **one** target at a **USB / second drive** and **one** at a **synced
  cloud folder** (Google Drive / OneDrive) so a copy goes off‑site automatically.
- The app backs up **on startup, every 6 hours, and on demand** (Settings →
  **Backup now**). Each run saves a timestamped `db-…sqlite` (keeps the last 30)
  and mirrors any new files.
- Run one without the app: `npm run backup` (or `node src\backup.js`). You can
  schedule that in Windows Task Scheduler if you ever close the app for long.

## 4. Restore (if a machine dies)

1. Install the folder on the new machine (copy it, or re‑clone + bundled Node).
2. From your newest backup, copy:
   - `db-<latest>.sqlite` → `data\app.sqlite`
   - the backup's `files\` → `data\files\`
3. Start the app. Done.

## 5. Moving to a 2nd PC

Copy the whole folder (you can skip `node_modules` and re‑run `npm install`),
copy `data/` for your live data, then `Start Tank Control.bat`. Because there's
one host, prefer **connecting** the 2nd PC to the host (section 2) over copying —
copying makes a separate, diverging database.
