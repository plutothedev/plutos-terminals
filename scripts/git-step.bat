@echo off
rem (C) git inspection step — status + real diff stats, logged
cd /d C:\Users\pluto\plutos-terminals
echo [git] %date% %time% > scripts\git-out.log
echo === config === >> scripts\git-out.log
git config core.autocrlf >> scripts\git-out.log 2>&1
git branch --show-current >> scripts\git-out.log 2>&1
echo === status (porcelain) === >> scripts\git-out.log
git status --porcelain >> scripts\git-out.log 2>&1
echo === diff stat === >> scripts\git-out.log
git diff --stat >> scripts\git-out.log 2>&1
echo [git] done >> scripts\git-out.log
exit
