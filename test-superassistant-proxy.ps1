#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Verifica endpoint MCP del proxy con tools/list.
#>

param(
    [string]$McpUrl = "http://localhost:3006/mcp"
)

$ErrorActionPreference = "Stop"

$markerFile = Join-Path $PSScriptRoot 'logs\test-superassistant-proxy-run-marker.txt'
Set-Content -Path $markerFile -Value "ran at $(Get-Date -Format o)" -Encoding utf8

Write-Host "Probando MCP endpoint: $McpUrl" -ForegroundColor Cyan

$commonHeaders = @{
    Accept = "application/json, text/event-stream"
}

$outputFile = Join-Path $PSScriptRoot 'logs\test-superassistant-proxy.json'
$errorFile = Join-Path $PSScriptRoot 'logs\test-superassistant-proxy-error.txt'

$initPayload = @{
    jsonrpc = "2.0"
    id      = 1
    method  = "initialize"
    params  = @{
        protocolVersion = "2025-11-05"
        capabilities    = @{}
        clientInfo      = @{
            name    = "openMCPWEBLOCK-test"
            version = "1.0.0"
        }
    }
} | ConvertTo-Json -Depth 8

$toolsListPayload = @{
    jsonrpc = "2.0"
    id      = 2
    method  = "tools/list"
    params  = @{}
} | ConvertTo-Json -Depth 6

try {
    $initResponse = Invoke-RestMethod -Method Post -Uri $McpUrl -Headers $commonHeaders -ContentType "application/json" -Body $initPayload -TimeoutSec 20
    Write-Host "Initialize OK." -ForegroundColor Green
    $initResponse | ConvertTo-Json -Depth 10

    $listResponse = Invoke-RestMethod -Method Post -Uri $McpUrl -Headers $commonHeaders -ContentType "application/json" -Body $toolsListPayload -TimeoutSec 20
    Write-Host "tools/list OK." -ForegroundColor Green

    $toolRunPayload = @{
        jsonrpc = "2.0"
        id      = 3
        method  = "tools/call"
        params  = @{
            name      = "chrome-devtools-mcp.new_page"
            arguments = @{
                url        = "https://example.com"
                background = $false
            }
        }
    } | ConvertTo-Json -Depth 10

    Write-Host "Intentando chrome-devtools-mcp.new_page via tools/call..." -ForegroundColor Cyan
    $runResponse = Invoke-RestMethod -Method Post -Uri $McpUrl -Headers $commonHeaders -ContentType "application/json" -Body $toolRunPayload -TimeoutSec 40
    Write-Host "tools/call OK." -ForegroundColor Green

    $result = [PSCustomObject]@{
        timestamp         = (Get-Date).ToString('o')
        mcpUrl            = $McpUrl
        initialize        = $initResponse
        tools_list        = $listResponse
        chrome_new_page   = $runResponse
    }
    $result | ConvertTo-Json -Depth 20 | Set-Content -Path $outputFile -Encoding utf8
    Write-Host "Resultados guardados en $outputFile" -ForegroundColor Green
} catch {
    Write-Host "Fallo al consultar $McpUrl" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    $_.Exception.Message | Set-Content -Path $errorFile -Encoding utf8
    exit 1
}
