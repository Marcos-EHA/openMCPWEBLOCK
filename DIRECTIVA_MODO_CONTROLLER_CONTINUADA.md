# Directiva Continuada: Mode Controller + MVP + Web Relay

## 1) Punto de partida

Tu idea inicial fue clara: un **botón/toggle** que permita alternar entre:
- `API Mode` para ejecución directa rápida,
- `Web Relay Mode` para usar el puente SuperAssistant, permitiendome elegir entre los navegadores a los que quiero entrar. (usando MCP google)

Este documento toma esa directiva y la expande con los avances descubiertos en la integración actual.

---

## 2) Lo que ya se ha logrado

### 2.1 Implementación MVP
- Se creó un `Mode Controller` en OpenClaude.
- Se agregó `/mcp set-mode api|web|auto`.
- Se guardó el modo en `ProjectConfig.mcpExecutionMode`.
- Se ajustó `assembleToolPool()` para filtrar MCP tools según modo.
- Se configuró un proxy `superassistant-proxy` con `streamableHttp` en `.mcp.json`.

### 2.2 Resultados prácticos
- `api` = solo herramientas built-in.
- `web` = solo herramientas MCP del servidor `superassistant-proxy`.
- `auto` = incluye todas las herramientas MCP disponibles.

### 2.3 Validación
- Proxy arranca y responde.
- Herramientas MCP se listan y se seleccionan según el modo.
- Comando `/mcp set-mode` funciona.
- La integración es compatible y no rompe el flujo original.

---

## 3) Avances importantes desde la primera directiva

### 3.1 SuperAssistant ya no es solo una extensión web
- El puente actual es un proxy local (`@srbhptl39/mcp-superassistant-proxy`).
- El transporte recomendado es `streamableHttp`, con SSE como compatibilidad secundaria.
- Esto hace más robusta la conexión entre OpenClaude y la interfaz web.

### 3.2 `claude-mem` sigue siendo la memoria de referencia
- Está declarado en `.mcp.json` como servidor `stdio`.
- Su función es mantener contexto persistente para las sesiones.
- Hay una limitación conocida: el comando `npx claude-mem server` puede no existir en versiones actuales.

### 3.3 Playwright MCP y Google MCP son herramientas complementarias
- Playwright MCP aporta automatización determinista y reproducible para navegación web.
- Google MCP está diseñado para automatización interna del funcionamiento de Google (como Drive, Docs, Calendar), no específicamente para comunicación web con IA. Sin embargo, al funcionar la extensión en Google, puede usarse como puente para comunicación web con IA en navegadores Google.
- Ambos quedan como extensiones de la arquitectura, no como reemplazo del toggle.

---

## 4) Nueva arquitectura recomendada

### 4.1 Control Plane: Mode Controller
- `API Mode` = experiencia conversacional rápida.
- `Web Relay Mode` = puente SuperAssistant por demanda.
- `Auto Mode` = permitir todas las herramientas y dejar que el sistema elija.

Este plano decide qué superficie de herramientas está disponible.

### 4.2 Data Plane: Tooling y proxy
- `superassistant-proxy` = gateway local MCP para puente con interfaces web.
- `claude-mem` = servidor de memoria persistente.
- Playwright MCP = servidor opcional para automatización web determinista.
- Google MCP = servidor opcional para automatización interna de Google (Drive/Docs/Calendar), utilizable como puente en navegadores Google para comunicación web con IA.

### 4.3 Memory Plane: contexto persistente
- Básico: `claude-mem`.
- Evolución: `Mem0` o `Graphiti` si necesitas más escala/temporalidad.

---

## 5) Cómo evolucionar la directiva ahora

### 5.1 Mantener el toggle como forma UX principal
- El botón sigue siendo la mejor forma de dar control claro.
- No lo conviertas en un switch automático hasta que el enrutamiento sea confiable.

### 5.2 Agregar políticas por perfil
- `safe`: solo lectura y consultas.
- `ops`: acciones web controladas.
- `full`: todas las herramientas en entorno seguro.

Esto protege la UX sin sacrificar la capacidad de automatización.

### 5.3 Implementar telemetría mínima
- Latencia por modo.
- Tasa de fallback.
- Errores de proxy / herramientas MCP.

### 5.4 Preparar el gateway como evolución natural
- Comienza con `superassistant-proxy`.
- Planea un broker MCP más completo cuando agregues Playwright/Google MCP.
- El broker debe poder aprobar tools por proyecto y por usuario.

---

## 6) Directiva actualizada con tus descubrimientos

1. **Lleva el toggle al usuario**: sigue siendo el núcleo de la experiencia, permitiendo elegir entre comunicación directa vía APIs o comunicación web con IA.
2. **Usa `streamableHttp` como transporte principal** para SuperAssistant.
3. **Conserva `claude-mem` como baseline de memoria**.
4. **Trata a Playwright MCP y Google MCP como herramientas especializadas**: Playwright para automatización web, Google MCP para automatización interna de Google y puente en navegadores Google.
5. **Web Relay Mode como alternativa a APIs**: dado que las APIs gratuitas tienen demoras significativas, Web Relay Mode se concentra en comunicación web directa con IA, dejando de lado las APIs para evitar costos y limitaciones.
6. **No dependas del DOM web para todas las tareas**: usa automatización determinista cuando no quieras fragilidad de sitio.
7. **Define perfiles de uso** antes de habilitar el modo web a todo el equipo.
8. **Prepara un broker/gateway MCP** para el siguiente salto.

---

## 7) Próximo paso inmediato

### En este proyecto ya
- Añadir `MCPModeIndicator` y comando `/mcp status`.
- Añadir métricas de modo y health checks del proxy.
- Validar `claude-mem` o documentar su corrección necesaria.

### Para la siguiente iteración
- Integrar Playwright MCP como servidor opcional.
- Integrar Google MCP para capacidades empresariales.
- Crear un runbook de `Web Relay Mode` con perfiles `safe/ops/full`.

---

## 8) Nota final

Esta directiva es la continuación natural de tu idea original: un modo rápido (API) y un modo web bajo demanda (Web Relay Mode), ahora enriquecidos con la realidad operativa de `superassistant-proxy`, `claude-mem`, `streamableHttp`, Playwright MCP y Google MCP. El enfoque principal es usar Web Relay Mode como alternativa viable a las APIs gratuitas lentas, concentrándose en comunicación web directa con IA sin costos adicionales.
