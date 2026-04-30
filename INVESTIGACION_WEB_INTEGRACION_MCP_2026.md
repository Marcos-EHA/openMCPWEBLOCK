# Investigacion Web Adicional: Integracion OpenClaude + SuperAssistant (2026)

## Que se investigó

Se amplió la búsqueda en internet con foco en:
- repositorios MCP relevantes (gateways, agregadores, directorios),
- plataformas de chat OSS con integración MCP madura,
- patrones de agentes web y automatización,
- herramientas que podrían mejorar tu arquitectura de `API mode` + `Web mode`.

---

## Hallazgos clave (resumen ejecutivo)

1. El ecosistema MCP ya tiene patrones de **gateway/orquestación** listos para producción (no conviene reinventarlos desde cero).
2. Para apps web multiusuario, la tendencia es **Streamable HTTP** como transporte principal; SSE queda como compatibilidad.
3. Tu idea del botón alternador se alinea con lo que ya hacen plataformas como LibreChat/Open WebUI: UX de tools por chat + activación selectiva.
4. La arquitectura más fuerte para tu proyecto es un **Control Plane de Modos** (API/Web/Auto) + **Data Plane de Tooling** (proxy/gateway/memoria).
5. La evolución a “agentes web” es viable, pero debe ir después de estabilizar routing, sesión y observabilidad.

---

## Fuentes y repositorios útiles

## 1) Directorios MCP (descubrimiento)

- [coreyrab/awesome-mcp-servers](https://github.com/coreyrab/awesome-mcp-servers)
- [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)
- [mcpservers.org](https://mcpservers.org/)

**Para qué te sirve:**  
Crear una “lista curada” de servers compatibles con tus casos de uso (memoria, browser, docs, APIs de negocio) sin depender solo de SuperAssistant.

---

## 2) Gateways/Agregadores MCP (muy relevante)

- [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway)  
  Proxy agentic con seguridad/observabilidad/gobernanza.
- [metatool-ai/metamcp](https://github.com/metatool-ai/metamcp)  
  Agregador/orquestador MCP con namespaces, middlewares y endpoints.
- [Kuadrant/mcp-gateway](https://github.com/Kuadrant/mcp-gateway)  
  enfoque K8s/Envoy/políticas enterprise.

**Idea práctica:**  
SuperAssistant puede seguir como bridge al navegador, pero un gateway dedicado puede convertirse en tu “capa central” de tools para controlar permisos, prefijos, auth y telemetría.

---

## 3) Plataformas chat OSS con MCP maduro

- [LibreChat MCP docs](https://librechat.ai/docs/features/mcp)
- [Open WebUI MCP docs](https://docs.openwebui.com/features/extensibility/mcp/)

**Patrones que conviene copiar:**
- habilitar tools por chat (no global obligatorio),
- selección por servidor/tool,
- soporte OAuth y credenciales por usuario,
- “default enabled tools” opcional,
- conexión por Streamable HTTP preferente.

---

## 4) Browser automation + Web agents

- [Playwright MCP](https://playwright.dev/docs/getting-started-mcp)
- [microsoft/Playwright-MCP](https://github.com/microsoft/Playwright-MCP)
- [browser-use](https://github.com/browser-use/browser-use)
- ejemplos de arquitectura con LangGraph + browser loops.

**Conclusión:**  
Para “agentes web”, Playwright MCP da base determinista (click/snapshot/trace), mientras SuperAssistant da puente directo en UIs de chats web. Son complementarios.

---

## 5) Integración SaaS por MCP gestionado

- [Composio MCP](https://docs.composio.dev/reference/api-reference/mcp)

**Valor:**  
Conecta apps (Gmail, etc.) con menor fricción operativa, útil si luego quieres tools “de negocio” además del navegador.

---

## Lo nuevo que cambia la arquitectura

Lo más importante de esta investigación: **necesitas separar explícitamente “control de experiencia” y “ejecución de herramientas”**.

- **Control Plane (UX + Routing):** decide `api|web|auto`, plataforma web destino, fallback, política de latencia.
- **Data Plane (Tool Infra):** proxy/gateway MCP, auth, herramientas, memoria, observabilidad.

Sin esta separación, el sistema se vuelve frágil cuando crecen proveedores, tools y sesiones.

---

## Arquitecturas revisadas (v2)

## A) Arquitectura “Toggle Relay” (tu idea, refinada)

### Flujo
1. Usuario alterna botón `API` / `Web`.
2. Si `Web`:
   - verifica proxy/gateway activo,
   - selecciona interfaz objetivo (ChatGPT/Gemini/etc.),
   - aplica prompt/instrucciones específicas por interfaz,
   - relaya mensajes entre OpenClaude y sesión web.
3. Si hay error o timeout -> fallback a `API`.

### Pros
- UX simple y controlada.
- Mantienes conversación central en OpenClaude.

### Contras
- Dependencia fuerte de sesión web y estabilidad DOM.

### Recomendación
- Mantener esta como **arquitectura principal de producto**.

---

## B) Arquitectura “Auto Router” por intención + latencia

### Flujo
- Clasificador decide por turno:
  - simple chat -> API,
  - tool-heavy / web-required -> Web.
- También considera métricas en caliente:
  - si API está lenta o con colas, prioriza Web.

### Pros
- Mejor costo/latencia global.
- Menos clicks.

### Contras
- Necesita telemetría confiable y reglas buenas.

### Recomendación
- Implementar después del Toggle manual estable.

---

## C) Arquitectura “Gateway-Centric”

### Flujo
- OpenClaude y SuperAssistant consumen un endpoint MCP agregado (gateway).
- El gateway expone toolsets versionados y políticas.

### Pros
- Seguridad y gobernanza.
- Tool naming estable, menos caos al escalar.

### Contras
- Más infraestructura.

### Recomendación
- Excelente para fase 2/3 si quieres escalar serio.

---

## D) Arquitectura “Web Agent Mesh” (avanzada)

### Flujo
- Varios agentes web paralelos (por interfaz o por tarea).
- Orquestador reparte subtareas y consolida.

### Pros
- Alto throughput y cobertura.

### Contras
- Alta complejidad, debugging difícil, mayor costo.

### Recomendación
- Solo después de tener observabilidad, retries y límites maduros.

---

## Propuesta concreta para tu caso (roadmap actualizado)

## Fase 1: Consolidación inmediata (1-3 días)
- mantener `API mode` como default,
- `Web mode` con SuperAssistant + proxy,
- health checks y fallback automático,
- memoria con `claude-mem` (resumen por tarea).

## Fase 2: Botón “Web Relay Mode” real (3-7 días)
- selector de plataforma web,
- plantillas de instrucciones por plataforma,
- estado visible: `connected/disconnected/degraded`,
- botón de “reintentar sesión” y “volver a API”.

## Fase 3: Auto-routing (1-2 semanas)
- reglas por intención + umbrales de latencia,
- bitácora de decisión por turno,
- aprendizaje simple (preferencias por tipo de tarea).

## Fase 4: Gateway + Agentes web (opcional)
- introducir MetaMCP/Agentgateway,
- mover políticas y auth al gateway,
- piloto de multi-agente web para tareas largas.

---

## Riesgos identificados y mitigación

1. **Inestabilidad SSE/reconexión**  
   - Priorizar Streamable HTTP donde aplique.

2. **Cambios en DOM de plataformas web**  
   - Adaptadores por interfaz + tests de humo.

3. **Deriva de contexto entre modos**  
   - sincronizar resumen al `claude-mem` en cada cambio de modo.

4. **Exceso de herramientas activas**  
   - perfiles de tools por tarea (mínimo necesario).

5. **Privacidad/secrets en relay web**  
   - redacción previa y whitelist de dominios.

---

## Decisión sugerida ahora

Implementar primero este patrón:

`OpenClaude UI -> Mode Controller (API/Web/Auto) -> SuperAssistant Bridge + MCP Gateway -> Tools + Memory`

Con eso obtienes:
- UX clara para charla simple,
- activación potente cuando toca usar tools web,
- base sólida para crecer a agentes web sin reescribir todo.

