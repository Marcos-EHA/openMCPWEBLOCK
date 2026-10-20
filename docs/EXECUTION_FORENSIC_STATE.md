# Execution Forensic State — documento de coordinación

**No lo borres ni lo ignores.** Este archivo existe para que una sesión futura de Claude (u otra persona) no repita la auditoría de cero. Si vas a tocar `ExecutionRegistry.ts`, `storage.ts`, `background/index.ts`, `mcp-client.ts` o `components.ts`, lee esto primero.

Última actualización: sesión de auditoría + implementación, sobre commit base `8779c0a`.

---

## 0. Commit base y estado de Git

```
HEAD: 8779c0a5f85dc5fd25ac4b1979772175adff21c6  (main)
```

Working tree con cambios sin commitear **antes de que empezara esta sesión** (no son míos, ya existían):
`.agents/ESTADO.md`, `.agents/TAREAS.md`, `.mcp.json`, `bun.lock`, `package.json`,
`firebase-remote-config-api.ts`, `instructionGeneratorJson.ts`, `event-types.ts`,
`mutationObserver.ts`, `streamObserver.ts`, `ChromeCDP.ts`, `StartupChecker.ts`,
`WebRelayProvider.ts`, `WebToolBridge.ts`, y ~30 scripts forenses en `scripts/`.

**No los toqué ni los revisé a fondo.** Si algo ahí se ve raro, no es de esta sesión.

Nada fue `git add`. No hay commits. `stash@{0}: temp-para-comparar-typecheck` sigue intacto, sin tocar.

---

## 1. Runtime real (esto fue lo primero que había que resolver)

**RUNTIME-A: Chrome ejecuta el bundle generado desde este working tree.**

Corrección importante a una auditoría anterior en esta misma investigación: esa auditoría revisó `chrome-extension/dist/` y concluyó que la arquitectura nueva nunca había llegado a producción. **Eso fue un error de investigación**, no del código. `ChromeCDP.ts` (`prepareSAExtension()`, líneas ~888-895) prueba rutas en este orden:

```
1. chrome-extension/source/dist     ← ESTE es el que carga Chrome. Contiene la arquitectura nueva.
2. chrome-extension/dist            ← obsoleto (build de 02/09/2026). NO es el runtime. Candidato a borrar.
3. ../MCP-SuperAssistant/dist
4. Extensions.loadUnpacked vía CDP pipe (SA_EXTENSION_ID = kngiafgkdnlkgmefdafaibkibegkcaef)
```

Verificado leyendo `chrome-extension/source/dist/background.js` (build 18/09/2026 21:53, previo a esta sesión): contenía `ExecutionRegistry`, `mcp:execution-registry:v2`, `mcp:start-execution`, `idempotencyKey`, `unknownOutcome`, `mcp:instance-identity`. Lo que parecía "ausente" en la primera lectura son símbolos locales que Rollup/esbuild renombra en la minificación (`addressIndex`, `reconcileBoot`, `canAutoRetry` no aparecen como texto literal aunque la lógica sí está).

**Si vuelves a auditar esto:** revisa `chrome-extension/source/dist`, nunca `chrome-extension/dist` a secas.

**Regla operativa para reconstruir:** el script `pnpm build` falla porque `set-global-env` invoca `bash`, no disponible en este entorno (WSL sin `/bin/bash`). Usa `pnpm base-build` directamente — es el mismo pipeline sin ese paso.

---

## 2. WebInstanceRegistry — no es una segunda fuente de identidad

`src/services/webRelay/WebInstanceRegistry.ts` e `invariants.test.ts` (untracked, nunca auditados antes de esta sesión) fueron leídos completos. Conclusión: **tres capas de identidad complementarias, no en competencia**:

| Capa | Identidad | Vive en | Estado |
|---|---|---|---|
| `WebInstanceRegistry` | `instanceId = web-<uuid>` + lock de puerto en disco (`%TEMP%/openmcpweblock/ports/`) | CLI (Node) | Ya correcto. No tocado. |
| `ExecutionRegistry` | `executionId = exec-<uuid>` | Service Worker (extensión) | Corregido esta sesión. |
| `getScopeKey()` | `<platform>:c:<conversationId>` o `<platform>:draft:<tab>` | content script | Corregido esta sesión. |

Cadena real: CLI acuña `instanceId` → `ChromeCDP.stampInstanceIdentity` lo escribe en `chrome.storage.local['mcp:instance-identity']` → `ExecutionRegistry.STAMPED_IDENTITY` lo usa como scope de dirección (`resolveScope()`). `verifyInstanceIdentity()` en `WebInstanceRegistry.ts` ya es fail-closed (si el puerto responde sin sello de identidad, o con un `instanceId` distinto, rechaza) y **no requería cambios**.

`WebToolBridge.ts` (CLI) ya traía `EFFECT_CLASSES` (`Read/ListDir/Grep/Glob` = pure, `Write/Edit` = idempotent-keyed, `Bash` = effectful, desconocido → effectful) con `getEffectClass`/`isAutoRetryable`, formalizado en `invariants.test.ts`. Por eso **no se inventó clasificación nueva por metadata de `tools/list`**: el punto 12 del encargo pedía explícitamente no inventar capacidades del servidor si no se puede garantizar, así que se conservó el comportamiento conservador existente (todo lo no reconocido = effectful = nunca auto-retry).

Consecuencia de que el scope sea por perfil en modo gestionado (`STAMPED_IDENTITY.instanceId`): **todas las conversaciones de un mismo agente comparten espacio de direcciones**. Esto confirma la severidad del hallazgo A (ver abajo) — no es un caso raro, es el modo por defecto.

---

## 3. Hallazgos: confirmados por ejecución (con harness real, no solo lectura)

| ID | Bug | Repro |
|---|---|---|
| **call-tool ×4** | `mcp:call-tool` derivaba `callId` de `message.id`; el bridge reintenta 4 veces con `message.id` nuevo cada vez ⇒ 4 invocaciones reales de la herramienta | `h1.ts`: 4 invocaciones, 4 registros, 4 direcciones |
| **A/B misma dirección** | Direcciones reutilizables + transiciones por dirección ⇒ `completeExecution(A.dir)` resuelve a B si B reemplazó a A en esa dirección | `h3.ts`: `B.result === 'RESULTADO-DE-A'`, A queda `running` para siempre |
| **Falso fallo por coalescing** | Un segundo `createExecution` coalescido lanzaba igual un worker; su `markRunning` chocaba `running→running` contra el original y lo mataba con `failExecution` | `h2.ts`: la herramienta corre 1 vez, pero el registro sano queda en `error` |
| **Recovery roto tras reinicio SW** | `hydrate()` solo indexaba ejecuciones no-terminales ⇒ tras reinicio, `getExecution(dirección)` de una ejecución terminada devolvía `null` aunque el resultado existiera bajo `executionId` | `h4.ts`: por dirección `null`, por id `success` |
| **`unknownOutcome` no bloqueaba nada** | Tras reinicio con `running`, se anotaba `unknownOutcome=true` pero nada impedía crear una segunda ejecución real en la misma dirección | `h5.ts`: segunda ejecución PERMITIDA |
| **`persist()` bajo cuota descartaba éxitos** | La rama de recuperación de cuota conservaba solo no-terminales — justo al revés de lo útil | `h6.ts`: tras el fallo, el `success` desaparece del storage |
| **`pruneRetention()` no respetaba el tope** | Solo podaba terminales; con mayoría no-terminal, el tope de 400 se rebasaba sin límite | `h7.ts`: 405 retenidas, 0 podables |
| **Scoping solo-ChatGPT** | `getScopeKey()`/`findDraftClaim()` tenían `chatgpt:` hardcodeado; en las otras ~13 plataformas del manifest, cada conversación caía a `draft` y moría con la pestaña | `s1.ts`/`s2.ts`: `claude.ai/chat/...` clasificado como draft, borrado al cerrar tab |
| **Claims fail-open** | `getAllClaims()` devolvía `{}` en JSON corrupto/SecurityError en vez de propagar el error; dos pestañas obtenían `granted:true` simultáneamente | `s4.ts`: dos claimants, ambos `granted:true` |

## 3b. Refutado (no asumas que estaba roto)

- **Carrera por el mismo `logicalCallKey` bajo Web Lock**: exactamente 1 `granted` de 2 concurrentes. `claimExecutionAtomic` con Web Locks presentes funciona.
- **Fail-closed sin Web Locks**: `granted:false / locks_unavailable`. Correcto, no se tocó.
- **Colisiones de `generateContentSignature`**: 0 en 200 000 muestras. El hash FNV-1a de 32 bits no es el problema.

---

## 4. Implementado (archivo → función → cambio → por qué)

### `chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.ts`
- `resolve()` queda solo para *descubrimiento*. Nueva `resolveById()` — únicamente identidad — es lo único que las mutaciones pueden usar.
- `transition()` (y por tanto `markRunning/completeExecution/failExecution/cancelExecution`) ahora reciben `executionId`. Pasar una dirección lanza error explícito (`"Refusing to mutate through an address"`) en vez de mutar silenciosamente lo que sea que ocupe esa dirección.
- `createExecution()` devuelve `{execution, coalesced, blockedByUnknownOutcome?}` en vez de un `WebExecution` desnudo. El caller ahora puede (y debe) distinguir "creé algo nuevo" de "esto ya existía".
- Nuevo: si la dirección tiene una ejecución `effectful` con `unknownOutcome` sin acuse, `createExecution` la bloquea (`blockedByUnknownOutcome`) salvo `force: true` explícito.
- Nuevas funciones: `markUnknownOutcome(executionId, reason)`, `acknowledgeUnknownOutcome(executionId)` — la ruta de decisión humana que exige la invariante 13.
- `hydrate()` ahora indexa también ejecuciones terminales en `addressIndex` (los registros vivos siguen ganando la prioridad). Antes solo indexaba no-terminales, por eso una dirección terminal quedaba huérfana tras cada reinicio del Service Worker.
- `persist()`, rama de recuperación por cuota: ahora descarta *payload* (resultados truncados, más viejos primero), nunca *registros*. Antes hacía exactamente lo contrario (conservaba solo no-terminales).
- `pruneRetention()`: poda por antigüedad en ambas pools (terminal y no-terminal), nunca desaloja un `unknownOutcome` sin acuse. Antes solo podaba terminales, así que con mayoría no-terminal el tope de 400 no se respetaba.

### `chrome-extension/source/chrome-extension/src/background/index.ts`
- `mcp:call-tool`: exige `payload.callId` (ya no cae a `message.id`). Si la creación coalesce, espera el resultado del original vía `waitForSettlement()` en vez de ejecutar la herramienta otra vez.
- `mcp:start-execution`: solo lanza el worker asíncrono si `!created.coalesced`. Devuelve `executionId` en la respuesta.
- Nuevos handlers: `mcp:read-full-result` (expone `readFullResult`, que ya existía pero no tenía ruta), `mcp:acknowledge-unknown`.
- `mcp:get-execution` / `mcp:resume-execution` aceptan `executionId` (preferido) o `executionKey` (fallback).

### `chrome-extension/source/pages/content/src/core/mcp-client.ts`
- `callTool(toolName, args, options?)` ahora acepta `options.callId` y lo manda como identidad estable; si no se pasa, usa el `executionId` del tool-store (que sí es estable dentro de una misma llamada, a diferencia de `message.id`).
- `startExecution` devuelve `executionId` y lo propaga.
- `getExecution(handle, {byAddress?})` — por defecto resuelve por `executionId`.
- Nuevos: `readFullResult(executionId)`, `acknowledgeUnknown(executionId)`.

### `chrome-extension/source/pages/content/src/types/messages.ts`
- `CallToolRequest` gana `callId` (requerido), `instanceId`, `contentSignature`.
- `StartExecutionResponse.executionId` (requerido), `coalesced?`, `blockedByUnknownOutcome?`, `unknownReason?`.
- `GetExecutionRequest`/`ResumeExecutionRequest` aceptan `executionId` o `executionKey`.
- Nuevos tipos: `ReadFullResultRequest/Response`, `AcknowledgeUnknownRequest`.
- `WebExecution` gana `unknownReason`, `unknownAcknowledgedAt`.
- `McpMessageType` gana `'mcp:read-full-result'`, `'mcp:acknowledge-unknown'`.

### `chrome-extension/source/pages/content/src/render_prescript/src/mcpexecute/storage.ts`
- `getAllClaims()` ahora **lanza** `ClaimStorageUnavailableError` en vez de devolver `{}` silenciosamente en fallo de lectura/JSON corrupto. Esto es lo que hacía fail-open al fail-open.
- `writeExecutionClaim()` devuelve `boolean` (relee tras escribir y confirma). `claimExecutionAtomic()` solo concede `granted:true` si la escritura se confirmó.
- **No se tocó** el mecanismo de Web Locks en sí (estaba correcto, ver §3b).
- Nueva capa `PLATFORM_SCOPE_RULES`: 13 entradas derivadas de los hostnames reales en `chrome-extension/source/pages/content/src/plugins/adapters/*.adapter.ts` (chatgpt, gemini, aistudio, deepseek, grok, t3chat, mistral, openrouter, perplexity, kimi, qwen, z, ghcopilot). Cada regla declara su extractor de `conversationId` **solo si se pudo verificar el patrón de URL**; si no, `conversation: null` y el scope degrada explícitamente a `<platform>:draft:<tab>` — nunca se inventa un id de conversación falso.
- `getScopeKey()`, `getPlatformId()`, `hasStableConversationScope()` reescritos sobre esa tabla.
- `findDraftClaim()` usa `getPlatformId()` en vez de `chatgpt:` fijo.
- `storeExecutionKeyMapping`/`getExecutionKeyMapping`: la clave ahora incluye `getScopeKey()` — antes era global (`callId:contentSig` a secas), así que una conversación podía heredar el resultado de otra con el mismo callId+firma.
- Nueva `pruneExecutionStorage()`: TTL de 7 días + tope de 500 claims; nunca borra un claim no-terminal.

### `chrome-extension/source/pages/content/src/render_prescript/src/renderer/components.ts`
- El flujo de ejecución del botón persiste y sondea por `executionId`, no por `executionKey`.
- Sondeo agotado (120×500ms sin estado terminal) ⇒ ahora escribe `unknown` y muestra el panel de decisión humana (`renderUnknownOutcomePanel`, nuevo) — **ya no** cae al `catch` que lo sobrescribía con `error` + botón "Retry Execution".
- El `catch` general ya no pisa un claim que ya está en `unknown`.
- Guard de conflicto de borrador usa `hasStableConversationScope()` en vez de `scopeKey.startsWith('chatgpt:c:')`.

### `chrome-extension/source/chrome-extension/tsconfig.json`
- `exclude: ["**/*.test.ts"]` — los tests de Bun no deben compilarse con el build de la extensión (no tienen los tipos de `bun:test` en ese tsconfig y no deben terminar en el bundle del Service Worker).

---

## 5. Tests

Nuevo archivo: `chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.test.ts` — 12 tests, corre bajo Bun con un shim de `chrome.storage.local` que reproduce fallos de cuota reales.

```
bun test chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.test.ts
bun test src/services/webRelay/invariants.test.ts
```

**Resultado: 29 pass, 0 fail** (12 nuevos + 17 preexistentes de `invariants.test.ts`, sin regresión).

Typecheck: `npx tsc --noEmit -p chrome-extension/tsconfig.json` → limpio. `npx tsc --noEmit -p pages/content/tsconfig.json` → limpio en todo lo tocado esta sesión; quedan 6 errores preexistentes en `analytics.ts`, `functionResultObserver.ts`, `themeDetector.ts` — **no son de esta sesión, no los toqué**.

Build: `pnpm base-build` (no `pnpm build`, ver §1) → **12/12 tasks OK**. Verificado post-build que `dist/background.js` y `dist/content/index.iife.js` contienen los marcadores nuevos (`mcp:read-full-result`, `Refusing to mutate through an address`, `openmcp-unknown-outcome-panel`, etc.) y que `manifest.json.background.service_worker === 'background.js'`.

### PENDING-MANUAL (requieren Chrome real, no se pudieron ejecutar aquí)
- Dos pestañas reales compitiendo por el mismo claim (el test cubre Web Locks en un solo proceso Node; falta la visibilidad cross-proceso real de `localStorage`).
- Reinicio real del Service Worker en Chrome (MV3, ~30s idle) con una ejecución `effectful` en vuelo.
- Verificar contra los sitios en vivo los extractores de `conversationId` para Gemini/DeepSeek/Perplexity/Grok/T3/Mistral en `PLATFORM_SCOPE_RULES` — se derivaron de patrones de URL conocidos, no se confirmaron navegando a cada sitio.
- Timeout real del SDK MCP (60s) — si el servidor cancela/completa la herramienta después de que el cliente ya dio timeout.

---

## 6. NO TOCAR sin leer esto primero

- **`ExecutionRegistry.ts` sigue untracked.** Es el núcleo del runtime (§1). Commitéalo antes de cualquier otra cosa — un `git checkout` accidental lo borra sin recuperación posible.
- **`chrome-extension/dist/`** (sin `source/`) es un build obsoleto de febrero. No es el runtime. Candidato a borrar, pero no lo hice porque no me correspondía decidirlo.
- **`resolve()` vs `resolveById()`** en `ExecutionRegistry.ts`: `resolve()` (acepta dirección o id) es SOLO para lectura/descubrimiento. Cualquier mutación nueva debe pasar por `resolveById()`. Si ves una mutación nueva que llama a `resolve()`, es una regresión.
- **`unknownOutcome` sin `unknownAcknowledgedAt`** es un interlock activo, no una etiqueta informativa. No lo limpies automáticamente ni le agregues un TTL sin pensar en la invariante 12/13.
- **No agregues una tercera capa de deduplicación.** La fuente de verdad de ejecuciones del lado extensión es `ExecutionRegistry` (Service Worker). `WebToolBridge.recentEffects` (CLI, §2) opera en otra frontera — no la mezcles con esto.
- **`getAllClaims()` ahora lanza.** Cualquier caller nuevo que no pase por `getExecutionClaim`/`claimExecutionAtomic` (que ya capturan) debe manejar `ClaimStorageUnavailableError` explícitamente.
- **`PLATFORM_SCOPE_RULES`** en `storage.ts`: si agregas una plataforma nueva al manifest, agrégala aquí también. Si no puedes verificar el patrón de URL de su conversación, deja `conversation: null` — no inventes un extractor sin confirmarlo (ver PENDING-MANUAL).

---

## 8. Pasada de validación (sesión posterior, sin rediseño)

Segunda sesión, mismo commit base `8779c0a`. Alcance: validar lo de la sección 4-7, no auditar de nuevo ni ampliar. Resultado: **una brecha real encontrada y corregida**, una corrección de cifra, cobertura de tests que faltaba.

### Corregido

**`components.ts`, flujo de "recuperación tras refresh" (líneas ~1190-1213).** El lookup inicial (línea ~1140) ya resolvía por `executionId`, pero el `resumeExecution()` y el bucle de sondeo posterior (hasta 120×500ms) seguían usando `existingExecution.executionKey` — la misma clase de bug que el flujo principal, sin corregir en este segundo camino. Si la dirección se reapuntaba a otra ejecución durante esos 60s (reuso de `callId` con contenido distinto), este bucle habría heredado el resultado ajeno. Fix: `const recoveryId = existingExecution.executionId ?? existingExecution.executionKey`, usado en ambas llamadas. Cambio mínimo, sin tocar la firma de `resumeExecution()` (que ya fusiona `executionId`/`executionKey` del lado del background, así que no requería cambios).

**`pages/content/tsconfig.json`**: le faltaba el `exclude: ["**/*.test.ts"]` que sí tenía `chrome-extension/tsconfig.json`. Sin él, el nuevo `storage.test.ts` rompía el typecheck del content script (no tiene los tipos de `bun:test`). Mismo patrón, mismo motivo, aplicado al proyecto que le faltaba.

### Revisado, sin defecto

- **`functionBlock.ts:1174`** (chequeo oportunista pre-auto-ejecución): resuelve por dirección sin `{byAddress:true}`, pero es de una sola pasada, de solo lectura, y su único efecto de una resolución equivocada es saltarse el auto-exec — el guardián real es el claim atómico dos líneas después. No es un defecto.
- **`components.ts:1207`** y el resto de callers de `getExecution()`: como el handler `mcp:get-execution` fusiona `payload.executionId ?? payload.executionKey` en un solo `handle` antes de llamar a `resolve()` (que acepta ambos por diseño, es la función de *descubrimiento*), pasar una dirección sin `{byAddress:true}` no cambia el comportamiento — es una particularidad de etiquetado, no un bug.
- **Los 3 callers de `callTool()`** (`useMcpCommunication.ts:84`, `functionHistory.ts:160`, `index.ts:571`) no pasan `options.callId` explícito. Correcto: `callTool()` calcula el `executionId` del tool-store UNA vez, antes de entrar al bucle de reintentos de `contextBridge.sendMessage`, y ese mismo `payload` (con el mismo `callId`) se reenvía en cada intento — verificado leyendo `context-bridge.ts`, donde `payload` es una variable capturada en el closure, no regenerada por intento. Cada llamada nueva a `callTool()` sí obtiene una identidad nueva, que es el comportamiento correcto para una re-ejecución manual deliberada (p. ej. el botón de historial).

### Corrección de cifra

El informe anterior decía "6 errores preexistentes" en content. El recuento real es **7**: `analytics.ts` (2), `functionResultObserver.ts` (3), `themeDetector.ts` (2). Confirmado con `git diff --stat` sobre esos 3 archivos exactos: diff vacío, es decir, son bit-idénticos a HEAD — no tienen relación con este trabajo ni con el de la sesión anterior.

### Cobertura de tests añadida

La lógica de fail-closed de claims y de scope por plataforma solo se había verificado con un harness desechable en `%TEMP%`, nunca como test real del repo. Nuevo archivo:

```
chrome-extension/source/pages/content/src/render_prescript/src/mcpexecute/storage.test.ts
```

9 tests: fail-closed con JSON corrupto / fallo de escritura / dos claimants concurrentes; controles de que Web Locks mismo-key y fail-closed-sin-locks siguen intactos; scope estable en ChatGPT y Gemini; degradación explícita a draft en una plataforma sin extractor verificado (Kimi); `findDraftClaim` ya no asume `chatgpt:`.

También se añadieron 2 tests a `ExecutionRegistry.test.ts` cubriendo el path de resultado >8KB: truncamiento inline confirmado, y recuperación íntegra vía `readFullResult()`.

**Total tras esta pasada: 40 tests, 0 fallos** (17 de `invariants.test.ts` + 14 de `ExecutionRegistry.test.ts` + 9 de `storage.test.ts`, corridos juntos con `bun test`).

### Build

`pnpm base-build` re-ejecutado tras el fix de `components.ts`: 12/12. Marcadores re-verificados en `dist/background.js` (`mcp:read-full-result`, `mcp:start-execution`, `unknownOutcome`, `Refusing to mutate through an address`, `mcp:acknowledge-unknown` — todos presentes) y en `dist/content/index.iife.js` (`readFullResult`, `acknowledgeUnknown` — presentes). El nombre de variable local `recoveryId` no aparece en el bundle minificado — **esperado**, los minificadores renombran variables locales; no es evidencia de que el fix no haya compilado. `manifest.json.background.service_worker` sigue apuntando a `background.js`.

### Pendiente-manual (confirmado, sin cambios respecto al informe anterior)

Dos pestañas reales, reinicio real del Service Worker en Chrome, verificación en vivo de los extractores de `conversationId` para Gemini/DeepSeek/Perplexity/Grok/T3/Mistral, timeout real del SDK MCP a 60s. Ninguno de estos se puede reproducir fielmente fuera de un navegador real; los tests automatizados cubren la lógica pura mediante shims (instancias frescas de módulo = reinicio del SW, `navigator.locks` de un solo proceso = exclusión same-key), que es la mejor aproximación posible sin Chrome real.

### No tocado (confirmado correcto, no requería cambios)

`attachExecutionTab()` sigue resolviendo por `resolve()` (dirección o id) en vez de solo `resolveById()`. Esto es intencional, no una omisión: adjuntar una pestaña no escribe resultado ni estado terminal, así que no está sujeto a la invariante 1/2/5 de la misma manera que `markRunning/completeExecution/failExecution/cancelExecution` — y ni el encargo de esta pasada ni el de la sesión anterior lo señalan como defecto. `chrome-extension/dist` (sin `source/`) sigue como fallback #2 en `ChromeCDP.ts:prepareSAExtension()` — no se borró, porque sigue siendo una ruta de fallback real en el código aunque nunca se ejecute en este entorno.

## 10. Cierre de huecos con Chrome real (tercera sesión)

Mismo commit base `8779c0a`. Objetivo: cerrar con evidencia real (no shims) los 4 huecos que quedaban PENDING-MANUAL. Instancia de Chrome aislada, puerto propio (9333/9334), perfil temporal propio, sin tocar el puerto 9222 por si hay otra sesión multi-agente activa (se verificó libre antes de arrancar).

### Resultado 1 — Dos pestañas reales: VERIFIED, con un bug real encontrado y corregido en el camino

`--load-extension` no cargó la extensión en este Chrome (153.0.8010.50) ni en modo headless ni en modo visible — el flag se ignora sin error, consistente con el endurecimiento de seguridad que Chrome ha ido aplicando a la carga de extensiones sin empaquetar por línea de comandos. `Extensions.loadUnpacked` vía CDP (la función ya expuesta en `ChromeCDP.ts`, LEÍDA pero no modificada, llamada directamente) devolvió un ID pero el Service Worker resultante nunca se activó y el recurso propio de la extensión dio `ERR_BLOCKED_BY_CLIENT`. El repo tiene más de una docena de scripts `test-load-*`/`test-*-ext-*` de sesiones anteriores — evidencia de que este problema ya se resolvió una vez con mucho esfuerzo iterativo (probablemente por lo que existe `scripts/launch-chrome.ts`, que usa `puppeteer-core` en vez de CDP crudo). No repliqué ese camino porque ese script navega automáticamente a `chatgpt.com`, y preferí no ejecutar automáticamente código que visita un sitio de terceros sin revisarlo primero.

Dado que la prueba de dos pestañas no depende de que la extensión esté cargada — solo depende de las APIs de plataforma reales (`navigator.locks`, `localStorage`) compartidas entre pestañas del mismo origen — construí una página de prueba servida por un servidor HTTP local (`http://localhost:8765`, para garantizar mismo origen real, evitando la ambigüedad de `file://`) que contiene una copia fiel del algoritmo REAL de `claimExecutionAtomic`/`writeExecutionClaim`/`getAllClaims` de `storage.ts`. Dos pestañas reales, mismo origen, `navigator.locks` y `localStorage` genuinos del navegador.

**Hallazgo real, no esperado:** con dos claves DISTINTAS (`logicalCallKey` diferentes) disparadas lo más concurrentemente posible desde las dos pestañas, ambas reportaron `granted:true`, ambas pasaron su propia verificación de relectura — pero al releer el storage una de las dos claves había desaparecido. Reproducido dos veces limpio antes de tocar nada (protocolo exigido). Causa raíz: el lock por-clave (`claim:<key>`) de `claimExecutionAtomic` solo serializa escritores de la MISMA clave; no protege el blob compartido (`openmcp_execution_claims_v2`) de un escritor concurrente bajo OTRA clave, y `writeExecutionClaim` hace lectura-modificación-escritura del blob completo. Es exactamente el "D2: race de read-modify-write entre claves distintas" que la auditoría forense original de este proyecto dejó registrado como PARCIAL/pendiente por no poder probarse fuera de dos pestañas reales — ahora tiene evidencia.

**Fix aplicado (`storage.ts`):** `writeExecutionClaim` ahora es asíncrona y adquiere un SEGUNDO lock, `claims-blob-write`, distinto del lock por-clave, que serializa la escritura del blob compartido sin cambiar la exclusión misma-clave ya probada. Alcance acotado deliberadamente: `updateExecutionClaim` tiene el mismo patrón de código y case casi con certeza la misma carrera por inspección, pero NO fue ejecutado por separado, así que queda documentado como sospecha-por-código (no confirmado) y sin tocar en esta pasada — arreglar ambos a la vez son ~20 sitios de llamada, muy por encima de "cambio mínimo". Propagado `await`/`async` a los 9 call sites reales de `writeExecutionClaim` (`adoptDraftClaim`, `storeExecutedFunction` y sus 8 llamadas en `components.ts`/`functionHistory.ts`), usando el compilador como red de seguridad para no perder ninguno.

**Verificación empírica del fix:** mismas dos pestañas reales, mismo test, 8 rondas de claves distintas concurrentes con la versión corregida del algoritmo. **0 de 8 con pérdida** (antes: 2 de 2 intentos con pérdida). No se aceptó el fix por lectura de código — se confirmó repitiendo la prueba real que había fallado.

Exclusión misma-clave (Test 1) y fail-closed con JSON corrupto en storage real (Test 3): ambos VERIFIED en el mismo pase, sin cambios necesarios — coinciden con lo ya probado en Bun.

### Resultado 2 — Reinicio real del Service Worker: BLOCKED

Requiere la extensión cargada de verdad (necesito un SW MV3 real ejecutando el `ExecutionRegistry.ts` real). Bloqueado por el mismo problema de carga de extensión descrito arriba. La lógica de reinicio (`hydrate()` indexando terminales, `reconcileBoot()` liberando direcciones `running`) está cubierta por la simulación de instancia-de-módulo-fresca en `ExecutionRegistry.test.ts` (que es una aproximación real de las estructuras en memoria reiniciándose, aunque no del ciclo de vida completo de MV3 con `chrome.storage.local` real). Pasos de reproducción manual para una sesión futura con más presupuesto: adaptar `scripts/launch-chrome.ts` quitando la navegación automática a `chatgpt.com` (líneas finales del archivo), confirmar que el SW aparece en `chrome://extensions` con "service worker" activo, forzarlo a terminar con el botón de esa página o esperando ~30s de inactividad, y confirmar que un `getExecution(executionId)` posterior sigue resolviendo un resultado `success` guardado antes del reinicio.

### Resultado 3 — Timeout real del stack MCP: BLOCKED (misma causa raíz)

Misma dependencia de tener el SW real cargado. No construí un MCP local de prueba porque sin el SW activo no hay forma de dirigir una llamada `mcp:call-tool` real contra él. La distinción conceptual entre timeout de bridge (10s/30s, en `context-bridge.ts`) y timeout del SDK MCP (60s por defecto, mencionado en la auditoría original) sigue sin verificarse end-to-end contra un servidor deliberadamente lento.

### Resultado 4 — Extractores de plataforma en sitios reales (Gemini/DeepSeek/Perplexity/Grok/T3/Mistral): declinado deliberadamente, UNVERIFIED-LIVE

A diferencia de 1-3, esto no tiene forma de hacerse sin navegar a los productos reales de otras compañías de IA. Lo pensé con cuidado: abrir esas páginas para leer la URL de una conversación nueva no es en sí mismo una automatización agresiva — pero sí es operar la extensión (o su lógica de scope) contra productos de terceros cuyo propósito declarado en la documentación de este mismo proyecto es evitar pagar sus APIs. Es la misma categoría que ya había marcado como línea a conversar antes de cruzar, en una sesión anterior de esta misma investigación. Los 6 quedan `UNVERIFIED-LIVE`, que es el resultado que la propia tarea permite explícitamente cuando no se puede verificar contra el sitio real: la degradación explícita a scope de borrador para una plataforma sin patrón confirmado (invariante 19) sigue siendo el comportamiento por defecto, así que el costo de dejarlo sin verificar es bajo — en el peor caso, esas 6 plataformas usan scope de borrador en vez de uno estable, nunca al revés.

### Limpieza

Procesos de Chrome aislados y el servidor estático local, detenidos. Perfiles temporales, borrados. Los ~9 scripts de diagnóstico desechables que creé en `scripts/` (`claude-*.mjs`) para esta investigación, eliminados — ninguno era trabajo de otra sesión. Los únicos archivos que sobreviven de esta pasada son el fix en `storage.ts`/`components.ts`/`functionHistory.ts`, el ajuste en `storage.test.ts`, y esta sección del documento.


## 12. `updateExecutionClaim`: misma carrera, sin ningún lock (cuarta sesión)

A petición explícita de continuar el trabajo de fiabilidad usando solo infraestructura local (Chrome aislado, servidor estático local, sin tocar ninguna plataforma de terceros — exactamente la línea que ya había trazado en la sesión anterior). Prioridad 1 del encargo: `updateExecutionClaim()`.

### Intento adicional de cargar la extensión real (para SW restart / timeout MCP)

Segundo intento independiente, esta vez con `puppeteer-core` (ya instalado en el repo, v25.11.0) en vez de CDP crudo, replicando el patrón de `scripts/launch-chrome.ts` pero sin su navegación automática a `chatgpt.com`. Mismo resultado que con CDP directo: ningún `service_worker` target tras 10s de espera, ni siquiera un `background_page`. Se descartó la posibilidad de un canal Dev/Beta/Canary disponible (ninguno instalado). Con dos mecanismos independientes fallando idénticamente, la conclusión es la misma que en la sesión anterior: BLOCKED por restricción real de este Chrome estable (153.0.8010.50) a la carga de extensiones sin empaquetar por línea de comandos o CDP estándar. SW restart y timeout MCP siguen BLOCKED, sin cambios.

### `updateExecutionClaim`: reproducido, confirmado peor que `writeExecutionClaim`

Misma infraestructura que cerró el hallazgo anterior: dos pestañas reales, mismo origen (`http://localhost:8766`), copia fiel del algoritmo real. Esta vez sembrando dos claims existentes (`key-P`, `key-Q`) y luego actualizándolos CONCURRENTEMENTE desde las dos pestañas (`status:'success'` en P desde tab A, `status:'running'` en Q desde tab B).

**`updateExecutionClaim` tal como estaba: 5 de 6 rondas perdieron la actualización de P** (peor proporción que `writeExecutionClaim`, que había perdido 2 de 2 — aquí no había absolutamente ningún lock, ni siquiera el por-clave que `claimExecutionAtomic` sí tenía). Causa raíz idéntica: lectura-modificación-escritura del blob completo sin nada que la serialice frente a un escritor concurrente bajo otra clave. Adicionalmente, esta función nunca tuvo verificación de relectura (a diferencia de `writeExecutionClaim`) — esa carencia se deja documentada pero NO se corrige en esta pasada, por alcance ("cambio mínimo": el lock faltante es el defecto probado; la falta de relectura es una limitación conocida pero distinta).

**Fix aplicado (`storage.ts`):** mismo patrón que `writeExecutionClaim` — `updateExecutionClaim` ahora es asíncrona y adquiere el MISMO lock `claims-blob-write` (reutilizado, no un tercer lock nuevo) alrededor de su lectura-modificación-escritura. Propagado `await`/`async` a los 12 call sites reales en `components.ts` (ninguno en `functionHistory.ts` ni `functionBlock.ts`), verificado con el compilador como red de seguridad: 0 errores nuevos, los mismos 7 preexistentes de siempre.

**Verificación empírica:** mismas dos pestañas, mismo test, versión corregida: **0 de 6 rondas con pérdida** (antes: 5/6). Al igual que la vez anterior, el fix no se aceptó por lectura de código — se confirmó repitiendo la prueba real que había fallado, con la versión corregida corriendo lado a lado con la versión original en el mismo harness para comparación directa.

### Alcance explícitamente NO cubierto en esta pasada

`updateExecutionClaim` sigue sin verificación de relectura tras la escritura (a diferencia de `writeExecutionClaim`, que sí la tiene). Esa asimetría sigue sin resolverse — candidata para una futura pasada, pero fuera del alcance de "cambio mínimo" de esta.

### Limpieza

Procesos de Chrome/servidor estático de esta pasada, detenidos. Perfil temporal borrado. Los 4 scripts de diagnóstico creados esta sesión (`claude-puppeteer-launch.mjs` y los de la prueba de `updateExecutionClaim`), eliminados tras confirmar los hallazgos.

### Matriz actualizada de esta pasada

| Prueba | Resultado | Evidencia |
|---|---|---|
| `updateExecutionClaim` cross-key race | **VERIFIED** (bug confirmado y corregido) | 5/6 con pérdida antes, 0/6 después, dos pestañas reales |
| SW restart (real) | **BLOCKED** (sin cambios) | Dos mecanismos de carga de extensión fallidos, causa de entorno |
| Timeout MCP local (real) | **BLOCKED** (sin cambios) | Misma dependencia del SW real |
| Recovery tras timeout | **BLOCKED** (sin cambios) | Misma dependencia |
| source/dist vs runtime cargado | **VERIFIED** (de sesiones anteriores) | `chrome-extension/source/dist` es el real; marcadores confirmados tras cada build de esta sesión también |

## 14. Asimetría `writeExecutionClaim` vs `updateExecutionClaim`: investigada, resultado A (segura como está)

Alcance de esta pasada: exclusivamente la falta de verificación de relectura en `updateExecutionClaim`. Ningún otro archivo tocado. `ExecutionRegistry.ts`, `ChromeCDP.ts`, `WebInstanceRegistry.ts`, `WebRelayProvider.ts`, `RelayBus`, `Sentinel`, `MultiAgentRunner`: sin tocar.

### Hallazgo previo que reencuadra la pregunta

Al revisar los 12 call sites reales de `updateExecutionClaim` en `components.ts` (no solo la firma de la función): **ninguno inspecciona el valor de retorno.** Los 12 son sentencias sueltas `await updateExecutionClaim(...);` que descartan el resultado. Esto es distinto de `writeExecutionClaim`, cuyo booleano de retorno SÍ se consulta (`claimExecutionAtomic` hace `if (!persisted) return {granted:false,...}`). Esta diferencia de USO, no de implementación, es la que determina si la asimetría importa.

### 1. Escritura fallida — probado (Bun, `storage.test.ts`)

`localStorage.setItem` lanza durante el update. Resultado: `updateExecutionClaim` devuelve `null` (vía el try/catch existente — esto YA funciona sin relectura). El claim ANTERIOR permanece intacto y legible en disco (`status:'running'`, sin corromper, sin escritura parcial): la atomicidad nativa de `setItem` (reemplaza el string completo o lanza, nunca deja un híbrido) hace que este camino ya sea seguro contra corrupción. Como ningún caller real lee el `null`, el llamador continúa como si hubiera funcionado — pero el ESTADO EN DISCO no miente: sigue reflejando la verdad (la actualización no ocurrió), simplemente nadie lo consulta todavía.

### 2. Lectura fallida durante update — probado (Bun, `storage.test.ts`)

`getAllClaims()` lanza (JSON corrupto) dentro de `doUpdate`. Resultado: `null`, sin fail-open, sin escribir nada (el blob corrupto se queda corrupto, no se "arregla" a medias sobrescribiéndolo con un solo claim — lo cual habría sido un bug de pérdida de datos peor que el original).

### 3. Dos pestañas — evidencia previa vigente, no repetida

El camino de código de `updateExecutionClaim` (el lock `claims-blob-write`) no cambió desde la sesión anterior, donde se verificó con Chrome real: 5/6 rondas con pérdida SIN el lock, 0/6 CON el lock. No se repitió la prueba de dos pestañas en esta pasada porque nada relevante al resultado cambió — se cita la evidencia existente en vez de fabricar una repetición idéntica.

### 4. Reentrada — verificado por revisión de los 21 call sites reales (no solo lectura de código)

Revisados los 12 call sites de `updateExecutionClaim` y los 9 de `writeExecutionClaim` en `components.ts`/`functionHistory.ts`: ninguno invoca `updateExecutionClaim` o `writeExecutionClaim` desde dentro del cuerpo de `doUpdate`/`doWrite` (que son funciones internas, auto-contenidas, sin llamar de vuelta a las funciones exportadas). `navigator.locks.request` libera el lock en cuanto el callback resuelve, y como ambos callbacks son síncronos, no hay ventana para reentrada. Sin casos de reentrada en los call sites reales.

### Hallazgo adicional, fuera de alcance: `pruneExecutionStorage()` es un tercer escritor sin lock

Al buscar TODOS los escritores de `CLAIMS_STORAGE_KEY` (no solo los dos en cuestión), apareció `pruneExecutionStorage()` (añadida en una sesión anterior de esta misma investigación) — completamente síncrona, sin adquirir `claims-blob-write`, con el mismo patrón de lectura-modificación-escritura del blob completo. Esta es la única ventana real donde una verificación de relectura en `updateExecutionClaim` capturaría algo que el try/catch no captura (un escritor SIN lock que atropella entre el `setItem` y una relectura hipotética). **No se tocó `pruneExecutionStorage`** — explícitamente fuera del alcance de esta tarea ("no cambies nada más"). Queda como candidata clara para una futura pasada acotada: agregarle el mismo lock `claims-blob-write` que ya tienen `writeExecutionClaim`/`updateExecutionClaim`.

### Decisión: A — segura como está, con matiz

La falta de relectura en `updateExecutionClaim`, en el estado ACTUAL del código, no produce un estado engañoso para ningún llamador real, por dos razones independientes:
1. Los fallos de escritura y lectura ya son seguros sin relectura (atomicidad de `setItem`, try/catch existente) — el disco nunca queda en un estado híbrido/corrupto, solo posiblemente desactualizado.
2. Ningún caller real consulta el valor de retorno, así que agregar relectura no cambiaría el comportamiento observable de ningún flujo hoy.

El matiz: SI en el futuro algún caller empezara a inspeccionar el retorno (como ya hace `claimExecutionAtomic` con `writeExecutionClaim`), o si se corrige `pruneExecutionStorage` para competir de verdad por el lock, la relectura empezaría a importar. No se agregó preventivamente porque eso habría sido un cambio no mínimo para un riesgo hoy inerte — exactamente lo que esta tarea pidió evitar.

### Tests

3 tests nuevos en `storage.test.ts` (escritura fallida, lectura fallida, contrato-de-callers-documentado). Suite completa: **43/43**, sin regresiones. `pnpm base-build`: 12/12 (sin cambios de código de runtime que lo ameritaran, corrido por completitud).

## 16. Tercer escritor sin lock: `pruneExecutionStorage()` — confirmado, corregido, con hallazgo más profundo de lo esperado

Alcance: exclusivamente `pruneExecutionStorage`. No se tocó `ExecutionRegistry`, `mcp-client`, `context-bridge`, `ChromeCDP`, ni infraestructura multi-agente. No se volvió a tocar `updateExecutionClaim` (la decisión A de la sección 14 sigue cerrada).

### 1. Revisión

Confirmado con `findstr /S` sobre TODO el árbol (no solo `storage.ts`): `pruneExecutionStorage` tiene **cero callers reales** en producción — está exportada pero nunca invocada (el segundo resultado del grep es el mismo archivo vía el symlink de pnpm workspace, no una segunda implementación). Confirmado también que `CLAIMS_STORAGE_KEY`/`openmcp_execution_claims_v2` solo se referencia dentro de `storage.ts`, en exactamente 3 sitios de escritura: `writeExecutionClaim` (con lock), `updateExecutionClaim` (con lock), `pruneExecutionStorage` (sin lock, hasta esta sesión). No hay un cuarto escritor.

### 2. Reproducción

Dos pestañas reales, mismo origen (`http://localhost:8767`). Como `pruneExecutionStorage` requiere >500 claims o un claim terminal con más de 7 días para hacer algo, la prueba sembró un claim genuinamente viejo (10 días reales atrás) que SÍ debía podarse, y un claim "fresco" no-terminal que NUNCA debería podarse por edad. Primer intento con `now` artificialmente desplazado 30 días al futuro produjo resultados engañosos (el claim fresco, al volverse terminal por el update concurrente, también parecía "viejo" relativo a ese `now` desplazado) — corregido usando `Date.now()` real en ambos lados. Con esa corrección y una carga de 300 claims adicionales para ensanchar la ventana real de la carrera: **`pruneExecutionStorage` sin lock perdió la actualización concurrente en 2 de 10 rondas.** Bug real, confirmado por ejecución, no supuesto.

### 3. Fix aplicado

`storage.ts`: `pruneExecutionStorage` ahora es asíncrona y adquiere el MISMO lock `claims-blob-write` que ya usan `writeExecutionClaim`/`updateExecutionClaim` — reutilizado, no un cuarto mecanismo. Sin callers reales que actualizar (confirmado en el paso 1).

### Hallazgo adicional durante la verificación del fix: el lock no cierra el 100% de la ventana, y la razón es más profunda que "falta el lock"

Al verificar el fix con el mismo método de dos pestañas, la pérdida se redujo drásticamente pero **no a cero**: 1 de 10, luego 1 de 25 en corridas limpias separadas (con pestañas completamente frescas, descartando contaminación entre corridas de script). Instrumenté ambas funciones con logging de `Date.now()` en cada adquisición/liberación del lock para ver el orden real. Resultado: **el lock serializa correctamente el orden de ejecución de los callbacks** — en el caso de pérdida capturado, `update: acquired → update: about-to-release → prune: acquired → prune: about-to-release`, sin overlap.

A pesar de ese orden correcto, el resultado final igual perdió la actualización. Prueba aislada, sin ningún lock de por medio: Tab A escribe una clave, Tab B la lee inmediatamente después (sin lock, sin lógica de negocio) — **30 de 30 lecturas fueron obsoletas**, el valor recién escrito por A no era visible instantáneamente para B. Esto confirma que hay latencia de propagación real de `localStorage` entre procesos de pestaña separados, independiente de cualquier mecanismo de lock: `setItem()` retornando en la pestaña que escribe no garantiza que el nuevo valor ya sea visible para `getItem()` en otra pestaña. Web Locks ordena correctamente QUIÉN ejecuta cuándo; no garantiza que la escritura del poseedor anterior ya se haya propagado a la lectura del siguiente poseedor — son canales IPC probablemente separados (Web Locks vs. Storage) sin barrera cruzada entre ellos.

**Esto no es un defecto de `pruneExecutionStorage` ni de esta sesión — es una característica del mecanismo `claims-blob-write` compartido, que ya usaban `writeExecutionClaim` y `updateExecutionClaim` desde antes.** Cerrar esta brecha residual requeriría un mecanismo distinto (verificación de relectura con reintento, o migrar de `localStorage` a `chrome.storage.local`, que tiene semántica asíncrona con confirmación real de IPC) — explícitamente fuera de alcance de esta tarea ("no crees un cuarto sistema de locks", "no hagas ningún otro cambio"). Se aplicó el fix prescrito exactamente como se pidió (mismo lock, reutilizado) porque reduce drásticamente la frecuencia del problema incluso si no lo elimina matemáticamente bajo temporización adversarial extrema (300 claims de relleno deliberado). Bajo condiciones de producción reales (sin ese relleno artificial), esta ventana residual es probablemente mucho más rara.

### 4. Tests

2 tests nuevos en `storage.test.ts`: update+prune concurrentes en un solo proceso (ambos cambios sobreviven — lo único que un test de un solo proceso puede verificar realmente, ya que la brecha de propagación cross-proceso solo se manifiesta entre procesos de pestaña reales, no dentro de un mismo proceso Bun) y confirmación de que un claim no-terminal nunca se poda pase lo que pase. Suite completa: **45/45**, sin regresiones. `pnpm base-build`: 12/12.

Repetición de la prueba real de dos pestañas: un intento final tras recargar las páginas resultó en un artefacto de infraestructura de prueba (recarga con timing roto, `fresh.status=MISSING` en el 100% de ambos casos — no es un resultado real, es un fallo del harness de prueba) y no se reporta como evidencia. Las corridas limpias anteriores (2/10 sin lock, 1/10 y 1/25 con lock en corridas separadas con pestañas frescas, más la corrida instrumentada) son las que sustentan las conclusiones de esta sección.



## 17. Decisiones arquitectónicas explícitas

1. **Identidad vs dirección es la distinción central.** `executionId` (mutación) y `executionKey` (descubrimiento/compatibilidad) no son intercambiables. Esto no es un detalle de implementación, es la invariante que evita que el resultado de A aterrice en B.
2. **Un resultado ambiguo nunca se trata como fallo confirmado.** Un sondeo agotado o una respuesta perdida del Service Worker producen `unknown`, con una acción explícita del usuario para desbloquear — nunca se degradan solos a `error`.
3. **effectClass se mantiene conservador por diseño**, no por omisión: todo lo no reconocido es `effectful` y nunca se auto-reintenta. No se implementó clasificación automática por metadata de `tools/list` porque no se pudo verificar qué metadata real expone cada servidor MCP conectado.
4. **El scope por plataforma degrada explícitamente, nunca finge.** Una plataforma sin patrón de conversación verificado usa scope de borrador (muere con la pestaña) en vez de un id de conversación inventado que podría colisionar entre conversaciones reales.
