@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can cai Node.js LTS tu https://nodejs.org
  echo Sau do trong thu muc nay chay: npm install
  pause
  exit /b 1
)
call npm start
