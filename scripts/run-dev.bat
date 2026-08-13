@echo off
rem (C) dev launcher — starts Pluto's Terminal in Tauri dev mode, logs to dev-out.log
cd /d C:\Users\pluto\plutos-terminals
echo [launcher] starting at %date% %time% > scripts\dev-out.log
where npm >> scripts\dev-out.log 2>&1
call npm run tauri dev >> scripts\dev-out.log 2>&1
echo [launcher] exited with code %errorlevel% at %date% %time% >> scripts\dev-out.log
pause
