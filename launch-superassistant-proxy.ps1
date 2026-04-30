#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Inicia MCP-SuperAssistant Proxy y valida conectividad.

.DESCRIPTION
    Arranca el proxy usando la configuracion MCP actual del proyecto y ejecuta
    una verificacion de salud basica contra /health.
#>

param(
    [string]$ConfigPath = ".\\superassistant-proxy.config.json",
    [int]$Port = 3006,
    [ValidateSet("sse", "streamableHttp", "ws")]
    [string]$OutputTransport = "streamableHttp"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ConfigPath)) {
    Write-Host "No existe el archivo de configuracion: $ConfigPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " MCP-SuperAssistant Proxy Launcher" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Config: $ConfigPath"
Write-Host " Port:   $Port"
Write-Host " Mode:   $OutputTransport"
Write-Host ""

$proxyArgs = @(
    "-y",
    "@srbhptl39/mcp-superassistant-proxy@latest",
    "--config", $ConfigPath,
    "--port", "$Port",
    "--outputTransport", $OutputTransport
)

Write-Host "Iniciando proxy..." -ForegroundColor Yellow

$logDir = ".\\logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}
$stdoutLog = Join-Path $logDir "superassistant-proxy.stdout.log"
$stderrLog = Join-Path $logDir "superassistant-proxy.stderr.log"

$process = Start-Process -FilePath "npx.cmd" -ArgumentList $proxyArgs -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
Start-Sleep -Seconds 4

if ($process.HasExited) {
    Write-Host "El proceso termino inmediatamente (codigo $($process.ExitCode))." -ForegroundColor Red
    Write-Host "Revisa logs: $stdoutLog y $stderrLog" -ForegroundColor Yellow
    exit 1
}

Write-Host "Proceso activo (PID $($process.Id)). Ejecutando probe MCP..." -ForegroundColor Green

$probeUrl = "http://localhost:$Port/mcp"
try {
    $response = Invoke-WebRequest -Uri $probeUrl -Method GET -TimeoutSec 10
    Write-Host "Probe MCP OK: $($response.StatusCode) $probeUrl" -ForegroundColor Green
} catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -eq 405) {
        Write-Host "Probe MCP OK (405 esperado en algunos servidores): $probeUrl" -ForegroundColor Green
    } else {
        Write-Host "Probe MCP fallo en $probeUrl. Revisa firewall/puerto/logs." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Proxy en ejecucion. Para detenerlo:" -ForegroundColor Cyan
Write-Host "  Stop-Process -Id $($process.Id)"
Write-Host "Logs:"
Write-Host "  $stdoutLog"
Write-Host "  $stderrLog"
Write-Host ""
