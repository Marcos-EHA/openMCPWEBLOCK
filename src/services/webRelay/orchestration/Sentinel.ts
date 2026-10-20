/**
 * Sentinel — periodic health monitor for running agent instances.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN (informed by empirical evidence from Gate B investigation)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Sentinel does NOT discover anything experimentally at runtime.
 * All behaviors are derived from verified facts:
 *
 *   1. Chrome debug port goes away when Chrome process dies.
 *   2. SA CWS has fixed ID (kngiafgkdnlkgmefdafaibkibegkcaef).
 *   3. SA local has dynamic ID (from Extensions.loadUnpacked, returned by launchChrome).
 *   4. SA local SW title is "Service Worker chrome-extension://<id>/..." — NOT "SuperAssistant".
 *   5. SA SW can be killed by MV3 after 30s inactivity. This is NOT an instance death.
 *   6. "guest" profiles are just --user-data-dir with empty Default/ — not Chrome Guest Mode.
 *   7. MCP server is global on its configured port, not per-instance. MCP down ≠ instance dead.
 *   8. ProcessSingleton is per user-data-dir. Two relay dirs = two Chrome processes.
 *   9. Chrome --remote-debugging-port responds to /json even when no page tabs are open.
 *
 * Sentinel only runs checks against agents in 'ready' state.
 * It does NOT interfere with agents in transitional states (starting, stopping, etc.).
 *
 * When a check fails:
 *   - debug port dead  → agent transitions to 'lost' → Runner can auto-restart
 *   - SA SW inactive   → WARNING only (MV3 kills idle SWs; they revive on navigation)
 *   - MCP unresponsive → WARNING only (global server, not per-instance)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  OrchestratorEvent,
  AgentLifecycleStatus,
  SentinelDiagnostic,
  SentinelLogEntry,
  SentinelCheckResult,
  SentinelScanResult,
  SentinelActivitySnapshot,
  SentinelConversationSnapshot,
} from './types.js'
import { MCP_PORT } from '../../mcpServer/mcpPort.js'
import {
  getAgentStatus,
  listAgents,
  onLifecycleEvent,
  markAgentLost,
} from './MultiAgentRunner.js'
import { checkSAPluginRegistry, inspectSAConfiguration } from '../SAHealthCheck.js'
import {
  inspectConversationFlowSurface,
  readRecentExecutionDiagnostics,
  readRelayConversation,
} from '../ChromeCDP.js'
import { summarizeConversationFlow } from '../ConversationFlowDiagnostics.js'
import { listMasterSessionSources } from '../session/MasterSessionRegistry.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SentinelConfig {
  /** Interval between health scans in ms. Default: 15000 (15s). */
  intervalMs?: number
  /** Emit warnings when SA SW goes inactive? Default: true. */
  warnOnSWInactive?: boolean
  /** Emit warnings when MCP server is unresponsive? Default: true. */
  warnOnMCPDown?: boolean
}

export type { SentinelCheckResult, SentinelScanResult } from './types.js'

type SentinelEventListener = (event: OrchestratorEvent) => void

// ─── Known SA Extension IDs per agent ────────────────────────────────────────
//
// The SA extension ID for each agent is discovered at launch time and stored
// here. Sentinel uses this to check whether the SA Service Worker is still
// active on the correct extension — not on AdBlock or some other extension.
//
// This map is populated by registerSAExtensionId() which must be called by
// the code that knows the result of launchChrome().
// ─────────────────────────────────────────────────────────────────────────────

const SA_CWS_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const knownSAIds = new Map<string, string>()  // agentId → extensionId

/**
 * Register the SA extension ID for an agent. Called after launchChrome returns.
 */
export function registerSAExtensionId(agentId: string, extensionId: string): void {
  knownSAIds.set(agentId, extensionId)
}

/**
 * Remove the SA extension ID for an agent (on stop/remove).
 */
export function unregisterSAExtensionId(agentId: string): void {
  knownSAIds.delete(agentId)
}

// ─── Check functions ─────────────────────────────────────────────────────────

async function checkPortAlive(debugPort: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    return resp.ok
  } catch {
    return false
  }
}

async function checkSAServiceWorkerActive(
  debugPort: number,
  extensionId?: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`, {
      signal: AbortSignal.timeout(3000),
    })
    const targets = await resp.json() as any[]
    return targets.some(
      (t: any) =>
        t.type === 'service_worker' &&
        (
          (extensionId && t.url?.includes(`chrome-extension://${extensionId}/`)) ||
          (!extensionId && (
            t.url?.includes(SA_CWS_ID) ||
            String(t.title || '').includes('SuperAssistant')
          ))
        ),
    )
  } catch {
    return false
  }
}

async function checkMCPAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`, {
      signal: AbortSignal.timeout(3000),
    })
    return resp.ok
  } catch {
    return false
  }
}

// ─── Sentinel core ──────────────────────────────────────────────────────────

let scanInterval: ReturnType<typeof setInterval> | null = null
let activeScan: Promise<SentinelScanResult> | null = null
const sentinelListeners: Set<SentinelEventListener> = new Set()

let lastScanResult: SentinelScanResult = {
  healthy: true,
  agentsChecked: 0,
  issuesFound: 0,
  details: [],
  logs: [],
}
const sentinelLogs: SentinelLogEntry[] = []
const activeDiagnostics = new Map<string, SentinelDiagnostic>()
const MAX_SENTINEL_LOGS = 200
let logCounter = 0
let unsubscribeRunner: (() => void) | null = null

function sanitizeLogMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b(session[-_ ]?token|authorization|cookie|password|api[-_ ]?key)\b(\s*[:=]\s*)[^,\s;]+/gi,
      '$1$2[redacted]',
    )
}

function appendLog(entry: Omit<SentinelLogEntry, 'id' | 'timestamp'>): void {
  const log: SentinelLogEntry = {
    ...entry,
    message: sanitizeLogMessage(entry.message),
    id: `sentinel-${Date.now()}-${++logCounter}`,
    timestamp: Date.now(),
  }
  sentinelLogs.unshift(log)
  if (sentinelLogs.length > MAX_SENTINEL_LOGS) sentinelLogs.length = MAX_SENTINEL_LOGS
  lastScanResult = { ...lastScanResult, logs: [...sentinelLogs] }
  emitSentinel({ type: 'event', name: 'sentinel:log', payload: log })
}

function updateDiagnosticLogs(results: SentinelCheckResult[]): void {
  const currentDiagnostics = new Map<string, SentinelDiagnostic>()
  const monitoredAgentIds = new Set(results.map(result => result.agentId))
  for (const result of results) {
    for (const diagnostic of result.diagnostics) {
      const key = `${result.agentId}:${diagnostic.code}`
      currentDiagnostics.set(key, diagnostic)
      const previous = activeDiagnostics.get(key)
      if (!previous || previous.message !== diagnostic.message || previous.severity !== diagnostic.severity) {
        appendLog({
          severity: diagnostic.severity,
          code: diagnostic.code,
          agentId: result.agentId,
          message: diagnostic.message,
        })
      }
    }

  }
  for (const [key, previous] of activeDiagnostics) {
    if (currentDiagnostics.has(key)) continue
    const separatorIndex = key.lastIndexOf(':')
    const agentId = key.slice(0, separatorIndex)
    const stillMonitored = monitoredAgentIds.has(agentId)
    appendLog({
      severity: 'info',
      code: stillMonitored ? 'diagnostic-resolved' : 'agent-no-longer-monitored',
      agentId,
      message: stillMonitored
        ? `Incidencia resuelta: ${previous.message}`
        : `Se dejó de supervisar el agente; no se puede confirmar si la incidencia se resolvió: ${previous.message}`,
    })
  }
  activeDiagnostics.clear()
  for (const [key, diagnostic] of currentDiagnostics) {
    activeDiagnostics.set(key, diagnostic)
  }
}

function addMasterSourceDiagnostic(
  agent: ReturnType<typeof listAgents>[number],
  sourceExists: boolean,
  registryError: string | null,
  diagnostics: SentinelDiagnostic[],
): void {
  if (agent.sessionMode !== 'authenticated') return
  if (!agent.masterSessionSourceId) {
    diagnostics.push({
      severity: 'error',
      code: 'missing-master-source',
      message: 'Relay autenticado sin identidad de fuente Master Session asociada.',
    })
  } else if (registryError) {
    diagnostics.push({
      severity: 'error',
      code: 'master-source-registry-unavailable',
      message: `No se pudo verificar la fuente Master Session asociada: ${registryError}`,
    })
  } else if (!sourceExists) {
    diagnostics.push({
      severity: 'error',
      code: 'unknown-master-source',
      message: `La fuente Master Session "${agent.masterSessionSourceId}" ya no está registrada.`,
    })
  }
}

/**
 * Return the most recent scan result without triggering any new scan,
 * probe, or lifecycle state transition.
 */
export function getLastScanResult(): SentinelScanResult {
  return lastScanResult
}

/**
 * Read recent execution lifecycle metadata from one explicitly selected Relay.
 * This is a one-shot, read-only query and never reads conversation content.
 */
export async function readAgentExecutionActivity(
  agentId: string,
): Promise<SentinelActivitySnapshot> {
  const agent = listAgents().find(item => item.agentId === agentId)
  if (!agent) {
    throw new Error(`Sentinel cannot inspect unregistered agent "${agentId}".`)
  }
  if (agent.status !== 'ready' || !agent.debugPort) {
    return {
      agentId,
      available: false,
      unavailableReason: 'agent-not-ready',
      events: [],
    }
  }
  if (!agent.saExtensionId) {
    return {
      agentId,
      available: false,
      unavailableReason: 'missing-extension-id',
      events: [],
    }
  }

  const events = await readRecentExecutionDiagnostics(agent.debugPort, agent.saExtensionId)
  if (events === null) {
    return {
      agentId,
      available: false,
      unavailableReason: 'extension-service-worker-unavailable',
      events: [],
    }
  }
  return { agentId, available: true, events }
}

/**
 * Read a bounded ChatGPT conversation snapshot for one explicitly registered
 * Relay. The caller must obtain user consent before invoking this operation.
 */
export async function readAgentConversation(
  agentId: string,
): Promise<SentinelConversationSnapshot> {
  const agent = listAgents().find(item => item.agentId === agentId)
  if (!agent) {
    throw new Error(`Sentinel cannot inspect unregistered agent "${agentId}".`)
  }
  if (agent.status !== 'ready' || !agent.debugPort) {
    return {
      agentId,
      available: false,
      unavailableReason: 'agent-not-ready',
      messages: [],
      truncated: false,
    }
  }
  return readRelayConversation(agentId, agent.debugPort, agent.platformId)
}

function emitSentinel(event: OrchestratorEvent): void {
  for (const listener of sentinelListeners) {
    try { listener(event) } catch { /* listeners must not break sentinel */ }
  }
}

/**
 * Subscribe to Sentinel-emitted events.
 * Returns an unsubscribe function.
 */
export function onSentinelEvent(listener: SentinelEventListener): () => void {
  sentinelListeners.add(listener)
  return () => { sentinelListeners.delete(listener) }
}

// Callback for when an agent dies — defaults to Runner's markAgentLost
let onAgentLost: ((agentId: string) => void) | null = markAgentLost

/**
 * Register a callback for when Sentinel detects a dead instance.
 * Typically connected to the Runner's transition logic.
 */
export function setOnAgentLost(callback: (agentId: string) => void): void {
  onAgentLost = callback
}

/**
 * Run a single health scan across all 'ready' agents.
 * Can be called manually for testing, or is called periodically by start().
 */
export function scan(config?: SentinelConfig): Promise<SentinelScanResult> {
  if (activeScan) return activeScan
  const pending = performScan(config).finally(() => {
    if (activeScan === pending) activeScan = null
  })
  activeScan = pending
  return pending
}

async function performScan(config?: SentinelConfig): Promise<SentinelScanResult> {
  const agents = listAgents()
  const readyAgents = agents.filter(a => a.status === 'ready')
  let masterSessionSources: ReturnType<typeof listMasterSessionSources> = []
  let masterRegistryError: string | null = null
  if (readyAgents.some(agent => agent.sessionMode === 'authenticated')) {
    try {
      masterSessionSources = listMasterSessionSources()
    } catch (error) {
      masterRegistryError = error instanceof Error ? error.message : String(error)
    }
  }

  const results: SentinelCheckResult[] = []

  for (let offset = 0; offset < readyAgents.length; offset += 4) {
    await Promise.all(readyAgents.slice(offset, offset + 4).map(async agent => {
    const diagnostics: SentinelDiagnostic[] = []
    const masterSessionSource = agent.masterSessionSourceId
      ? masterSessionSources.find(source => source.id === agent.masterSessionSourceId)
      : undefined
    addMasterSourceDiagnostic(
      agent,
      masterSessionSource !== undefined,
      masterRegistryError,
      diagnostics,
    )
    if (!agent.debugPort) {
      diagnostics.push({
        severity: 'error',
        code: 'missing-debug-port',
        message: 'El agente está marcado ready pero no tiene un puerto CDP registrado.',
      })
      results.push({
        agentId: agent.agentId,
        debugPort: 0,
        portAlive: false,
        swActive: null,
        mcpAlive: null,
        sessionMode: agent.sessionMode,
        masterSessionSourceId: agent.masterSessionSourceId,
        ...(masterSessionSource ? { masterSessionSourceName: masterSessionSource.name } : {}),
        saConfiguration: null,
        diagnostics,
      })
      return
    }

    const portAlive = await checkPortAlive(agent.debugPort)

    let swActive: boolean | null = null
    if (portAlive && config?.warnOnSWInactive !== false) {
      const saId = knownSAIds.get(agent.agentId) ?? agent.saExtensionId
      swActive = await checkSAServiceWorkerActive(agent.debugPort, saId)
    }

    let mcpAlive: boolean | null = null
    if (portAlive && config?.warnOnMCPDown !== false) {
      mcpAlive = await checkMCPAlive()
    }

    let saConfiguration: SentinelCheckResult['saConfiguration'] = null
    let conversationFlow: SentinelCheckResult['conversationFlow'] = null
    if (!portAlive) {
      diagnostics.push({
        severity: 'error',
        code: 'chrome-unreachable',
        message: `Chrome no responde en CDP :${agent.debugPort}; el relay no puede recibir tareas.`,
      })
    } else {
      try {
        const snapshot = await inspectSAConfiguration(
          agent.debugPort,
          agent.platformId,
          undefined,
          agent.saExtensionId,
        )
        if (!snapshot) {
          diagnostics.push({
            severity: 'error',
            code: 'platform-tab-not-found',
            message: `No se encontró una pestaña de ${agent.platformId} para inspeccionar SuperAssistant.`,
          })
        } else {
          saConfiguration = { inspected: true, ...snapshot }
          const pluginReadiness = checkSAPluginRegistry(snapshot.pluginRegistry, agent.platformId)
          if (!pluginReadiness.ready) {
            diagnostics.push({
              severity: 'error',
              code: 'sa-plugin-registry-incomplete',
              message: `El registro de plugins de SuperAssistant está incompleto: ${JSON.stringify(pluginReadiness)}.`,
            })
          }
          const requiredPreferences: Array<[
            'mcpEnabled' | 'pushContentMode' | 'autoInsert' | 'autoSubmit' |
              'autoExecute' | 'sidebarVisible' | 'compactButtonVisible',
            string,
          ]> = [
            ['mcpEnabled', 'MCP de SuperAssistant'],
            ['pushContentMode', 'Push Content Mode'],
            ['autoInsert', 'Auto Insert'],
            ['autoSubmit', 'Auto Submit'],
            ['autoExecute', 'Auto Execute'],
            ['sidebarVisible', 'barra lateral'],
            ['compactButtonVisible', 'botón compacto de SuperAssistant'],
          ]
          for (const [key, label] of requiredPreferences) {
            if (snapshot[key] !== true) {
              diagnostics.push({
                severity: 'error',
                code: `sa-${key}-disabled`,
                message: `${label} no está confirmado como activo en este perfil.`,
              })
            }
          }
          if (agent.platformId === 'chatgpt' && snapshot.compactButtonVisible) {
            const compact = snapshot.compactButtonInComposer === true &&
              snapshot.compactButtonWidth !== null &&
              snapshot.compactButtonHeight !== null &&
              snapshot.compactButtonWidth <= 40 &&
              snapshot.compactButtonHeight <= 40 &&
              snapshot.compactButtonLabelVisible === false
            if (!compact) {
              diagnostics.push({
                severity: 'error',
                code: 'sa-chatgpt-button-not-compact',
                message: 'El botón de SuperAssistant está visible, pero no se confirma compacto y dentro del compositor.',
              })
            }
          }
          if (snapshot.sidebarVisible === true && snapshot.sidebarCollapsed === false) {
            diagnostics.push({
              severity: 'error',
              code: 'sa-sidebar-not-collapsed',
              message: `La barra lateral de SuperAssistant está expandida (ancho observado: ${snapshot.sidebarWidth ?? 'desconocido'}px).`,
            })
          }
          if (snapshot.sidebarVisible === true && snapshot.sidebarCollapsed === null) {
            diagnostics.push({
              severity: 'warning',
              code: 'sa-sidebar-layout-unobserved',
              message: 'La barra lateral figura como visible, pero no se pudo inspeccionar su estado colapsado y ancho renderizado.',
            })
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        diagnostics.push({
          severity: 'error',
          code: 'sa-inspection-failed',
          message: `No se pudo inspeccionar la configuración de SuperAssistant: ${detail}`,
        })
      }
    }

    if (portAlive) {
      try {
        const [surface, executionEvents] = await Promise.all([
          inspectConversationFlowSurface(agent.debugPort, agent.platformId),
          agent.saExtensionId
            ? readRecentExecutionDiagnostics(agent.debugPort, agent.saExtensionId, 100)
            : Promise.resolve(null),
        ])
        const analysis = summarizeConversationFlow(
          surface,
          executionEvents ?? [],
          saConfiguration?.autoExecute ?? null,
        )
        conversationFlow = analysis.summary
        diagnostics.push(...analysis.diagnostics)
        if (!surface.available) {
          diagnostics.push({
            severity: 'warning',
            code: 'conversation-flow-surface-unavailable',
            message: surface.reason ?? 'Could not inspect the platform conversation surface.',
          })
        }
      } catch (error) {
        diagnostics.push({
          severity: 'warning',
          code: 'conversation-flow-inspection-failed',
          message: `No se pudo verificar el observer y el flujo de conversación: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    if (portAlive && swActive === false) {
      diagnostics.push({
        severity: 'warning',
        code: 'service-worker-inactive',
        message: 'El service worker de SA está inactivo; Chrome puede suspenderlo por MV3 mientras está ocioso.',
      })
    }
    if (portAlive && mcpAlive === false) {
      diagnostics.push({
        severity: 'warning',
        code: 'mcp-unavailable',
        message: `El servidor MCP global no responde en :${MCP_PORT}; afecta a todos los relays.`,
      })
    }

    results.push({
      agentId: agent.agentId,
      debugPort: agent.debugPort,
      portAlive,
      swActive,
      mcpAlive,
      sessionMode: agent.sessionMode,
      masterSessionSourceId: agent.masterSessionSourceId,
      ...(masterSessionSource ? { masterSessionSourceName: masterSessionSource.name } : {}),
      saConfiguration,
      conversationFlow,
      diagnostics,
    })

    // ── Heartbeat event ──────────────────────────────────────────
    emitSentinel({
      type: 'event',
      name: 'sentinel:heartbeat',
      payload: { agentId: agent.agentId, alive: portAlive },
    })

    // ── Port dead = instance lost ────────────────────────────────
    if (!portAlive) {
      console.warn(
        `[Sentinel] Agent ${agent.agentId} — Chrome on port ${agent.debugPort} is DEAD.`,
      )
      emitSentinel({
        type: 'event',
        name: 'instance:lost',
        payload: {
          instanceId: agent.instanceId ?? 'unknown',
          agentId: agent.agentId,
        },
      })
      if (onAgentLost) {
        try { onAgentLost(agent.agentId) } catch {}
      }
    }

    // ── SA SW inactive (WARNING only) ────────────────────────────
    if (portAlive && swActive === false) {
      // MV3 kills idle SWs after 30s. This is expected behavior.
      // The SW revives automatically when a content script message
      // arrives or a page navigation triggers the extension.
      // NOT an instance death.
      console.warn(
        `[Sentinel] Agent ${agent.agentId} — SA Service Worker not active ` +
        `(MV3 may have suspended it). Port ${agent.debugPort} is still alive.`,
      )
    }

    // ── MCP down (WARNING only) ──────────────────────────────────
    if (portAlive && mcpAlive === false) {
      // MCP server is global, not per-instance. If it's down,
      // ALL agents are affected, not just this one.
      console.warn(
        `[Sentinel] Agent ${agent.agentId} — MCP server on :${MCP_PORT} not responding.`,
      )
    }
    }))
  }

  const issuesFound = results.reduce(
    (count, result) => count + result.diagnostics.filter(item => item.severity === 'error').length,
    0,
  )
  updateDiagnosticLogs(results)
  const scanResult: SentinelScanResult = {
    healthy: issuesFound === 0,
    agentsChecked: readyAgents.length,
    issuesFound,
    scannedAt: Date.now(),
    details: results,
    logs: [...sentinelLogs],
  }
  lastScanResult = scanResult

  emitSentinel({
    type: 'event',
    name: 'sentinel:scan',
    payload: scanResult,
  })

  return scanResult
}

/**
 * Start periodic health scanning.
 */
export function start(config?: SentinelConfig): void {
  if (scanInterval) return // already running

  unsubscribeRunner = onLifecycleEvent(event => {
    if (event.name !== 'agent:lifecycle' || event.payload.to !== 'error' || !event.payload.error) return
    appendLog({
      severity: 'error',
      code: 'agent-start-failed',
      agentId: event.payload.agentId,
      message: event.payload.error,
    })
  })

  const interval = config?.intervalMs ?? 15000
  console.log(`[Sentinel] Starting health monitor — scan every ${interval}ms`)

  // First scan after a short delay (let agents stabilize)
  setTimeout(() => scan(config), 3000)

  scanInterval = setInterval(() => {
    scan(config).catch(err => {
      console.error(`[Sentinel] Scan failed: ${err.message}`)
    })
  }, interval)
}

/**
 * Stop periodic health scanning.
 */
export function stop(): void {
  unsubscribeRunner?.()
  unsubscribeRunner = null
  if (scanInterval) {
    clearInterval(scanInterval)
    scanInterval = null
    console.log('[Sentinel] Stopped health monitor')
  }
}

/**
 * Reset Sentinel state (for testing).
 */
export function resetSentinel(): void {
  stop()
  sentinelListeners.clear()
  knownSAIds.clear()
  sentinelLogs.length = 0
  activeDiagnostics.clear()
  logCounter = 0
  onAgentLost = markAgentLost
  lastScanResult = {
    healthy: true,
    agentsChecked: 0,
    issuesFound: 0,
    details: [],
    logs: [],
  }
}
