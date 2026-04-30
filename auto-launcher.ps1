#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Launcher automatico - Limpia, ejecuta MCP client, captura resultados
#>

$ErrorActionPreference = 'Continue'

$workDir = 'c:\Users\apoca\openMCPWEBLOCK'
Set-Location $workDir

$logFile = Join-Path $workDir 'logs\auto-launcher.log'
$resultFile = Join-Path $workDir 'logs\mcp-test-result.json'

"=== AUTO LAUNCHER STARTED ===" | Tee-Object -FilePath $logFile -Append

# Kill all old terminals and processes
"[1/5] Killing old processes..." | Tee-Object -FilePath $logFile -Append

try {
    taskkill /F /IM node.exe 2>$null | Out-Null
    "[OK] Killed node.exe" | Tee-Object -FilePath $logFile -Append
} catch { }

try {
    taskkill /F /IM chrome.exe 2>$null | Out-Null
    "[OK] Killed chrome.exe" | Tee-Object -FilePath $logFile -Append
} catch { }

# Keep current PowerShell, kill others
try {
    $currentPID = $PID
    Get-Process pwsh -ErrorAction SilentlyContinue | 
        Where-Object { $_.Id -ne $currentPID } | 
        ForEach-Object {
            taskkill /F /PID $_.Id 2>$null | Out-Null
        }
    "[OK] Killed duplicate PowerShell windows" | Tee-Object -FilePath $logFile -Append
} catch { }

Start-Sleep -Seconds 2

# Now run Node.js client
"[2/5] Starting Node.js MCP client..." | Tee-Object -FilePath $logFile -Append

$nodeScript = Join-Path $workDir 'mcp-client-node.js'

try {
    # Run Node.js and capture output
    $output = & node $nodeScript 2>&1
    
    "[OK] Node.js script executed" | Tee-Object -FilePath $logFile -Append
    "Output:" | Tee-Object -FilePath $logFile -Append
    $output | Tee-Object -FilePath $logFile -Append
    
    # Check if result file was created
    Start-Sleep -Seconds 1
    
    if (Test-Path $resultFile) {
        "[OK] Result file created: $resultFile" | Tee-Object -FilePath $logFile -Append
        
        $content = Get-Content $resultFile -Raw
        $content | Tee-Object -FilePath $logFile -Append
    } else {
        "[FAIL] Result file NOT created" | Tee-Object -FilePath $logFile -Append
    }
    
} catch {
    $errorMsg = $_.Exception.Message
    "[FAIL] Error running Node.js: $errorMsg" | Tee-Object -FilePath $logFile -Append
    "Full error:" | Tee-Object -FilePath $logFile -Append
    $_ | Tee-Object -FilePath $logFile -Append
}

"[3/5] Checking for Chrome windows..." | Tee-Object -FilePath $logFile -Append
$chromeProcs = Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object
"Chrome processes: $($chromeProcs.Count)" | Tee-Object -FilePath $logFile -Append

"[4/5] Checking logs directory..." | Tee-Object -FilePath $logFile -Append
Get-ChildItem -Path logs\ | Tee-Object -FilePath $logFile -Append

"[5/5] Done!" | Tee-Object -FilePath $logFile -Append
"=== AUTO LAUNCHER FINISHED ===" | Tee-Object -FilePath $logFile -Append

# Display summary
Write-Host ""
Write-Host "=== SUMMARY ===" -ForegroundColor Cyan
Write-Host "Log file: $logFile" -ForegroundColor Green
if (Test-Path $resultFile) {
    Write-Host "Result file: $resultFile" -ForegroundColor Green
} else {
    Write-Host "No result file generated" -ForegroundColor Yellow
}
