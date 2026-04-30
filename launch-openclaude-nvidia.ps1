#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Lanza OpenClaude con NVIDIA + DeepSeek v4-pro
    
.DESCRIPTION
    Script para iniciar OpenClaude configurado con NVIDIA NIM y DeepSeek v4-pro.
    Configura automáticamente todas las variables de entorno necesarias.

.EXAMPLE
    # Ejecutar en PowerShell
    .\launch-openclaude-nvidia.ps1

.NOTES
    Requisitos:
    - OpenClaude instalado globalmente (npm install -g @gitlawb/openclaude)
    - API Key de NVIDIA válida
    - PowerShell 5.1 o superior
#>

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  🚀 OpenClaude + NVIDIA NIM + DeepSeek v4-pro              ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Variables de configuración
$CLAUDE_CODE_USE_OPENAI = "1"
$OPENAI_API_KEY = "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"
$OPENAI_MODEL = "deepseek-ai/deepseek-v4-pro"
$OPENAI_BASE_URL = "https://integrate.api.nvidia.com/v1"

# Mostrar configuración
Write-Host "Configuración cargada:" -ForegroundColor Green
Write-Host "  • Provider: NVIDIA NIM"
Write-Host "  • Modelo: DeepSeek v4-pro"
Write-Host "  • Endpoint: https://integrate.api.nvidia.com/v1"
Write-Host "  • API Key: ****" (($OPENAI_API_KEY | Select-Object -Last 10) -join '')
Write-Host ""

# Validar que OpenClaude está instalado
Write-Host "Verificando instalación de OpenClaude..." -ForegroundColor Yellow
$openclaude = Get-Command openclaude -ErrorAction SilentlyContinue

if (-not $openclaude) {
    Write-Host "❌ Error: OpenClaude no está instalado globalmente" -ForegroundColor Red
    Write-Host ""
    Write-Host "Solución: Instala OpenClaude con:" -ForegroundColor Yellow
    Write-Host "  npm install -g @gitlawb/openclaude"
    Write-Host ""
    exit 1
}

Write-Host "✅ OpenClaude encontrado: $($openclaude.Source)" -ForegroundColor Green
Write-Host ""

# Configurar variables de entorno
Write-Host "Configurando variables de entorno..." -ForegroundColor Yellow
$env:CLAUDE_CODE_USE_OPENAI = $CLAUDE_CODE_USE_OPENAI
$env:OPENAI_API_KEY = $OPENAI_API_KEY
$env:OPENAI_MODEL = $OPENAI_MODEL
$env:OPENAI_BASE_URL = $OPENAI_BASE_URL

Write-Host "✅ Variables configuradas" -ForegroundColor Green
Write-Host ""

# Lanzar OpenClaude
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "Iniciando OpenClaude..." -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Ejecutar OpenClaude
& openclaude

# Si OpenClaude se cerrá, mostrar mensaje
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host "OpenClaude ha terminado" -ForegroundColor Yellow
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host ""

# Opciones para el usuario
Write-Host "¿Qué hacer ahora?" -ForegroundColor Green
Write-Host "  1. Lanzar OpenClaude nuevamente" -ForegroundColor White
Write-Host "  2. Abrir documentación de testing" -ForegroundColor White
Write-Host "  3. Verificar configuración" -ForegroundColor White
Write-Host "  4. Salir" -ForegroundColor White
Write-Host ""

$choice = Read-Host "Selecciona una opción (1-4)"

switch ($choice) {
    1 {
        Write-Host "Reiniciando OpenClaude..." -ForegroundColor Yellow
        & openclaude
    }
    2 {
        Write-Host "Abriendo TESTING_GUIDE.md..." -ForegroundColor Yellow
        if (Test-Path ".\TESTING_GUIDE.md") {
            & cmd /c start .\TESTING_GUIDE.md
        } else {
            Write-Host "⚠️  No se encontró TESTING_GUIDE.md" -ForegroundColor Red
        }
    }
    3 {
        Write-Host "Configuración actual:" -ForegroundColor Green
        Write-Host "  CLAUDE_CODE_USE_OPENAI: $env:CLAUDE_CODE_USE_OPENAI"
        Write-Host "  OPENAI_MODEL: $env:OPENAI_MODEL"
        Write-Host "  OPENAI_BASE_URL: $env:OPENAI_BASE_URL"
        Write-Host "  OPENAI_API_KEY: ****" (($env:OPENAI_API_KEY | Select-Object -Last 10) -join '')
    }
    4 {
        Write-Host "¡Hasta luego!" -ForegroundColor Cyan
        exit 0
    }
    default {
        Write-Host "Opción no válida" -ForegroundColor Red
        exit 1
    }
}
