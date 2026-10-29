@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install it from https://nodejs.org/ 1>&2
  exit /b 1
)
node "%~dp0install.js" %*
exit /b %errorlevel%
