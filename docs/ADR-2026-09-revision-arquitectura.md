# ADR — Revisión de arquitectura y correcciones críticas (2026-09-17)

> Registro de decisiones y hallazgos de una auditoría independiente sobre `main@8779c0a`.
> Documento completo de arquitectura (15 secciones, invariantes, roadmap, event model,
> observabilidad, UX, escalabilidad, testing): https://claude.ai/artifact/LRfLjGtjcYW8Mhwy53Hpo9

## Hallazgo que reordena el roadmap

**El aislamiento de MultiAgent V1 nunca estuvo en vigor.** Cuatro defectos independientes
colapsaban N agentes en uno, y cada uno bastaba por sí solo:

1. `WebRelayProvider.ts` llamaba `launchChrome(url, 'Default', ...)` — literal, para cada
   instancia. `ChromeCDP.ts` advierte en su propia cabecera que Chrome permite **una sola
   instancia por `user-data-dir`**. `webInstance.profileDir` (único) no se pasaba nunca.
2. `WebInstanceRegistry.nextDebugPort()` asignaba desde un `Set` en RAM. Tras reiniciar el
   CLI devolvía 9222 mientras el Chrome anterior seguía escuchando ahí.
3. `ExecutionRegistry.executionKey(callId, instanceId?)` — `instanceId` opcional. Sin él,
   todos los agentes compartían un keyspace global indexado por el `callId` del modelo.
4. `resolveWebInstance` usa `getAgentId() ?? MAIN_WEB_AGENT_KEY`: sin `agentId` lógico,
   todos los agentes resuelven a la misma instancia.

**Consecuencia epistémica:** toda la evidencia de "esto funciona" recogida hasta hoy
describe un sistema de **un solo agente**. No hay datos calibrados sobre comportamiento
multi-agente.

**Implicación para el roadmap:** insertar una **Fase 0.5 — Prueba de aislamiento** antes de
cualquier trabajo sobre MultiAgentRunner. GO: dos agentes, 30 min, mismo `callId` en ambos,
cero cruces, cero duplicados efectivos. NO-GO: un solo cruce invalida la fase siguiente.

## Correcciones aplicadas

| Fichero | Cambio |
|---|---|
| `src/services/webRelay/WebRelayProvider.ts` | Pasa `webInstance.profileDir` en vez de `'Default'`. Pasa `instanceId` como scope de dedup a `executeToolCall`. |
| `src/services/webRelay/WebInstanceRegistry.ts` | Puertos por lock file en disco con verificación de PID. Binding agente↔instancia como lease append-only con historial. Máquina de estados validada. `verifyInstanceIdentity()` que falla cerrada. No reutiliza instancia entre plataformas. |
| `chrome-extension/.../background/ExecutionRegistry.ts` | Separa dirección (`scope:callId`) de identidad (`executionId` acuñado) de deduplicación (`idempotencyKey` con ventana TTL). Ámbito cae al `bootId`, nunca al `callId` desnudo. Mutaciones serializadas. Reconciliación en arranque con anotación de liveness. Offload de resultados >8 KB. Retención. `canAutoRetry()`. API exportada sin cambios. |
| `chrome-extension/.../types/messages.ts` | Campos opcionales: `executionId`, `bootId`, `attempt`, `revision`, `idempotencyKey`, `effectClass`, `livenessUnknown`, `unknownOutcome`, `resultRef`, `resultBytes`, `resultTruncated`. `ExecutionStatus` **sin cambios**: liveness es anotación, no estado. |
| `src/services/webRelay/WebToolBridge.ts` | Clases de efecto (`pure`/`idempotent-keyed`/`effectful`; desconocido ⇒ `effectful`). Guarda anti-duplicado con ámbito por instancia. IDs con UUID en vez de `Date.now()-idx`. Truncado explícito. `allowed_directories` desde `OPENMCPWEBLOCK_ALLOWED_DIRS`, rechaza raíces de unidad. |
| `src/services/webRelay/invariants.test.ts` | **Nuevo.** 17 invariantes arquitectónicos ejecutables. `bun test src/services/webRelay/invariants.test.ts` |

Cero errores de compilación nuevos. 17/17 tests en verde.

## Pendientes conocidos (no arreglados)

- **A7 — Correlación por índice aritmético.** `waitForNewAssistantMessage(conn, adapter, msgCountBefore + loopCount - 1, ...)`: cualquier mensaje que la página añada fuera de banda desplaza la ventana y el runtime lee el mensaje equivocado como resultado. Necesita discriminador de contenido + `correlationId`.
- **A8 — Servidor MCP singleton.** `let mcpServer` de módulo, compartido por todos los agentes. Bloquea las políticas de capacidades por agente (un especialista de auditoría no puede tener prohibido `Bash`).
- **A9 — Inicialización global por agente.** `ensureInitialized` invoca `runStartupCheck()` y `configureSAForMCP()`, que tocan estado global, una vez por instancia. Carrera con N agentes concurrentes.
- **A10 — Sesión de plataforma como recurso compartido.** Perfiles separados aíslan de bugs propios, no de la cuota, la caducidad de sesión ni el riesgo de cuenta de ChatGPT. El límite real de concurrencia lo fija la plataforma, no la RAM.
- **Estado durable.** Sigue en `Map` de RAM y `chrome.storage.local`. Debe pasar a SQLite WAL en el runtime, un solo escritor; la extensión refleja, no almacena.
- **Log de eventos.** No existe. Es el único prerrequisito verdaderamente irreversible para que Sentinel sea aditivo en vez de reescritura.

## Decisiones a congelar antes de seguir

| # | Decisión | Recomendación | Reversibilidad |
|---|---|---|---|
| D1 | Fuente de identidad de ejecución | `executionId` acuñado por el servidor + `idempotencyKey` separada | Muy baja — **aplicada** |
| D2 | Dónde vive la identidad del agente | En la **conexión**, no en el payload; el sello es verificación redundante | Baja |
| D3 | Log de eventos append-only | Ahora. Determina si Sentinel es aditivo o reescritura | Muy baja |
| D4 | Estado durable | SQLite WAL en el runtime, un solo escritor | Media-baja |
| D5 | Clases de efecto por herramienta | Obligatorias en el registro; rechazo si faltan | Media — **aplicada** |
| D6 | Modelo de estado | Ciclo de vida + liveness + entrega + retención, ortogonales | Media-baja — **aplicada** |
| D7 | Binding agente↔instancia | Lease append-only revocable (habilita pooling futuro) | Media — **aplicada** |
| D8 | Ámbito del servidor MCP | Por agente, con lista de capacidades | Media |
| D9 | Correlación de respuestas | Discriminador de contenido, no aritmética de índices | Alta, pero falla en silencio |
| D10 | Versionado de protocolo con la extensión | Handshake + negativa a operar. Fallar ruidosamente | Alta |
| D11 | Planificación de Sentinel | Playbooks estáticos antes que LLM | Alta si la interfaz está separada |
| D12 | Sustrato inmutable por misión | `git worktree` sobre commit fijado para misiones de lectura | Alta. Mejor coste/beneficio |

## Límites propuestos (a calibrar con medición)

- Instancias Chrome concurrentes: 6 por defecto, techo duro 12
- Ejecuciones concurrentes por agente: 1
- Profundidad de cola por agente: 32, luego rechazo
- Proyección de resultado inyectada en la página: ≤ 8 KB
- Payload de evento: 16 KB duro
- Concurrencia por cuota de plataforma: derivada del rate limit observado, **no de la RAM**

## Invariantes que no deben romperse

Codificados en `src/services/webRelay/invariants.test.ts`. Un fallo ahí es una regresión de
diseño, no un test frágil. Los tres que más importan:

1. La identidad nunca deriva de la salida del modelo.
2. Ningún ámbito de identidad es global por defecto; sin `instanceId` se degrada al `bootId`.
3. Re-entregar nunca es re-ejecutar; lo `effectful` nunca se auto-reintenta.
