@echo off
title Tank Control
cd /d "%~dp0"

rem ── Defaults (safe on any machine). Override per-machine in config.bat. ──
set OPEN=1
set PORT=4200
set BACKUP_DIRS=%~dp0backups
set BACKUP_EVERY_HOURS=6
set BACKUP_KEEP=30
set APP_PASSWORD=
set TUNNEL=0

rem Per-machine settings (password, backup drives, public link on/off) live in
rem config.bat, which git does NOT track — so updating the app never overwrites
rem them. Copy config.example.bat to config.bat and edit it.
if exist "%~dp0config.bat" call "%~dp0config.bat"

rem ── Check dependencies ────────────────────────────────────────────────────
if not exist "%~dp0node_modules\express\package.json" (
  echo.
  echo  node_modules not found.  Run "Setup.bat" first.
  echo.
  pause & exit /b 1
)

rem ── Run (prefer the bundled Node, else an installed Node) ──
if exist "%~dp0node\node.exe" (
  "%~dp0node\node.exe" src\server.js
  goto :end
)
where node >nul 2>nul
if %errorlevel%==0 (
  node src\server.js
  goto :end
)
echo.
echo  Node.js was not found.  Run "Setup.bat" first — it downloads Node automatically.
echo.
pause
:end
