#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Lanza la sesión MCP directa y abre una página web de IA.
.DESCRIPTION
    Arranca el cliente directo de MCP usando chrome-devtools-mcp y abre un URL de destino.
#>

$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$script = Join-Path $PSScriptRoot 'mcp-client-node.js'
$url = 'https://chat.openai.com/'
$argList = @($script, '--url', $url, '--keepAlive')

Write-Host "Launching direct MCP web mode..." -ForegroundColor Cyan
Write-Host "Target URL: $url" -ForegroundColor Cyan

$process = Start-Process -FilePath 'node.exe' -ArgumentList $argList -PassThru
Write-Host "MCP client started with PID $($process.Id)." -ForegroundColor Green
Write-Host "Logs: $logDir" -ForegroundColor Green
Write-Host "To stop the session, terminate PID $($process.Id) or close this window." -ForegroundColor Yellow
