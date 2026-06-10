@echo off
rem (C) kills whatever holds the vite dev port 5310 (stale dev session), tree-kill
cd /d C:\Users\pluto\plutos-terminals\scripts
echo [cleanup] %date% %time% > cleanup-out.log
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5310" ^| findstr "LISTENING"') do (
  echo killing PID tree %%p >> cleanup-out.log
  taskkill /F /T /PID %%p >> cleanup-out.log 2>&1
)
echo [cleanup] done >> cleanup-out.log
exit
