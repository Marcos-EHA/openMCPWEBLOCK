# Investigacion Continua (Parte 4): Gobernanza, Cumplimiento y Rollout Seguro

## Por qué esta parte cambia el enfoque

Esta ronda no agrega solo tecnología: agrega **límites operativos reales**.
El hallazgo más importante es que varias plataformas de consumo restringen automatización no humana en sus interfaces web.

Eso impacta directamente cualquier diseño de “relay” que opere sobre chats web de consumo.

---

## 1) Cumplimiento/TOS: hallazgo crítico

Revisión de términos y políticas públicas (OpenAI/Anthropic) indica que:
- el acceso automatizado a productos de consumo web puede estar prohibido o restringido,
- el camino permitido para automatización suele ser API/commercial terms,
- violaciones pueden terminar en suspensión o bloqueo de cuenta.

## Implicación directa para tu arquitectura

Tu “Web Relay Mode” debe diseñarse con un **modo de cumplimiento**:

1. **Default recomendado:** API oficial (provider-compliant mode).
2. **Web relay:** solo cuando esté claramente permitido por términos aplicables y contexto de uso.
3. **Policy guard:** bloquear rutas no permitidas por proveedor/cuenta/entorno.

## Recomendación práctica

Agregar una capa `CompliancePolicy` al `Mode Controller`:
- `allow_web_relay_for_provider(provider, accountType, environment) -> bool`
- reason codes si se bloquea (`TERMS_RESTRICTED_AUTOMATION`, etc.).

---

## 2) Rollout seguro: no desplegar “modo web” en big bang

Patrones de canary + feature flags para agentes:
- rollout 1% -> 5% -> 25% -> 50% -> 100%,
- bake windows y umbrales por fase,
- rollback automático por SLO breach.

## Métricas de promoción sugeridas

- error rate delta vs estable
- p95 latencia delta vs estable
- safety/event flags
- costo por tarea
- fallback rate

Si canary empeora frente a baseline, rollback inmediato.

---

## 3) Estándar de feature flags para evitar lock-in

OpenFeature aparece como estándar útil:
- API vendor-agnostic para evaluación de flags,
- providers intercambiables,
- hooks para telemetría y control.

## Decisión sugerida

Modelar `mode=api|web|auto` como flag evaluable por OpenFeature (o equivalente):
- facilita canary por cohorte,
- simplifica kill-switch global.

---

## 4) Red Teaming de agentes: llevar seguridad a CI/CD

Herramientas y guías (Promptfoo + patrones de explotación agente/tool) sugieren:
- pruebas automáticas de prompt injection,
- pruebas de tool misuse/exfiltration,
- pruebas de memory poisoning,
- pruebas de policy bypass.

## Política mínima

Cada cambio en:
- prompt,
- tools policy,
- memory policy,
- mode routing

debe pasar un suite de red-team básico antes de promoción.

---

## 5) Riesgos OWASP para agentes aplicados a tu caso

Riesgos relevantes para tu integración:
- Goal hijack
- Tool misuse/exploitation
- Identity/privilege abuse
- Memory/context poisoning
- Cascading failures
- Human-agent trust exploitation

## Traducción a controles concretos

- allow/deny por tool + least privilege
- approvals selectivas para efectos externos
- aislamiento de herramientas privilegiadas
- límites de cadena de herramientas y profundidad de delegación
- circuit breakers y budgets para cortar fallas en cascada

---

## 6) Cost governance: decidir modo por costo real

También faltaba esto en versiones previas:
- instrumentar costo por tarea, no solo por request,
- atribuir costo por `modo`, `tool`, `provider`, `feature`,
- activar alertas y presupuestos.

Esto permite que `Auto Mode` use también criterio económico:
- si calidad similar y costo menor, priorizar ruta más eficiente.

---

## 7) Arquitectura v5 (con gobernanza completa)

## Capa 1: Mode Controller
- `api|web|auto`
- fallback y reason codes

## Capa 2: Compliance Gate
- evalúa términos/políticas por proveedor y tipo de cuenta
- bloquea rutas de alto riesgo legal

## Capa 3: Security Policy Gate
- allow/deny tools
- approvals
- anti-poisoning / drift detection

## Capa 4: Observability + SLO
- OTel
- burn rate
- promoción/rollback

## Capa 5: Cost Governance
- costo por tarea/modo
- budget caps y alertas

## Capa 6: Execution
- API path (preferido)
- Web relay path (controlado)

---

## 8) Cambios recomendados al plan inmediatamente

1. Añadir `CompliancePolicy` al diseño del Mode Controller.
2. Marcar `Web Relay` como capability “gated” por entorno (dev/staging/prod).
3. Implementar feature flag + canary rollout para `mode=web`.
4. Integrar mini red-team suite en CI para cambios de tools/prompt/mode.
5. Definir presupuesto de costo y alertas por modo.

---

## Conclusión

La investigación sigue validando tu visión del alternador, pero ahora con una precisión clave:

- técnicamente viable, sí;
- operativamente útil, sí;
- **pero debe ser compliance-aware y gobernado por políticas, SLOs y costos**.

Sin esa capa de gobernanza, el sistema puede funcionar en demos pero fallar en producción real.
