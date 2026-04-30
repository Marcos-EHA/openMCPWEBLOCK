# Aggressive cleanup of all MCP processes and duplicates
Write-Host "Starting aggressive cleanup..."

# Kill all node processes (proxy, chrome-devtools-mcp, claude-mem)
try {
    taskkill /F /IM node.exe 2>$null | Out-Null
    Write-Host "[OK] Killed all node.exe processes"
} catch { }

# Kill all chrome processes
try {
    taskkill /F /IM chrome.exe 2>$null | Out-Null
    Write-Host "[OK] Killed all chrome.exe processes"
} catch { }

# Kill all extra pwsh processes (keep current one)
try {
    $currentPID = $PID
    Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $currentPID } | ForEach-Object {
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] Killed extra PowerShell windows"
} catch { }

# Release port 3006
try {
    $portOwner = Get-NetTCPConnection -LocalPort 3006 -ErrorAction SilentlyContinue
    if ($portOwner) {
        Stop-Process -Id $portOwner.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Released port 3006"
    }
} catch { }

Start-Sleep -Milliseconds 500
Write-Host "Cleanup complete."
