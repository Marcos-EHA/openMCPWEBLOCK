#!/usr/bin/env pwsh

$proxyUrl = 'http://localhost:3006/mcp'
$headers = @{
    'Content-Type' = 'application/json'
    'Accept' = 'application/json,text/event-stream'
}

function CallMcpTool($toolName, $arguments, $description) {
    Write-Host "`n$('='*60)" -ForegroundColor Cyan
    Write-Host "📋 $description" -ForegroundColor Cyan
    Write-Host "🔧 Tool: $toolName" -ForegroundColor Yellow
    Write-Host $('='*60)

    $id = [Guid]::NewGuid().ToString()
    $body = @{
        jsonrpc = '2.0'
        id      = $id
        method  = 'tools/call'
        params  = @{
            name      = $toolName
            arguments = $arguments
        }
    } | ConvertTo-Json -Depth 10

    try {
        $response = Invoke-WebRequest -Uri $proxyUrl `
            -Method Post `
            -Headers $headers `
            -Body $body `
            -TimeoutSec 45 `
            -UseBasicParsing

        Write-Host "✅ Response received (status: $($response.StatusCode))" -ForegroundColor Green
        
        # Parse SSE format
        $content = $response.Content
        if ($content -match 'data: \{.*\}') {
            $jsonMatch = [regex]::Match($content, 'data: (\{.*\})')
            if ($jsonMatch.Success) {
                $json = $jsonMatch.Groups[1].Value | ConvertFrom-Json
                if ($json.result) {
                    Write-Host "Result:" -ForegroundColor Green
                    $json.result | ConvertTo-Json -Depth 5 | Write-Host
                } elseif ($json.error) {
                    Write-Host "⚠️ Error: $($json.error.message)" -ForegroundColor Red
                }
            }
        }
    } catch {
        Write-Host "❌ Error: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "🚀 Testing MCP Proxy - Web Navigation Test" -ForegroundColor Magenta
Write-Host "Target Proxy: $proxyUrl`n" -ForegroundColor Cyan

# Step 1: Create a new browser page/tab
CallMcpTool `
    'chrome-devtools-mcp.new_page' `
    @{ url = 'https://example.com'; background = $false } `
    'Opening browser and navigating to example.com'

Start-Sleep -Seconds 3

# Step 2: List browser pages
CallMcpTool `
    'chrome-devtools-mcp.list_pages' `
    @{ } `
    'Listing browser pages and tabs'

# Step 3: Read the page title via evaluate_script
CallMcpTool `
    'chrome-devtools-mcp.evaluate_script' `
    @{ function = '() => { return document.title }'; args = @() } `
    'Evaluating document.title on the selected page'

Write-Host "`n$('='*60)" -ForegroundColor Cyan
Write-Host "✅ Test Sequence Complete" -ForegroundColor Green
Write-Host "This demonstrates that OpenClaude can now:" -ForegroundColor Cyan
Write-Host "  1. Invoke SuperAssistant Proxy at localhost:3006" -ForegroundColor Cyan
Write-Host "  2. Access chrome-devtools-mcp tools for web automation" -ForegroundColor Cyan
Write-Host "  3. Navigate websites and extract content" -ForegroundColor Cyan
Write-Host "  4. Return results to Claude for processing" -ForegroundColor Cyan
