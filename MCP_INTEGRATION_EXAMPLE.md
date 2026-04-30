# Ejemplo práctico de integración MCP para OpenClaude

Este documento muestra un flujo de validación paso a paso para la integración de OpenClaude con `mcp-superassistant-proxy`, `claude-mem` y `chrome-devtools-mcp`.

## 1. Iniciar el stack completo

En PowerShell, ejecuta:

```powershell
.\launch-mcp-stack.ps1
```

O bien, para iniciar manualmente solo los componentes necesarios:

```powershell
.\launch-claude-mem.ps1
.\launch-chrome-devtools-mcp.ps1
.\launch-superassistant-proxy.ps1
```

## 2. Validar la disponibilidad de los paquetes y el proxy

Usa el script de validación general:

```powershell
.\validate-mcp-stack.ps1
```

Este script:
- comprueba `claude-mem`
- comprueba `chrome-devtools-mcp`
- prueba la conexión al proxy MCP en `http://localhost:3006/mcp`

## 3. Confirmar la integración desde OpenClaude

Dentro de la sesión de OpenClaude:

```text
/mcp status
/mcp set-mode web
/mcp status
```

Esperar que el `status` reporte al menos:
- `superassistant-proxy` disponible
- `claude-mem` disponible (si está activo)
- `chrome-devtools-mcp` disponible (si está activo)

## 4. Verificar herramientas MCP disponibles

Desde OpenClaude o un cliente MCP, lista las herramientas expuestas:

```text
/tools list
```

Busca herramientas relacionadas con:
- `filesystem`
- `claude-mem`
- `chrome-devtools`
- `superassistant-proxy`

## 5. Interpretación de resultados

- Si `validate-mcp-stack.ps1` falla en `claude-mem`, revisa `logs\claude-mem.stderr.log`.
- Si falla en `chrome-devtools-mcp`, revisa `logs\chrome-devtools-mcp.stderr.log`.
- Si el proxy no responde, revisa `logs\superassistant-proxy.stderr.log`.

## 6. Estado actual de la integración

- `superassistant-proxy` ya está configurado en `superassistant-proxy.config.json`.
- `claude-mem` usa `npx claude-mem start` para iniciar el servicio.
- `chrome-devtools-mcp` requiere validación adicional de su CLI exacta.

## 7. Recomendaciones finales

- Ejecuta `.\validate-mcp-stack.ps1` después de cada cambio en la configuración MCP.
- Actualiza la línea de arranque de `chrome-devtools-mcp` si el paquete requiere argumentos adicionales.
- Usa la documentación de `MEJORAS_INTEGRACION_MCP.md` para capturar nuevas incompatibilidades.
