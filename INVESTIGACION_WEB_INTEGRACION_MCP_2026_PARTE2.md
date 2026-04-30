# Investigacion Continua (Parte 2): Arquitectura Web + MCP

## Enfoque de esta segunda ronda

Se investigaron temas que afectan directamente viabilidad en producción:
- transporte MCP (SSE vs Streamable HTTP),
- gateways/orquestadores MCP,
- memoria persistente avanzada,
- patrones API modernos (OpenAI/Anthropic MCP remoto),
- riesgos operativos de automatización web.

---

## Hallazgos nuevos que sí cambian decisiones

## 1) Transporte: Streamable HTTP debe ser el estándar

La especificación MCP más reciente deja claro que `HTTP+SSE` es legado y `Streamable HTTP` es el camino recomendado para nuevos despliegues.

### Implicación para tu proyecto
- Mantén compatibilidad SSE para MCP-SuperAssistant si hace falta.
- Pero el **modo estable** de tu stack debe converger a `.../mcp` (Streamable HTTP).
- Esto mejora compatibilidad con balanceadores, proxies, infraestructura stateless y reintentos.

### Decisión práctica
- `superassistant-proxy` en modo streamableHttp para pruebas principales.
- SSE solo como fallback/controlado.

---

## 2) Tu arquitectura necesita “policy layer” para tools remotas

OpenAI y Anthropic en sus flujos MCP remotos refuerzan:
- allowlist de tools,
- aprobación por tool (o no aprobación selectiva),
- manejo explícito de headers/tokens por request.

### Implicación
Tu “Web Relay Mode” no debería ser solo “reenviar mensajes”; necesita política por herramienta:
- `allowed_tools` por proveedor/plataforma,
- niveles de aprobación (`always`, `never`, o parcial),
- logging de invocaciones sensibles.

---

## 3) Memoria: claude-mem está bien, pero hay opciones más robustas

Se detectaron opciones de memoria MCP con mejor control operativo:
- **Mem0 MCP**: tools de add/search/update/delete con hosting remoto y self-host.
- **Graphiti MCP**: memoria temporal en grafo (Neo4j/FalkorDB), útil para contexto dinámico y trazabilidad histórica.

### Recomendación
- Mantener `claude-mem` como baseline.
- Evaluar piloto con Mem0 (rápido) o Graphiti (avanzado) para tareas de largo plazo.

---

## 4) Gateways MCP ya resuelven problemas que tú vas a tener

Proyectos como `agentgateway` o `metamcp` resuelven:
- agregación de múltiples servidores,
- namespacing,
- auth,
- observabilidad,
- gobernanza de herramientas.

### Implicación
Si tu visión incluye “múltiples interfaces + agentes web”, te conviene introducir gateway pronto (fase 2/3), no dejarlo para el final.

---

## 5) Agentes web: viables, pero su límite real es infraestructura

La evidencia coincide: el problema no es solo script stealth.
Los bloqueos suelen venir por:
- reputación IP,
- consistencia de fingerprint,
- patrones de tráfico,
- calidad de sesión persistente.

### Implicación
Para “Web Relay Mode” en serio:
- rate-limits por plataforma,
- sesiones persistentes,
- monitoreo de challenge rate/captcha rate,
- fallback inmediato a API mode.

---

## Arquitectura revisada (v3)

## Capa 1: Mode Controller (Control Plane)

Estados:
- `api`
- `web`
- `auto`

Responsable de:
- routing por intención,
- fallback,
- selección de plataforma web objetivo,
- visibilidad de estado (“connected/degraded/fallback”).

## Capa 2: MCP Gateway Plane

Responsable de:
- agrupar servers MCP,
- permitir/denegar tools,
- políticas por perfil,
- auth y rotación de credenciales.

Puede iniciar con SuperAssistant proxy y luego migrar a gateway más completo.

## Capa 3: Memory Plane

Responsable de:
- persistencia entre modos y sesiones,
- recuperación contextual mínima relevante,
- auditoría de qué memoria se inyectó y por qué.

Implementación inicial:
- `claude-mem`

Evolución:
- Mem0 o Graphiti según necesidad de escala/temporalidad.

## Capa 4: Web Execution Plane

Responsable de:
- puentes a interfaz web (SuperAssistant),
- automatización determinista (Playwright MCP opcional),
- health checks de sesión/plataforma.

---

## Nuevas opciones de integración (además del toggle)

## Opción E: “Policy-Gated Web Relay”

Tu idea de botón, pero con perfiles:
- Perfil `safe`: solo tools de lectura.
- Perfil `ops`: herramientas operativas con aprobación.
- Perfil `full`: todo permitido (entorno controlado).

**Ventaja:** controlas riesgos sin romper UX.

---

## Opción F: “MCP Broker as a Product”

OpenClaude no se conecta directo a cada server, sino a un broker/gateway central.
El broker decide tool surface por usuario, proyecto y modo.

**Ventaja:** cuando crezcas a multiagente, ya tienes base de gobernanza.

---

## Opción G: “Hybrid API + Remote MCP via provider”

Usar patrones de OpenAI/Anthropic MCP remoto:
- request principal por API,
- tools remotas MCP con allowlist/aprobaciones,
- sin necesidad de relay web para todo.

**Ventaja:** menor fragilidad DOM.
**Desventaja:** no aprovecha UX de interfaces web como querías.

---

## Opción H: “A2A-aware future” (opcional avanzado)

Explorado en registros tipo MCP-gateway-registry:
- discovery de agentes por capacidades,
- invocación de agentes remotos.

Esto no sustituye MCP tools; lo complementa para colaboración agente-a-agente.

**Recomendación:** solo después de estabilizar API/Web/Auto.

---

## Recomendaciones accionables inmediatas

1. Cambiar pruebas de proxy a `streamableHttp` como ruta principal.
2. Definir política de tool approvals por modo.
3. Crear métrica mínima:
   - latencia por modo,
   - error rate por modo,
   - fallback frequency.
4. Diseñar contratos de `ModeController` (api/web/auto + reason codes).
5. Preparar PoC de memoria alternativa (Mem0 o Graphiti) en branch aislada.

---

## Fuentes nuevas usadas en esta ronda

### Especificación / transporte
- [MCP Transports (spec)](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

### Gateways / agregadores
- [agentgateway/agentgateway](https://github.com/agentgateway/agentgateway)
- [metatool-ai/metamcp](https://github.com/metatool-ai/metamcp)

### Memoria
- [Mem0 MCP Docs](https://docs.mem0.ai/platform/mem0-mcp)
- [mem0ai/mem0-mcp](https://github.com/mem0ai/mem0-mcp)
- [getzep/graphiti](https://github.com/getzep/graphiti)

### Integración MCP en APIs
- [OpenAI MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Anthropic MCP connector](https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector)

### Operación web automation
- [Playwright anti-bot guidance (BrowserStack)](https://www.browserstack.com/guide/playwright-bot-detection)
- [Browserless stealth operations](https://www.browserless.io/blog/browserless-playwright-stealth-guide)

---

## Conclusión de esta ronda

Tu dirección es correcta, pero ahora está más clara:
- **botón de alternancia sí** (es el núcleo UX),
- **Streamable HTTP como base** (no SSE-first),
- **políticas de tools y memoria como capas explícitas**,
- **gateway temprano** para no colapsar cuando escales a multi interfaz/agentes web.

Esta combinación te da una ruta sólida: usable hoy, extensible mañana.
