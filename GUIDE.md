# Tank Control — Playbook & Data Safety

A short way-of-thinking for running the business in the app without ever losing data.
(The same content is in the app under **Guide**.)

## How the app is built

- **Tank Types** — reusable templates: the parts checklist + each part's PDF/photo. Build once per product (e.g. "32 MVA Ruwais").
- **Tanks** — real orders. Creating a tank **clones** the type's checklist into its own tracking rows.
- **Parts** — the live tracking (phase, status, quantities, rework, assignee) per tank, **isolated** from the template.
- **Follow-up** — daily work + weekly delivered quantities. **Reports** — the numbers. **Settings** — edit dropdown values + backups.

## 🛡 Golden rules — never lose data

1. **One host, many viewers.** ONE PC runs the app; everyone else opens its address (LAN or Tailscale). **Never copy the folder to a second PC and run both** — that makes two separate databases that drift apart.
2. **Backups are automatic** — on start, every 6 hours, and on demand (Settings → *Backup now*). Point **one** target at a **USB / second drive** and **one** at a **synced cloud folder** (Google Drive / OneDrive). Confirm "last backup" in Settings.
3. **Never hand-edit** the `data` folder while the app is running.
4. **Restore** = copy the newest `db-…sqlite` backup to `data/app.sqlite` and the backup's `files` folder back into `data/files`. Backups are timestamped, so you can return to any point.

## Daily way of working (rule of thumb)

1. **Morning:** Follow-up → pick the tank → today's date. Use the **phase filter** to work one stage at a time (e.g. everything in *Welding*).
2. For each part: set **Phase** and **Status**, add a short **Note**, and when units actually ship enter **Deliver qty** → **Save day**.
3. **Status flow:** Not Started → In Progress → (Rework if a defect) → Done. Mark **Delivered** only when it leaves to the customer.
4. **Weekly:** Follow-up → Weekly rollup shows quantity delivered per week; **⤓ CSV** exports `No, item code, delivered qty`.

## Scenario playbook

| Scenario | Do this |
|---|---|
| **New product** | Tank Types → *New from spreadsheet* (or Blank + Add parts) → *Upload files* (PDFs/images named by item code) → open a part's 📎 → **Crop & save** the 3D view as its photo. |
| **New order** | New Tank → pick the type → the checklist clones automatically. |
| **A part fails QC** | Status = **Rework**, bump **Rework count**, choose a reason → shows in Reports → Rework. |
| **Partial delivery** | Ship some now via **Deliver qty**; the remaining units keep moving through phases. Weekly rollup sums what was delivered. |
| **Fix a phase/status name** | Settings → Rename — updates every part using it. **Don't rename Done/Delivered** (reserved by the completion math). |
| **Edit one tank only** | Change a part's code/name/qty in the Parts table — affects **only that tank**, never the template. |
| **Customer parts list** | Tank Types → open the type → **📊 Export Excel** (cropped photos embedded, same layout as your sheet). |
| **"Who changed what?"** | Reports → **Recent activity** — every change, delivery, file and rename is logged (with a filter box). |

## Working from more than one place

The host PC stays on; the second place connects to it (Tailscale — see `DEPLOY.md`). Both edit the **same** database, so there's a single source of truth and no loss. Edits made anywhere appear on the other screens within **~3 seconds** automatically. Hit **Refresh** (sidebar) for an instant pull.

## If something looks off

1. Click **Refresh** (sidebar) to pull the latest.
2. Check **Reports → Recent activity** to see what changed and when.
3. Worst case, **restore the latest backup** (Golden rule 4).
