#!/usr/bin/env pwsh
<#!
.SYNOPSIS
    Inicia claude-mem como servidor local.

.DESCRIPTION
    Lanza el servidor de memoria persistent de claude-mem.
#>

$ErrorActionPreference = 'Stop'

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Claude-mem Server Launcher" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Starting claude-mem server..." -ForegroundColor Yellow

$logDir = '.\logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}
$stdoutLog = Join-Path $logDir 'claude-mem.stdout.log'
$stderrLog = Join-Path $logDir 'claude-mem.stderr.log'

$process = Start-Process -FilePath 'npx.cmd' -ArgumentList '-y', 'claude-mem', 'start' -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
Start-Sleep -Seconds 4

if ($process.HasExited) {
    Write-Host "El proceso terminó inmediatamente (código $($process.ExitCode))." -ForegroundColor Red
    Write-Host "Revisa logs: $stdoutLog y $stderrLog" -ForegroundColor Yellow
    if (Test-Path $stderrLog) {
        Write-Host "Últimas líneas de error:" -ForegroundColor Yellow
        Get-Content $stderrLog -Tail 20 | ForEach-Object { Write-Host $_ }
    }
    exit 1
}

Write-Host "Claude-mem en ejecución (PID $($process.Id))." -ForegroundColor Green
Write-Host "Logs: $stdoutLog" -ForegroundColor Green
Write-Host "      $stderrLog" -ForegroundColor Green
Write-Host "Para detenerlo: Stop-Process -Id $($process.Id)" -ForegroundColor Cyan
