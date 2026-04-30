# Informe del Sistema MCP Web-Orquestado

## Objetivo
Definir de forma explícita cómo se compone el sistema entre OpenClaude, `MCP-SuperAssistant`, `chrome-devtools-mcp` y `claude-mem`, incluyendo fallback y límites operativos actuales.

## Semántica de modos

### `api`
- Prioriza herramientas built-in.
- Mantiene `claude-mem` como memoria persistente (si está disponible).
- Está pensado para velocidad y continuidad de desarrollo local.

### `web`
- Habilita herramientas MCP de:
  - `superassistant-proxy`
  - `chrome-devtools`
  - `claude-mem`
- Permite interacción asistida con interfaces IA web y debugging/automatización de Chrome.
- Si algún servidor falta, el sistema degrada en forma segura y lo informa en estado.

### `auto`
- Mantiene built-ins + todas las herramientas MCP permitidas.
- Es el modo de máxima flexibilidad para exploración y flujos mixtos.

## Rol explícito de `claude-mem`
- Actúa como memoria persistente de proyecto entre turnos.
- No debe bloquear ejecución si está ausente: se reporta como faltante y el flujo continúa.
- En escenarios futuros de consenso multi-IA, sirve como base de contexto compartido y registro de decisiones.

## Comando de diagnóstico operativo
Usar `/mcp status` para observar:
- modo actual;
- servidores esperados por modo;
- servidores detectados en runtime;
- servidores faltantes.

Esto reduce ambigüedad y evita confundir “modo seleccionado” con “servidor realmente conectado”.

## Prerrequisitos de operación
- `superassistant-proxy` accesible desde OpenClaude.
- `chrome-devtools-mcp` operativo y con acceso a una instancia de Chrome compatible.
- `claude-mem` disponible cuando se requiera memoria persistente.

## Degradación y resiliencia
- Si falta `superassistant-proxy` en `web`, se mantiene el subconjunto disponible.
- Si falta `chrome-devtools` en `web`, el modo web no se rompe; continúa con herramientas disponibles.
- Si falla `claude-mem`, no se interrumpe la sesión; se continúa sin memoria persistente hasta recuperar servicio.

## Límites actuales
- No existe aún orquestación automática multi-pestaña/multi-interfaz basada en objetivos.
- No existe aún consenso multi-IA automatizado.
- La selección estratégica de interfaz sigue siendo guiada por el usuario y el prompt.

## Evolución sugerida
1. Definir selector de interfaz IA por objetivo (coding, scraping, validación, consenso).
2. Introducir coordinador multi-agente con políticas explícitas de turnos y reconciliación.
3. Persistir decisiones y evidencias de ejecución en memoria estructurada sobre `claude-mem`.
