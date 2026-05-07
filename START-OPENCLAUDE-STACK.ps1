#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Inicia el stack COMPLETO de OpenClaude + MCP
    
.DESCRIPTION
    Secuencia:
    1. Chrome con DevTools Protocol (puerto 9222)
    2. SuperAssistant Proxy (puerto 3006) con todos los servers MCP
    3. Validación de la integración
    4. Demostración de capacidades
#>

$ErrorActionPreference = 'Stop'

Write-Host "`n" + ("="*70) -ForegroundColor Magenta
Write-Host "🚀 STACK OPENCLAUDE + MCP - INITIALIZATION SEQUENCE" -ForegroundColor Magenta
Write-Host ("="*70) + "`n" -ForegroundColor Magenta

# PASO 1: Restaurar configuración completa del proxy
Write-Host "`n📝 Paso 1: Configurando SuperAssistant Proxy..." -ForegroundColor Cyan
$configContent = @"
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\apoca\\openMCPWEBLOCK"
      ]
    },
    "chrome-devtools-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp",
        "--port",
        "9222"
      ]
    }
  }
}
"@

$configPath = ".\superassistant-proxy.config.json"
Set-Content -Path $configPath -Value $configContent -Encoding utf8
Write-Host "   ✅ Config guardada: $configPath" -ForegroundColor Green

# PASO 2: Crear script consolidado
Write-Host "`n📋 Paso 2: Creando script de lanzamiento consolidado..." -ForegroundColor Cyan

# PASO 3: Mostrar instrucciones
Write-Host "`n$('='*70)" -ForegroundColor Magenta
Write-Host "📌 INSTRUCCIONES PARA LANZAR EL STACK COMPLETO" -ForegroundColor Magenta
Write-Host $('='*70) -ForegroundColor Magenta

Write-Host "`n1️⃣ En una NUEVA ventana PowerShell, inicia Chrome:" -ForegroundColor Yellow
Write-Host "   .\launch-chrome-cdp.ps1" -ForegroundColor Cyan
Write-Host "   (Mantén abierto mientras usas OpenClaude)" -ForegroundColor Gray

Write-Host "`n2️⃣ En otra ventana PowerShell, inicia el proxy MCP:" -ForegroundColor Yellow  
Write-Host "   .\launch-superassistant-proxy.ps1" -ForegroundColor Cyan
Write-Host "   (El proxy coordina los servidores MCP)" -ForegroundColor Gray

Write-Host "`n3️⃣ Valida la integración:" -ForegroundColor Yellow
Write-Host "   .\validate-mcp-stack.ps1" -ForegroundColor Cyan
Write-Host "   (Verifica que todo está conectado)" -ForegroundColor Gray

Write-Host "`n4️⃣ Prueba las herramientas disponibles:" -ForegroundColor Yellow
Write-Host "   node test-mcp-tools.mjs" -ForegroundColor Cyan
Write-Host "   (Navega web y extrae contenido)" -ForegroundColor Gray

Write-Host "`n5️⃣ Abre OpenClaude e invoca las herramientas MCP:" -ForegroundColor Yellow
Write-Host "   'Navega a example.com y cuéntame qué ves'" -ForegroundColor Cyan
Write-Host "   (OpenClaude invocará chrome-devtools-mcp automáticamente)" -ForegroundColor Gray

Write-Host "`n$('='*70)" -ForegroundColor Magenta
Write-Host "✨ ARQUITECTURA FINAL" -ForegroundColor Magenta
Write-Host $('='*70) -ForegroundColor Magenta

Write-Host @"
┌────────────────────────────────────────────────┐
│ OpenClaude (Asistente IA)                      │
└────────────┬─────────────────────────────────────┘
             │ (conecta a puerto 3006)
             ↓
┌────────────────────────────────────────────────┐
│ SuperAssistant Proxy (localhost:3006)          │
│ Transport: StreamableHttp + JSON-RPC 2.0       │
└────────────┬──────────────────────┬────────────┘
             │                      │
      ┌──────↓─────┐        ┌──────↓──────────┐
      │ Filesystem │        │Chrome DevTools  │
      │   Server   │        │     (MCP)       │
      │ 14 tools   │        │    29 tools     │
      └────────────┘        │ web automation  │
                            └─────────────────┘
                                    ↓
                            ┌───────────────┐
                            │ Chrome (CDP)  │
                            │ puerto 9222   │
                            │ Web Browser   │
                            └───────────────┘
"@

Write-Host "`n$('='*70)" -ForegroundColor Magenta
Write-Host "🎯 RESULTADO ESPERADO" -ForegroundColor Magenta
Write-Host $('='*70) -ForegroundColor Magenta

Write-Host @"
Usuario: "¿Qué hay en example.com?"
         │
         ↓
OpenClaude detecta que necesita herramientas web
         │
         ↓
POST http://localhost:3006/mcp
{
  "method": "tools/call",
  "params": {
    "name": "chrome-devtools-mcp.new_page",
    "arguments": { "url": "https://example.com" }
  }
}
         │
         ↓
Chrome abre la página en background
         │
         ↓
OpenClaude extrae contenido (DOM)
         │
         ↓
"Veo un sitio de ejemplo con texto que dice..."
"@

Write-Host "`n$('='*70)" -ForegroundColor Green
Write-Host "✅ READY TO START" -ForegroundColor Green
Write-Host $('='*70 + "`n") -ForegroundColor Green
