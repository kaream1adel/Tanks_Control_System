rem ─── Tank Control — per-machine settings ──────────────────────────────
rem Copy this file to  config.bat  (same folder) and edit it.
rem config.bat is PRIVATE (git ignores it), so updating the app never changes
rem your password, backup drives, or tunnel setting.

rem Password to open the app. Leave blank WITH TUNNEL=1 and the app
rem auto-generates one and shows it on the Share page.
set APP_PASSWORD=

rem Public link for people on other networks (Cloudflare Tunnel). 1 = on, 0 = off.
rem First run downloads cloudflared (~50MB) once; the Share tab shows the link.
set TUNNEL=1

rem Backups copied here (separate multiple with ; ). Point one at a USB / second
rem drive and one at a synced cloud folder (Google Drive / OneDrive):
rem set BACKUP_DIRS=D:\TankBackups;C:\Users\you\Google Drive\TankBackups
set BACKUP_DIRS=%~dp0backups
