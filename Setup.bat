@echo off
title Tank Control - First-time Setup
cd /d "%~dp0"

echo.
echo  Tank Control  ^|  First-time Setup
echo  ====================================
echo.

rem ─── Step 1: Node.js ─────────────────────────────────────────────────────

if exist "%~dp0node\node.exe" (
  echo  [OK] node\node.exe found.
  goto :deps
)

where node >nul 2>nul
if %errorlevel%==0 (
  echo  [OK] System Node.js found.
  goto :deps
)

echo  node\node.exe not found.
echo  Downloading Node.js 20 LTS portable...  (~28 MB)
echo.

set "NODEVER=v20.18.0"
set "NODEBASE=node-%NODEVER%-win-x64"
set "NODEURL=https://nodejs.org/dist/%NODEVER%/%NODEBASE%.zip"
set "NODEZIP=%TEMP%\tc_node20.zip"
set "NODETMP=%TEMP%\tc_node20_x"

mkdir "%~dp0node" 2>nul
curl.exe -# -L -o "%NODEZIP%" "%NODEURL%"
if %errorlevel% neq 0 (
  echo.
  echo  [ERROR] Download failed. Check your internet connection.
  echo  Or: copy the "node" folder from the original Tank Control
  echo  machine and paste it here next to this .bat file.
  echo.
  pause & exit /b 1
)

echo  Extracting...
powershell -NoProfile -Command "Expand-Archive -LiteralPath '%NODEZIP%' -DestinationPath '%NODETMP%' -Force; Get-ChildItem -Path '%NODETMP%\%NODEBASE%' | ForEach-Object { Copy-Item $_.FullName -Destination '%~dp0node' -Recurse -Force }; Remove-Item '%NODETMP%','%NODEZIP%' -Recurse -Force -ErrorAction SilentlyContinue"

if not exist "%~dp0node\node.exe" (
  echo.
  echo  [ERROR] Extraction failed. Run Setup.bat again.
  pause & exit /b 1
)
echo  [OK] Node.js %NODEVER% installed to node\

rem ─── Step 2: npm install ─────────────────────────────────────────────────

:deps
if exist "%~dp0node_modules\express\package.json" (
  echo  [OK] node_modules already present.
  goto :done
)

echo  Installing npm packages (express, exceljs, sql.js, ...)
if exist "%~dp0node\npm.cmd" (
  call "%~dp0node\npm.cmd" install
) else (
  npm install
)
if %errorlevel% neq 0 (
  echo.
  echo  [ERROR] npm install failed. See error above.
  pause & exit /b 1
)
echo  [OK] Packages installed.

:done
echo.
echo  ====================================
echo   Setup complete!
echo   Run "Start Tank Control.bat" now.
echo  ====================================
echo.
pause
