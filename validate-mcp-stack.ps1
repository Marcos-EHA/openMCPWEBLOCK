#!/usr/bin/env pwsh
<#!
.SYNOPSIS
    Valida el stack MCP completo para OpenClaude.

.DESCRIPTION
    Comprueba que los paquetes externos y el proxy MCP se pueden iniciar.
    Usa los scripts y la configuración local del proyecto.
#>

param(
    [int]$Port = 3006,
    [string]$HealthPath = '/healthz'
)

$ErrorActionPreference = 'Stop'

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " MCP Stack Validation" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

$logDir = '.\logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-LogBlock($title, $content) {
    Write-Host "--- $title ---" -ForegroundColor Yellow
    Write-Host $content
}

function ValidatePackage($label, $command, [Parameter(ValueFromRemainingArguments=$true)] $argumentList) {
    $stdout = Join-Path $logDir "$label.stdout.log"
    $stderr = Join-Path $logDir "$label.stderr.log"
    Write-Host "Validando paquete $label..." -ForegroundColor Green
    $process = Start-Process -FilePath $command -ArgumentList $argumentList -PassThru -Wait -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) {
        Write-Host "$label falló con código $($process.ExitCode)." -ForegroundColor Red
        Write-Host "Revisa $stderr" -ForegroundColor Yellow
    } else {
        Write-Host "$label válido." -ForegroundColor Green
    }
    return $process.ExitCode
}

$claudeMemExit = ValidatePackage 'claude-mem-help' 'npx.cmd' '-y' 'claude-mem' '--help'
$chromeDevtoolsExit = ValidatePackage 'chrome-devtools-mcp-help' 'npx.cmd' '-y' 'chrome-devtools-mcp' '--help'

if ($claudeMemExit -ne 0 -or $chromeDevtoolsExit -ne 0) {
    Write-Host "Advertencia: uno o más paquetes no se validaron correctamente." -ForegroundColor Yellow
    Write-Host "Asegúrate de que los paquetes existan y que la conexión a Internet esté disponible."
}

Write-Host "" -ForegroundColor Cyan
Write-Host "Verificando el proxy MCP..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$Port$HealthPath" -Method Get -TimeoutSec 10
    if ($response.StatusCode -eq 200) {
        Write-Host "Proxy MCP accesible en http://localhost:$Port$HealthPath." -ForegroundColor Green
        Write-Host "Código HTTP: $($response.StatusCode)" -ForegroundColor Green
    } else {
        Write-Host "Proxy MCP accesible en http://localhost:$Port$HealthPath con código inesperado: $($response.StatusCode)." -ForegroundColor Yellow
    }
} catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = $_.Exception.Response.StatusCode.Value__
        Write-Host "Fallo en la verificación de salud del proxy en http://localhost:$Port$HealthPath (HTTP $statusCode)." -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    } else {
        Write-Host "No se pudo conectar al proxy MCP en http://localhost:$Port$HealthPath." -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
    }
    exit 1
}

Write-Host "" -ForegroundColor Cyan
Write-Host "La validación del stack MCP ha finalizado." -ForegroundColor Green
Write-Host "Revisa los logs en: $logDir" -ForegroundColor Cyan
