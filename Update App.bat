@echo off
title Tank Control - Update App
cd /d "%~dp0"

echo.
echo  Pulling latest code...
echo  (Your data folder is git-ignored and will NOT be touched.)
echo.

git pull
if errorlevel 1 (
  echo.
  echo  [ERROR] git pull failed.
  echo  Make sure git is installed and this folder is a proper clone.
  pause & goto :eof
)

rem ── Re-run npm install in case new packages were added ──
if exist "%~dp0node\npm.cmd" (
  call "%~dp0node\npm.cmd" install
) else (
  where npm >nul 2>nul
  if %errorlevel%==0 ( call npm install )
)

echo.
echo  Done. Close "Start Tank Control" if it is running,
echo  then double-click it again to launch the new version.
echo.
pause
