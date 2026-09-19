@echo off
rem (C) Run any cargo command with the toolchain this repo needs on Windows
rem (Strawberry Perl for the vendored OpenSSL build, MSVC vcvars64).
rem   scripts\cargo-win.cmd test sync_git
rem   scripts\cargo-win.cmd clippy
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "PATH=C:\Strawberry\perl\bin;C:\Strawberry\perl\site\bin;C:\Strawberry\c\bin;%PATH%"
cd /d "%~dp0..\src-tauri"
cargo %*
exit /b %ERRORLEVEL%
