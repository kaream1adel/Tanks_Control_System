# Updating the app without touching the data

The golden rule: **code lives in git, data never does.** `data/` and `backups/` are
git-ignored, so pulling new code can never change or delete your real data.

```
CODE  ──git push──►  GitHub (private)  ──git pull──►  Factory host (real data)
 ▲                                                          │
 └────────────── you develop & test elsewhere ─────────────┘
        (your own throwaway test data, never the real one)
```

## One-time: put the code on GitHub

On the **factory host** (this machine, which has the real data):

```
git init
git add .
git commit -m "Tank Control"
```
Then create a **private** repo on github.com and connect it:
```
git remote add origin https://github.com/<you>/tank-control.git
git branch -M main
git push -u origin main
```
(Your `data/`, `config.bat`, `node/`, `node_modules/` are ignored — only code is pushed.)

## You (another place) — develop & test safely

```
git clone https://github.com/<you>/tank-control.git
cd tank-control
npm install
npm start            # starts with an EMPTY data/ folder = test data only
```
You never see or affect the factory data. Make changes, then:
```
git add -A && git commit -m "what I changed" && git push
```

## Factory host — apply an update (data stays put)

Double-click **`Update App.bat`** (it runs `git pull` + `npm install`), then relaunch
**`Start Tank Control.bat`**. That's it — `data/` is untouched, and any new
data-structure changes apply automatically and additively on start.

> Backups still run automatically before/while the app is used, so even a bad
> update can't lose data — restore the newest `db-*.sqlite` from a backup folder.

## Why your settings survive updates

Per-machine settings (password, tunnel on/off, backup drives) live in **`config.bat`**,
which is git-ignored. The factory keeps its `config.bat`; your dev clone has its own
(or none). Updating code never overwrites them.

## Rules to avoid trouble

- **Only the host holds real data.** Don't run a second copy with its own data and expect them to merge — they won't.
- **Don't edit code directly on the host** (only `git pull`). Make changes on your dev clone and push, so pulls never conflict.
- If a pull ever conflicts because the host was edited, the safe reset is: `git stash` (or `git reset --hard origin/main`) — this only affects **code**, never your ignored `data/`.
