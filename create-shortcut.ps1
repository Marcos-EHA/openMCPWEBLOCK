$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = "$Desktop\OpenClaude-NVIDIA.lnk"
$PowerShellPath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $PowerShellPath
$Shortcut.Arguments = "-NoExit -Command `"& {`$env:CLAUDE_CODE_USE_OPENAI='1'; `$env:OPENAI_API_KEY='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'; `$env:OPENAI_MODEL='deepseek-ai/deepseek-v4-pro'; `$env:OPENAI_BASE_URL='https://integrate.api.nvidia.com/v1'; openclaude}`""
$Shortcut.Description = "OpenClaude con NVIDIA NIM + DeepSeek v4-pro"
$Shortcut.WorkingDirectory = $env:USERPROFILE
$Shortcut.Save()

Write-Host ""
Write-Host "✅ ACCESO DIRECTO CREADO EXITOSAMENTE!" -ForegroundColor Green
Write-Host ""
Write-Host "Ubicacion: $ShortcutPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "Ahora puedes hacer doble clic para abrir OpenClaude" -ForegroundColor Yellow
