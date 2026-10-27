@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed: https://nodejs.org & pause & exit /b 1)
if not exist node_modules call npm install
echo Building the latest Starsky...
call npm run build || (pause & exit /b 1)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8095 .*LISTENING"') do taskkill /F /PID %%p >nul 2>nul
start "" http://127.0.0.1:8095
node serve.mjs 8095
pause
