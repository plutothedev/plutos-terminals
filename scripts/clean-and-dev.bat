@echo off
rem (C) full dev cycle: kill stale app/dev processes, free port 5310, launch tauri dev
cd /d C:\Users\pluto\plutos-terminals
echo [cycle] start %date% %time% > scripts\dev-out.log

rem kill any running app instances (prod or dev) — they lock target\debug\plutos-terminals.exe
taskkill /F /T /IM plutos-terminals.exe >> scripts\dev-out.log 2>&1

rem kill any stale cargo/tauri watchers from earlier runs
taskkill /F /IM cargo.exe >> scripts\dev-out.log 2>&1

rem free the vite port if something still holds it
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5310" ^| findstr "LISTENING"') do (
  taskkill /F /T /PID %%p >> scripts\dev-out.log 2>&1
)

echo [cycle] cleanup done, launching dev... >> scripts\dev-out.log
call npm run tauri dev >> scripts\dev-out.log 2>&1
echo [cycle] exited with code %errorlevel% at %date% %time% >> scripts\dev-out.log
pause
