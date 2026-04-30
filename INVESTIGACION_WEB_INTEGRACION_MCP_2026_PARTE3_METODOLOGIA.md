# Investigacion Continua (Parte 3): Fiabilidad, Seguridad y Metodo

## Objetivo de esta ronda

Pasar de “ideas de arquitectura” a “criterios de producción”:
- qué medir,
- qué bloquear,
- cómo evaluar confiabilidad real,
- y cómo mejorar el propio proceso de investigación.

---

## 1) Seguridad MCP: lo crítico que faltaba explicitar

Fuentes revisadas (OWASP MCP, patrones de policy-gate, allow/deny por herramienta) convergen en esto:

1. **Least privilege por herramienta y por servidor**  
   - separar lectura/escritura,
   - scopes mínimos por recurso (rutas, tablas, endpoints).

2. **Allowlist/denylist obligatoria**  
   - idealmente por `serverName__toolName`,
   - deny para acciones destructivas por defecto.

3. **Aprobación humana selectiva (no global)**  
   - aprobar solo acciones con efecto externo/financiero/destructivo,
   - evitar fatiga de aprobaciones.

4. **Defensa contra tool poisoning/prompt injection indirecta**  
   - validar y sanear metadatos de herramientas (`description`, schema),
   - detectar drift/rug-pull (`tools/list_changed`),
   - pinning/hash de definiciones de tools aprobadas.

5. **No confiar solo en prompt**  
   - restricciones deben estar en capa de ejecución/política, no solo en instrucciones al modelo.

---

## 2) Observabilidad MCP: trazabilidad completa de tool-calls

La evidencia favorece instrumentar con OpenTelemetry y convenciones MCP:
- trazas por sesión,
- spans por tool call,
- correlación con contexto de transporte.

### Métricas mínimas recomendadas para tu proyecto

- `mode_switch_count` (`api -> web`, `web -> api`, `auto decisions`)
- `tool_call_success_rate` por servidor y por tool
- `tool_call_latency_p50/p95/p99`
- `fallback_rate` (cuántas veces web cae a api)
- `approval_required_rate` y `approval_reject_rate`
- `injection_detection_events`

### Decisión práctica

Tu arquitectura debe incluir una **capa de telemetría obligatoria** antes de escalar a multi-agente web.

---

## 3) SLOs para decidir API vs Web con datos reales

En vez de decidir por intuición, define SLOs y error budgets por modo.

## SLO iniciales sugeridos

- **Conversación simple (API mode):**
  - TTFT p95 < 1.2s
  - error < 2%

- **Web Relay mode:**
  - tiempo total p95 < 8s
  - `tool_call_success_rate` > 95%
  - `session_connect_success` > 98%

- **Auto mode (routing):**
  - precisión de routing (evaluación offline) > 85%
  - `wrong-mode penalty` (casos con fallback inmediato) < 10%

## Burn-rate operativo

Alertar por consumo de presupuesto de error, no solo por picos aislados.

---

## 4) Evaluación de confiabilidad: más allá de pass@1

La literatura reciente sugiere que pass@1 no alcanza para agentes con tools.
Hay que medir:

- **Consistencia multi-run** (`pass^k`)
- **Robustez a perturbaciones semánticas**
- **Tolerancia a fallas inyectadas** (timeout, 429, schema drift)
- **Degradación por tareas largas** (long-horizon decay)

### Implicación para tu proyecto

Cuando evalúes el modo web, no basta “funcionó una vez”.
Necesitas corridas repetidas y escenarios con fallas controladas.

---

## 5) Arquitectura v4 (actualizada con esta ronda)

## Capa A — Mode Control Plane
- `api | web | auto`
- enrutamiento y fallback
- reason codes por decisión

## Capa B — Security & Policy Plane
- allow/deny por tool
- aprobación selectiva
- detección de drift/prompt poisoning
- capability tokens de corta vida (ideal)

## Capa C — Observability Plane
- OTel traces + métricas de SLO/burn rate
- auditoría de decisiones y acciones

## Capa D — Execution Plane
- API provider path
- Web Relay path (SuperAssistant)
- opcional Playwright MCP para automatización determinista

## Capa E — Memory Plane
- baseline: `claude-mem`
- evolución: Mem0 o Graphiti según necesidad temporal/escalabilidad

---

## 6) Qué cambiaría ahora en tu roadmap

1. **Antes de más features**, instrumentar métricas y eventos (sin esto no hay decisión objetiva).
2. Implementar `tools policy` desde el inicio del Mode Controller.
3. Mover pruebas principales del proxy a Streamable HTTP.
4. Crear un mini “reliability harness” de 20-30 escenarios repetibles.
5. Recién después, escalar a auto-routing y multi-agente web.

---

## 7) Mejoras en mi enfoque de investigación (explícitas)

Estas son mejoras concretas que aplico y te propongo mantener:

1. **De exploración amplia a investigación por hipótesis**  
   Antes: buscar “qué existe”.  
   Ahora: validar hipótesis concretas (“¿SSE debe ser fallback?”, “¿qué SLO decide modo?”).

2. **Priorizar fuentes normativas y técnicas sobre contenido opinativo**  
   - subir peso de specs/docs oficiales (MCP spec, OpenAI/Anthropic docs, OWASP),
   - bajar peso de blogs no verificables para decisiones críticas.

3. **Separar evidencia por nivel de confianza**  
   - Nivel A: especificaciones oficiales y documentación de proveedor,
   - Nivel B: repos OSS activos con adopción real,
   - Nivel C: artículos/ensayos (solo para ideas, no para políticas finales).

4. **Pasar de “arquitectura bonita” a “criterios medibles”**  
   Cada recomendación debe tener métrica asociada (latencia, éxito tool call, burn rate, etc.).

5. **Incluir desde ya threat-modeling y guardrails**  
   No dejar seguridad para “fase final”; tool poisoning y aprobaciones deben entrar en diseño base.

6. **Diseñar experimentos de decisión, no solo documentos**  
   Proponer test harness y corridas repetidas para comparar API vs Web con evidencia.

7. **Cierre por decisiones accionables**  
   Cada ronda termina con: qué decisión tomar ahora, qué medir, qué posponer.

---

## 8) Resultado de esta mejora metodológica

La integración deja de ser “una idea útil” y pasa a ser un **programa de ingeniería**:
- con políticas de seguridad,
- con SLOs,
- con observabilidad,
- y con evaluación de confiabilidad reproducible.

Eso reduce bastante el riesgo de construir algo llamativo pero frágil.
