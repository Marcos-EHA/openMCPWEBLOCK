# Auditoría Final, Hardening y Estado de Evidencia (2026-09-24)

> Documento de cierre de la Fase 6 del stack de Orquestación Multi-Agente Web Relay en openMCPWEBLOCK.
> Clasificación estricta de hallazgos en: **CONFIRMADO**, **LIMITACIÓN CONOCIDA** y **NO DEMOSTRADO**.

---

## 1. Cadena Arquitectónica Validada

```text
ChromeCDP (WebSockets / CDP / Netstat)
      ↓
WebInstanceRegistry (Locks de puertos en disco, UUIDs de instancia, leases)
      ↓
MultiAgentRunner (Ciclo de vida de 7 fases, per-agent mutex, gates de bloqueo)
      ↓
Sentinel (Monitor de salud pasivo, detección de debugPort)
      ↓
RelayBus (Broker desacoplado: Commands, Events, Queries)
      ↓
orchestration/AppState (Proyección reactiva pura con reducer applyEvent)
      ↓
useOrchestratorState (Hook React con useSyncExternalStore)
      ↓
TUI (/status en Status.tsx y /mcp status en mcp.tsx)
```

---

## 2. Hallazgos de la Auditoría

### 2.1 Fuentes de Verdad y Estado
- **CONFIRMADO**:
  - `agentId`: Registro canónico en `MultiAgentRunner` (`agentRegistry`).
  - `instanceId`: Acuñado canónicamente por `WebInstanceRegistry` (`createWebInstance`).
  - `debugPort`: Asignado y bloqueado canónicamente por `WebInstanceRegistry` con lockfiles en disco (`.openmcp/ports/*.lock`).
  - `lifecycle status`: Gestionado canónicamente por `MultiAgentRunner` según `AGENT_LIFECYCLE_TRANSITIONS`.
  - `saExtensionId`: Descubierto y asignado canónicamente por `ChromeCDP` (`Extensions.loadUnpacked`) y registrado por agente en `Sentinel`.
  - `selectedAgentId`: Estado de presentación local mantenido en `AppState`.
  - `Sentinel status`: Canónico en `Sentinel` (`lastScanResult`), proyectado en `AppStateData.sentinel`.
  - `ExecutionSnapshot`: Canónico en `ExecutionRegistry` (extensión), proyectado en `AppStateData.executions`.
- **CONFIRMADO**: No existen fuentes de verdad duplicadas ni colisiones de autoridad.

### 2.2 Accesos Directos y Contaminación
- **CONFIRMADO**: Cero llamadas desde la TUI o `AppState` hacia `Runner`, `Sentinel`, `ChromeCDP`, `WIR` o `fetch()`.
- **CONFIRMADO**: Cero importaciones de React en `src/services/webRelay/orchestration/AppState.ts`.
- **CONFIRMADO**: `src/state/AppState.tsx` (store principal de Claude Code) se mantiene 100% independiente de `orchestration/AppState.ts`.
- **CONFIRMADO**: Toda acción de UI viaja exclusivamente: `TUI` → `useOrchestratorState` → `AppState` → `RelayBus.send()` → `MultiAgentRunner` / `ExecutionAdapter`.

### 2.3 Semántica de `ready`
- **CONFIRMADO**: `status = 'ready'` sólo es alcanzable si se superan secuencialmente todos los gates de bloqueo:
  1. `chrome_ready`: Chrome escuchando en su `debugPort`.
  2. `extension_loading`: SuperAssistant detectada específicamente por ID.
  3. `service_worker_ready`: Service Worker de SuperAssistant activo y verificado contra el ID.
- **CONFIRMADO**: Si cualquiera de estos falla, el runner transiciona a `'error'` y limpia el proceso.

### 2.4 Semántica de `lost` y Aislamiento de Fallos
- **CONFIRMADO**:
  $$\text{Chrome terminado} \longrightarrow \text{Sentinel (portAlive=false)} \longrightarrow \text{instance:lost} \longrightarrow \text{Runner ('lost')} \longrightarrow \text{AppState} \longrightarrow \text{TUI (color magenta)}$$
- **CONFIRMADO**: `lost ≠ error`. El estado `lost` representa muerte externa inesperada y permite reinicio limpio sin enmascaramiento.
- **CONFIRMADO**: La caída o reinicio del Agente A no muta, no contamina y no afecta el estado operativo del Agente B.

### 2.5 SuperAssistant (CWS vs Local)
- **CONFIRMADO**: SA CWS identificada por ID fijo (`kngiafgkdnlkgmefdafaibkibegkcaef`).
- **CONFIRMADO**: SA local identificada por el ID dinámico devuelto por `Extensions.loadUnpacked`.
- **CONFIRMADO**: El Service Worker se comprueba contra `chrome-extension://${saExtensionId}/`, rechazando cualquier coincidencia con `background.js` de extensiones ajenas.
- **CONFIRMADO**: Dos agentes pueden utilizar simultáneamente la misma build local de SA en procesos Chrome distintos sin colisión.

### 2.6 Sentinel
- **CONFIRMADO**: Sentinel nunca reinicia procesos por su cuenta (detección pasiva).
- **CONFIRMADO**: Si el Service Worker entra en suspensión por inactividad de Manifest V3 tras 30 segundos pero el puerto sigue vivo, Sentinel sólo emite un warning (no marca la instancia como muerta).
- **CONFIRMADO**: Si el servidor MCP global `:3006` no responde pero el puerto sigue vivo, Sentinel sólo emite un warning.
- **CONFIRMADO**: `sentinel:status` devuelve el último resultado conocido en memoria sin ejecutar escaneos secundarios ni provocar eventos.

### 2.7 RelayBus
- **CONFIRMADO**: Transporta comandos hacia ejecutores, eventos hacia observadores y queries hacia sistemas de lectura.
- **CONFIRMADO**: Cero lógica de Chrome, cero estado de ciclo de vida propio, cero polling.

### 2.8 AppState y TUI
- **CONFIRMADO**: `AppState` es una proyección reactiva pura guiada por `applyEvent()`.
- **CONFIRMADO**: `getState()` mantiene estabilidad referencial estricta para `useSyncExternalStore`.
- **CONFIRMADO**: Bootstrap único e idempotente en `replLauncher.tsx` con manejo de degradación: si la orquestación falla, el CLI/REPL principal arranca normalmente.
- **CONFIRMADO**: `/status` y `/mcp status` leen reactivamente sin invocar diagnósticos activos ni hacer polling.

---

## 3. Limitaciones Conocidas

- **LIMITACIÓN CONOCIDA**: **Servidor MCP singleton en :3006**. El servidor MCP actual es un proceso global compartido y no está dividido en endpoints por instancia/agente.
- **LIMITACIÓN CONOCIDA**: **Chrome en Windows y Secure Preferences**. La clonación manual de directorios de perfil con extensiones copiadas en frío puede ser rechazada por Secure Preferences de Chrome 153. La carga debe realizarse mediante `Extensions.loadUnpacked` por CDP en tiempo de ejecución o mediante perfiles con SA pre-instalada desde CWS.
- **LIMITACIÓN CONOCIDA**: **Perfiles de relay efímeros vs cuotas de IA**. Aunque los perfiles Chrome aíslan cookies, almacenamiento y extensiones, el límite de concurrencia de prompts depende de la sesión de usuario y límites de tasa (rate limits) impuestos por las plataformas web (ChatGPT, Gemini, Grok).

---

## 4. Aspectos NO Demostrados

- **NO DEMOSTRADO**: Comportamiento bajo saturación extrema de más de 6 instancias concurrentes de Chrome en una sola máquina Windows con recursos restringidos (RAM < 16 GB).
- **NO DEMOSTRADO**: Consenso multi-agente automático entre ChatGPT, Gemini y Grok resolviendo un conflicto de código (pendiente en `ai-consensus-engine/`).
- **NO DEMOSTRADO**: Recuperación de sesión persistente de ChatGPT tras expiración de tokens OAuth/Cloudflare en navegaciones de fondo desatendidas.

---

## 5. Resumen de Evidencia Ejecutable

1. `bun test src/services/webRelay/`: **124/124 PASS**
2. `bun run scripts/verify-bootstrap.tsx`: **16/16 PASS**
3. `bun run scripts/real-2agent-slice.ts`: **39/39 PASS**
4. `bun run scripts/tui-real-integration.tsx`: **22/22 PASS**
5. `bun run smoke`: **PASS** (`0.7.0 (OpenClaude)`)
