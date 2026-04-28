@echo off
REM Arranca OpenClaude con alternancia automática de modelos locales Ollama.
REM Asegúrate de que Ollama esté corriendo en http://localhost:11434 y de tener los modelos instalados.

set OPENCLAUDE_AUTO_MODEL_SWITCH=true
set OPENAI_BASE_URL=http://localhost:11434/v1
set OPENAI_MODEL=neural-chat

cd /d %~dp0
bun run dev:ollama
pause
