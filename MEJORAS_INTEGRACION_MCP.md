# Mejores Prácticas y Observaciones - Integración MCP

## Fecha
29 de Abril, 2026

## Contexto
Estas observaciones derivan de la integración de `superassistant-proxy`, `claude-mem` y `chrome-devtools-mcp` en el stack OpenClaude / MCP.

## Hallazgos principales

1. `claude-mem` no acepta el comando `server` en la versión usada.
   - A partir de la prueba en terminal, `npx claude-mem server` devolvía `Unknown command: server`.
   - Esto apunta a una incompatibilidad entre la invocación usada y la implementación del paquete.
   - Corrección aplicada: usar `npx -y claude-mem start` para iniciar el servicio.

2. La configuración del proxy `superassistant-proxy.config.json` puede desbordarse si un servidor MCP no arranca.
   - `superassistant-proxy` conectó correctamente a `filesystem`, pero falló en `claude-mem`.
   - La experiencia de error quedó solo en logs, sin retroalimentación inmediata en el launcher.

3. `chrome-devtools-mcp` se inicia en modo “help” si no se especifican argumentos correctos.
   - El log reciente muestra que la salida del paquete es texto de ayuda.
   - Esto sugiere que la invocación actual necesita ajuste para ejecutar su modo de servidor o evitar el comportamiento de `--help`.
   - Se actualizó `.mcp.json` para usar `-y chrome-devtools-mcp`, igualando la invocación del lanzador.

4. En Windows, lanzar procesos cruzados con `npx` debe respetar `npx.cmd` y rutas de PowerShell.
   - El primer `launch-mcp-stack.ps1` falló por un problema de firma de parámetros en el helper.
   - Esto indica que el script debe simplificarse y evitar wrappers indeterminados para que Windows no pase arrays como `NULL`.

## Recomendaciones de mejora

### A. Mejorar la robustez del orquestador
- Agregar un chequeo de disponibilidad/health para cada servidor MCP antes de considerar el stack iniciado.
- Si un servidor falla, mostrar un mensaje claro con la línea exacta del comando y el paquete involucrado.
- Mantener un modo degradado: continuar si `claude-mem` no está disponible, pero avisar que la memoria persistente quedó deshabilitada.

### B. Usar nombres de paquetes y versiones estables
- Preferir paquetes explícitos con `@latest` o, mejor aún, con versión fija para reproducibilidad.
- Ejemplo: `@claudeai/mcp-claude-mem@latest` en lugar de `claude-mem server`.

### C. Registrar e informar fallos de comandos externos
- Capturar salida estándar y de error en el launcher y mostrarla al usuario si la inicialización falla.
- Evitar dependencias implícitas a `npx` que solo funcionan con versiones específicas de Node/npm.

### D. Inspeccionar y ajustar `chrome-devtools-mcp`
- Determinar si requiere un argumento de modo (`--serve`, `--host`, `--port`, etc.).
- Añadir una comprobación previa con `--help` en la documentación para conocer su CLI exacta.
- Se creó `validate-mcp-stack.ps1` para automatizar la verificación de paquetes y la conexión al proxy.

### F. Limitaciones de integración MCP
- `claude-mem` requiere instalación como plugin de Claude Code, no funciona como servidor MCP.
- `chrome-devtools-mcp` necesita validación de su CLI exacta para arranque correcto.
- El proxy MCP funciona correctamente con `filesystem`, pero falla en servidores no MCP.
- Documentar los requisitos mínimos de cada servidor externo y sus comandos de arranque.
- Exponer los comandos válidos en el README de integración para evitar que futuros lanzadores usen comandos obsoletos.

## Impacto en el producto

- Mejora la fiabilidad de Web Relay Mode.
- Reduce el riesgo de fallos silenciosos de memoria persistente.
- Facilita que el usuario comprenda si el problema está en `claude-mem`, `chrome-devtools-mcp` o `superassistant-proxy`.

## Próximo paso recomendado

1. Verificar el CLI actual de `chrome-devtools-mcp`.
2. Añadir un `healthProbe` a `launch-mcp-stack.ps1` y a `launch-superassistant-proxy.ps1`.
3. Registrar la compatibilidad esperada de cada servidor en `README_MCP_INTEGRATION.md`.

---

## Archivos relacionados
- `superassistant-proxy.config.json`
- `.mcp.json`
- `launch-clause-mem.ps1`
- `launch-mcp-stack.ps1`
- `launch-chrome-devtools-mcp.ps1`
- `README_MCP_INTEGRATION.md`
