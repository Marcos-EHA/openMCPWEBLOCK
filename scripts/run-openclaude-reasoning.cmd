@echo off
REM Script para ejecutar OpenClaude con modelo de razonamiento de alto contexto
REM Modelo base: llama3.2:3b (128K tokens de contexto)
REM Configuración automática como el sistema provider-launch

set OLLAMA_BASE_URL=http://localhost:11434
set OPENAI_BASE_URL=http://localhost:11434/v1
set CLAUDE_CODE_USE_OPENAI=true
set OPENAI_MODEL=llama3.2:3b
set OPENCLAUDE_AUTO_MODEL_SWITCH=true
set CLAUDE_CODE_AUTO_SWITCH=true

echo Iniciando OpenClaude con modelo de razonamiento llama3.2:3b...
echo Contexto de 128K tokens - no debería haber límites de contexto.
echo Auto-switch activado: usará otros modelos según la tarea detectada.
echo Presiona Ctrl+C para salir.

bun run build && node dist/cli.mjs