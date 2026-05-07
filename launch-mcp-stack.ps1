#!/usr/bin/env pwsh
<#!
.SYNOPSIS
    Inicia el stack MCP completo para OpenClaude.

.DESCRIPTION
    Lanza claude-mem, chrome-devtools-mcp y superassistant-proxy.
    Deja los procesos en segundo plano y muestra los PID.
#>

$ErrorActionPreference = 'Stop'

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " MCP Stack Launcher" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

$logDir = '.\logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Get-ProcessCommandLine {
    param ([int]$pid)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
    return $process?.CommandLine
}

function Stop-ProcessByCommandLinePattern {
    param (
        [string]$pattern,
        [string]$label
    )

    $matched = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern }

    if ($matched) {
        Write-Host "Deteniendo procesos existentes de $label..." -ForegroundColor Yellow
        foreach ($proc in $matched) {
            try {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
                Write-Host "  Detenido PID $($proc.ProcessId) ($label)." -ForegroundColor Green
            } catch {
                Write-Host "  No se pudo detener PID $($proc.ProcessId): $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }
}

function Stop-PortOwner {
    param ([int]$port)

    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -and $conn.OwningProcess -ne $PID) {
                try {
                    Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
                    Write-Host "Detenido proceso propietario del puerto ${port}: PID $($conn.OwningProcess)." -ForegroundColor Green
                } catch {
                    Write-Host "No se pudo detener PID $($conn.OwningProcess) en puerto ${port}: $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        }
    } catch {
        # No hay conexión en ese puerto o no se puede consultar
    }
}

function Clean-ExistingMCPStack {
    Write-Host "Buscando instancias existentes de MCP para limpiar..." -ForegroundColor Cyan
    Stop-ProcessByCommandLinePattern 'chrome-devtools-mcp' 'chrome-devtools-mcp'
    Stop-ProcessByCommandLinePattern 'mcp-superassistant-proxy' 'superassistant-proxy'
    Stop-ProcessByCommandLinePattern 'claude-mem' 'claude-mem'
    Stop-PortOwner 3006
    Start-Sleep -Seconds 2
}

function Start-ServiceProcess {
    param (
        [string]$name,
        [string[]]$argumentList,
        [string]$stdout,
        [string]$stderr
    )
    Write-Host "Iniciando $name..." -ForegroundColor Yellow
    $process = Start-Process -FilePath 'npx.cmd' -ArgumentList $argumentList -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Start-Sleep -Seconds 4
    if ($process.HasExited) {
        Write-Host "$name terminó inmediatamente (código $($process.ExitCode))." -ForegroundColor Red
        Write-Host "Revisa logs: $stdout y $stderr" -ForegroundColor Yellow
        if (Test-Path $stderr) {
            Write-Host "Últimas líneas de error:" -ForegroundColor Yellow
            Get-Content $stderr -Tail 20 | ForEach-Object { Write-Host $_ }
        }
        exit 1
    }
    Write-Host "$name en ejecución (PID $($process.Id))." -ForegroundColor Green
    return $process
}

$claudeMemStdout = Join-Path $logDir 'claude-mem.stdout.log'
$claudeMemStderr = Join-Path $logDir 'claude-mem.stderr.log'
$chromeMcpStdout = Join-Path $logDir 'chrome-devtools-mcp.stdout.log'
$chromeMcpStderr = Join-Path $logDir 'chrome-devtools-mcp.stderr.log'
$proxyStdout = Join-Path $logDir 'superassistant-proxy.stdout.log'
$proxyStderr = Join-Path $logDir 'superassistant-proxy.stderr.log'

$claudeMemArgs = @('-y', 'claude-mem', 'start')
$chromeDevtoolsArgs = @('-y', 'chrome-devtools-mcp')
$proxyArgs = @('-y', '@srbhptl39/mcp-superassistant-proxy@latest', '--config', '.\superassistant-proxy.config.json', '--port', '3006', '--outputTransport', 'streamableHttp', '--healthEndpoint', '/healthz')

Clean-ExistingMCPStack

$claudeMem = Start-ServiceProcess 'claude-mem' $claudeMemArgs $claudeMemStdout $claudeMemStderr
$chromeDevtools = Start-ServiceProcess 'chrome-devtools-mcp' $chromeDevtoolsArgs $chromeMcpStdout $chromeMcpStderr
$proxy = Start-ServiceProcess 'superassistant-proxy' $proxyArgs $proxyStdout $proxyStderr

function Test-ProxyHealth {
    param ([string]$url)
    Write-Host "Verificando proxy MCP en $url..." -ForegroundColor Yellow
    try {
        $response = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 10
        if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 405) {
            Write-Host "Proxy MCP OK ($($response.StatusCode))." -ForegroundColor Green
            return
        }
        Write-Host "Proxy MCP respondió con estado inesperado: $($response.StatusCode)" -ForegroundColor Yellow
    } catch {
        Write-Host "Probe falló: $($_.Exception.Message)" -ForegroundColor Red
        if (Test-Path $proxyStderr) {
            Write-Host "Salida de error del proxy:" -ForegroundColor Yellow
            Get-Content $proxyStderr -Tail 20 | ForEach-Object { Write-Host $_ }
        }
        exit 1
    }
}

Test-ProxyHealth 'http://localhost:3006/healthz'


Write-Host "" -ForegroundColor Cyan
Write-Host "Stack MCP iniciado." -ForegroundColor Green
Write-Host "Processes: " -ForegroundColor Cyan
Write-Host "  claude-mem: $($claudeMem.Id)" -ForegroundColor Green
Write-Host "  chrome-devtools-mcp: $($chromeDevtools.Id)" -ForegroundColor Green
Write-Host "  superassistant-proxy: $($proxy.Id)" -ForegroundColor Green
Write-Host "" -ForegroundColor Cyan
Write-Host "Ver logs en: $logDir" -ForegroundColor Cyan
