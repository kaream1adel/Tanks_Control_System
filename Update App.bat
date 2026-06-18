@echo off
title Tank Control - Update App
cd /d "%~dp0"
echo.
echo  Updating the APP code only. Your data (database + files) is git-ignored
echo  and will NOT be touched.
echo.
git pull
if errorlevel 1 (
  echo.
  echo  git pull failed. Make sure git is installed and this folder is a clone.
  pause
  goto :eof
)
where npm >nul 2>nul
if %errorlevel%==0 (
  echo  Installing any new dependencies...
  call npm install
) else (
  echo  ^(Skipped npm install - npm not on PATH. If a big update wont start,
  echo   run "npm install" once with Node.js installed.^)
)
echo.
echo  Done. Close the running app window, then double-click "Start Tank Control.bat".
pause
