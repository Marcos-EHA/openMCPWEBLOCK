#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Inicia Chrome con DevTools Protocol (CDP) en puerto 9222.
    Necesario para que chrome-devtools-mcp pueda controlar el browser.

.DESCRIPTION
    Lanza una instancia de Chrome con:
    - Remote debugging port 9222
    - Ventana nueva (no nueva pestaña en instancia existente)
    - Sin primer arranque (evita popups)
    
    Una vez corriendo, el proxy MCP puede conectarse a chrome-devtools-mcp
    y usar las 29 herramientas para navegar, extraer contenido, interactuar, etc.
#>

param(
    [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe",
    [int]$DebugPort = 9222,
    [switch]$Headless = $false
)

$ErrorActionPreference = 'Stop'

Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║ Chrome DevTools Protocol (CDP) Launcher║" -ForegroundColor Cyan  
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan

if (-not (Test-Path $ChromePath)) {
    Write-Host "❌ Chrome no encontrado en: $ChromePath" -ForegroundColor Red
    Write-Host "Por favor instala Chrome o ajusta -ChromePath" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n📍 Configuración:" -ForegroundColor Cyan
Write-Host "   Chrome: $ChromePath" -ForegroundColor Green
Write-Host "   CDP Port: $DebugPort" -ForegroundColor Green
Write-Host "   Headless: $Headless" -ForegroundColor Green

Write-Host "`nIniciando Chrome..." -ForegroundColor Yellow

$userDataDir = Join-Path $env:TEMP "chrome-cdp-profile"

$args = @(
    "--remote-debugging-port=$DebugPort",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=$userDataDir",
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection"
)

if ($Headless) {
    $args += "--headless"
}

try {
    $process = Start-Process -FilePath $ChromePath -ArgumentList $args -PassThru
    Write-Host "Chrome iniciado (PID $($process.Id))" -ForegroundColor Green
    
    Start-Sleep -Seconds 3
    
    # Verificar que CDP está escuchando
    $retries = 0
    while ($retries -lt 5) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$DebugPort/json/version" -TimeoutSec 5 -UseBasicParsing
            if ($response.StatusCode -eq 200) {
                Write-Host "`nChrome DevTools Protocol disponible en http://localhost:$DebugPort" -ForegroundColor Green
                Write-Host "`nPasos siguientes:" -ForegroundColor Cyan
                Write-Host "   1. El proxy MCP puede conectarse a chrome-devtools-mcp" -ForegroundColor Cyan
                Write-Host "   2. Agregó chrome-devtools-mcp a superassistant-proxy.config.json" -ForegroundColor Cyan
                Write-Host "   3. Reinicia el proxy para cargar las 29 herramientas" -ForegroundColor Cyan
                Write-Host "`nTip: Mantén esta ventana abierta mientras usas OpenClaude" -ForegroundColor Cyan
                
                # Keep Chrome running
                Write-Host "`nChrome seguirá corriendo. Presiona Ctrl+C para detener.`n" -ForegroundColor Yellow
                $process.WaitForExit()
                break
            }
        } catch {
            $retries++
            if ($retries -lt 5) {
                Write-Host "Esperando CDP (intento $retries/5)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
    
    if ($retries -eq 5) {
        Write-Host "Chrome no respondió en CDP después de 10 segundos" -ForegroundColor Yellow
        Write-Host "   Pero el proceso está corriendo. Verifica con:" -ForegroundColor Yellow
        Write-Host "   Invoke-WebRequest -Uri http://localhost:9222/json/version" -ForegroundColor Cyan
    }
} catch {
    Write-Host "Error al iniciar Chrome: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
