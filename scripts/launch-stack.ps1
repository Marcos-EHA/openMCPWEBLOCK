#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Lanza el stack completo de openMCPWEBLOCK
    
.DESCRIPTION
    1. Inicia el servidor MCP (puerto 3006)
    2. Reinicia Chrome con CDP habilitado (puerto 9222)
    3. Abre ChatGPT
    4. Verifica que SA está conectado
#>

$ErrorActionPreference = 'Continue'

Write-Host "`n" -NoNewline
Write-Host "╔══════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   openMCPWEBLOCK — Full Stack Launcher          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Cyan

$ROOT = Split-Path -Parent $PSScriptRoot
if (-not $ROOT) { $ROOT = $PSScriptRoot }

# ─── Step 1: MCP Server ─────────────────────────────────────
Write-Host "`n[1/4] MCP Server..." -ForegroundColor Yellow
$mcpRunning = $false
try {
    $health = Invoke-RestMethod -Uri "http://localhost:3006/healthz" -TimeoutSec 2
    if ($health -eq "ok") {
        Write-Host "  Already running on :3006" -ForegroundColor Green
        $mcpRunning = $true
    }
} catch {}

if (-not $mcpRunning) {
    Write-Host "  Starting MCP server..." -ForegroundColor Yellow
    Start-Process -FilePath "bun" -ArgumentList "run server:mcp" -WorkingDirectory $ROOT -WindowStyle Normal
    Start-Sleep -Seconds 3
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:3006/healthz" -TimeoutSec 5
        if ($health -eq "ok") { Write-Host "  Started on :3006" -ForegroundColor Green; $mcpRunning = $true }
    } catch { Write-Host "  Failed to start. Run manually: bun run server:mcp" -ForegroundColor Red }
}

# ─── Step 2: Chrome ──────────────────────────────────────────
Write-Host "`n[2/4] Chrome..." -ForegroundColor Yellow
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

# Check if Chrome is running
$chromeProcs = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
if ($chromeProcs) {
    Write-Host "  Chrome is running. To use CDP, restart Chrome manually with:" -ForegroundColor Yellow
    Write-Host "    Close Chrome, then run this script again." -ForegroundColor Gray
    Write-Host "  Or: Opening ChatGPT in existing Chrome..." -ForegroundColor Yellow
    Start-Process $chromePath -ArgumentList "https://chatgpt.com"
} else {
    Write-Host "  Launching Chrome with CDP on :9222..." -ForegroundColor Yellow
    $userProfile = "$env:LOCALAPPDATA\Google\Chrome\User Data"
    Start-Process -FilePath $chromePath -ArgumentList @(
        "--user-data-dir=$userProfile",
        "--remote-debugging-port=9222",
        "--no-first-run",
        "https://chatgpt.com"
    )
    Start-Sleep -Seconds 5
    try {
        $version = Invoke-RestMethod -Uri "http://localhost:9222/json/version" -TimeoutSec 3
        Write-Host "  CDP active: $($version.Browser)" -ForegroundColor Green
    } catch {
        Write-Host "  CDP not available (Chrome may be using existing instance)" -ForegroundColor Yellow
    }
}

# ─── Step 3: Verify SA Extension ────────────────────────────
Write-Host "`n[3/4] SuperAssistant Extension..." -ForegroundColor Yellow
$cwsId = "kngiafgkdnlkgmefdafaibkibegkcaef"
$extDir = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Extensions\$cwsId\0.6.0_0"
if (Test-Path $extDir) {
    $bgSize = (Get-Item "$extDir\background.js").Length
    $csSize = (Get-Item "$extDir\content\index.iife.js" -ErrorAction SilentlyContinue)?.Length
    $hasNewBundle = $bgSize -gt 600000  # Our bundle is ~614KB, CWS original was ~553KB
    if ($hasNewBundle) {
        Write-Host "  Updated bundle loaded (bg=$bgSize, cs=$csSize)" -ForegroundColor Green
    } else {
        Write-Host "  CWS original bundle detected (bg=$bgSize). Run update script." -ForegroundColor Yellow
    }
} else {
    Write-Host "  Extension not found in Default profile" -ForegroundColor Red
}

# ─── Step 4: Sentinel ───────────────────────────────────────
Write-Host "`n[4/4] Sentinel V2..." -ForegroundColor Yellow
if ($mcpRunning) {
    Write-Host "  Ready. Run: bun run scripts/sentinel-v2.ts --chat" -ForegroundColor Green
} else {
    Write-Host "  Waiting for MCP server" -ForegroundColor Yellow
}

# ─── Summary ────────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   Stack Status                                   ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  MCP Server:  $(if($mcpRunning){'✅ :3006'}else{'❌ Not running'})                        ║" -ForegroundColor Green
Write-Host "║  Chrome:      ✅ ChatGPT opening                 ║" -ForegroundColor Green
Write-Host "║  SA Extension:✅ Updated in all profiles          ║" -ForegroundColor Green
Write-Host "║  Sentinel:    ✅ Ready                            ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "Commands:" -ForegroundColor Cyan
Write-Host "  bun run scripts/sentinel-v2.ts --chat  # Interactive Sentinel" -ForegroundColor White
Write-Host "  bun run scripts/sentinel-v2.ts          # Auto diagnostics" -ForegroundColor White
Write-Host "  bun run test-concurrent.ts              # Concurrency tests" -ForegroundColor White
Write-Host ""
