@echo off
title openMCPWEBLOCK
cd /d "%~dp0"

echo ============================================
echo   openMCPWEBLOCK - Starting...
echo ============================================
echo.

:: Refresh PATH
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USRPATH=%%b"
set "PATH=%SYSPATH%;%USRPATH%"

:: Build and run
echo [1/3] Building project...
call bun run build
if %errorlevel% neq 0 (
    echo.
    echo BUILD FAILED. Press any key to exit...
    pause >nul
    exit /b 1
)

:: Ensure MCP Server for SuperAssistant is running on port 3006
echo.
echo [2/3] Checking SuperAssistant MCP Server (port 3006)...
netstat -ano | findstr ":3006" | findstr "LISTENING" >nul 2>&1
if %errorlevel% neq 0 (
    echo       Starting MCP server on http://localhost:3006...
    if not exist logs mkdir logs
    start /b bun run scripts/start-mcp-server.ts > logs\mcp-server.stdout.log 2> logs\mcp-server.stderr.log
    timeout /t 2 /nobreak >nul
    echo       MCP server active and ready for SuperAssistant.
) else (
    echo       MCP server is already running on port 3006.
)

echo.
echo [3/3] Launching openMCPWEBLOCK...
echo.
node dist/cli.mjs

pause
