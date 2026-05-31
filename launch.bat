@echo off
title openMCPWEBLOCK
cd /d "c:\Users\marco\Gits\openMCPWEBLOCK"

echo ============================================
echo   openMCPWEBLOCK - Starting...
echo ============================================
echo.

:: Refresh PATH
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USRPATH=%%b"
set "PATH=%SYSPATH%;%USRPATH%"

:: Build and run
echo [1/2] Building project...
call bun run build
if %errorlevel% neq 0 (
    echo.
    echo BUILD FAILED. Press any key to exit...
    pause >nul
    exit /b 1
)

echo.
echo [2/2] Launching openMCPWEBLOCK...
echo.
node dist/cli.mjs

pause
