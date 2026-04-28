# Arranca OpenClaude con alternancia automática de modelos locales Ollama.
# Asegúrate de que Ollama esté corriendo en http://localhost:11434 y de tener los modelos instalados.

Set-Location -Path $PSScriptRoot
$env:OPENCLAUDE_AUTO_MODEL_SWITCH = 'true'
$env:OPENAI_BASE_URL = 'http://localhost:11434/v1'
$env:OPENAI_MODEL = 'neural-chat'

bun run dev:ollama
