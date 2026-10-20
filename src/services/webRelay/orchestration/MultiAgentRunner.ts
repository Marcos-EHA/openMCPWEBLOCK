/**
 * MultiAgentRunner — lifecycle authority for agents in OpenMCPWEBLOCK.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSIBILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Create/register agents.
 * 2. Start Chrome instances through the real launch flow (ChromeCDP.launchChrome).
 * 3. Advance through lifecycle verification gates defined in types.ts.
 * 4. Stop instances (per-agent, targeted by debug port PID).
 * 5. Restart instances (controlled stop → cleanup → start).
 * 6. Serialize all lifecycle operations per-agent (no concurrent start+stop).
 * 7. Emit events AFTER successful mutations (not before, not optimistically).
 * 8. Clean up on every failure path (no orphaned Chrome, no stale WIR entries).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LIFECYCLE GATES vs RUNTIME OBSERVATION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `launchChrome()` is an opaque function that encapsulates:
 *   - Chrome process spawn + waitForDebugPort (20s)
 *   - waitForSAServiceWorker (20s, warn-only on failure)
 *   - verifyRelayPageReady
 *
 * When launchChrome() returns without throwing, chrome_ready is CONFIRMED
 * (waitForDebugPort succeeded internally). The subsequent states are
 * VERIFICATION GATES — independent checks that confirm each subsystem
 * is operational. They are not runtime observations of a startup sequence;
 * they are post-launch confirmations that can each independently fail
 * (Chrome dies between launch and check, SW disappears, MCP not running).
 *
 * To achieve true runtime observation of startup phases, launchChrome()
 * would need to be split into callable phases or accept progress callbacks.
 * That refactoring belongs in ChromeCDP, not in the runner.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SINGLETON GUARANTEE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MultiAgentRunner uses module-level Maps (agents, agentMutex, listeners).
 * In Node/Bun ESM, a module is loaded once per process. Within a single
 * process, there IS only one runner — the module singleton pattern.
 *
 * Cross-process safety is delegated to WebInstanceRegistry's port locks:
 * each lock file records PID + BOOT_ID + instanceId. A second process
 * cannot claim a port already locked by a live process. However, agent-level
 * coordination (the per-agent mutex) is process-local only.
 *
 * If two CLI processes both try to manage agent "X", their port locks will
 * prevent port collisions, but they will maintain independent agent state.
 * This is consistent with the existing architecture where the CLI is a
 * single-process application.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * - Detect externally-dead instances (that's Sentinel's job)
 * - Manage ExecutionRegistry (that's below, inside the extension SW)
 * - Duplicate identity systems (uses agentId/instanceId from WIR)
 * - Poll for health (Sentinel does that)
 * - Touch chrome.storage.local or executionKey
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONCURRENCY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A per-agent mutex (promise chain) guarantees that for any given agentId,
 * only one lifecycle operation runs at a time. This prevents:
 *   start + start, start + stop, stop + restart, restart + restart
 * from racing each other. The mutex is the single source of truth for
 * "is there a lifecycle operation in flight for this agent?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * killByPort() SAFETY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ChromeCDP.killChrome() kills a module-level singleton `chromeProcess`.
 * In multi-agent this would kill whichever Chrome was launched last.
 * closeChrome() uses `taskkill /IM chrome.exe /F` — kills ALL Chrome
 * processes including the user's real browser. NEVER used.
 *
 * killByPort() instead:
 *   1. netstat → find PID listening on the specific debug port
 *   2. tasklist → verify PID is chrome.exe (not an unrelated process)
 * 3. verify the PID's command line matches this agent's dedicated profile
 * 4. re-verify PID still owns the port (guard against PID reuse race)
 * 5. taskkill /F /PID <pid> /T → targeted kill
 *
 * Port collision between agents within a single process is prevented by
 * WIR's port lock mechanism plus a CDP liveness check before launch.
 */

import path from 'path'
import {
  adoptWebInstance,
  createWebInstance,
  getWebInstance,
  getWebInstanceForAgent,
  updateWebInstance,
  releaseWebInstance,
  reclaimStalePortLocks,
  listWebInstances,
  getManagedDebugPortRange,
  type WebInstance,
} from '../WebInstanceRegistry.js'

import {
  getInstanceIdentity,
  isDebugPortActive,
  launchChrome,
  navigateRelayPage,
  stampInstanceIdentity,
} from '../ChromeCDP.js'
import { SessionBroker } from '../session/SessionBroker.js'
import { verifyChatGPTAuth } from '../session/ChatGPTAuthVerifier.js'
import { verifyClaudeAuth } from '../session/ClaudeAuthVerifier.js'
import { getWebPlatformById } from '../../../utils/webPlatforms.js'
import { MCP_PORT } from '../../mcpServer/mcpPort.js'

import {
  type AgentConfig,
  type AgentRecoveryResult,
  type AgentState,
  type AgentLifecycleStatus,
  type OrchestratorEvent,
  type SystemHealth,
  isTransitionValid,
} from './types.js'

// ─── Event listener type ─────────────────────────────────────────────────────

export type LifecycleEventListener = (event: OrchestratorEvent) => void

// ─── Per-agent mutex ─────────────────────────────────────────────────────────

/**
 * A per-agent promise chain that serializes lifecycle operations.
 *
 * Instead of scattered boolean flags, every lifecycle operation is enqueued
 * as a link in the agent's promise chain. The chain itself is the single
 * source of truth for "is there work in flight for this agent?" — if the
 * chain's tail is pending, something is running.
 */
const agentMutex = new Map<string, Promise<void>>()

function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentMutex.get(agentId) ?? Promise.resolve()
  let resolve: (v: T) => void
  let reject: (e: unknown) => void
  const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })

  const next = prev.then(
    () => fn().then(resolve!, reject!),
    () => fn().then(resolve!, reject!),  // even if prev failed, proceed
  )

  // Store the chain (always resolves so the next op can run even after failure)
  agentMutex.set(agentId, next.then(() => {}, () => {}))
  return result
}

// ─── Internal agent registry ────────────────────────────────────────────────
//
// This is NOT a second source of truth for instance state — that's WIR.
// This tracks the agent-level config and lifecycle status, which WIR doesn't
// model (WIR tracks instances, not logical agents).
// ─────────────────────────────────────────────────────────────────────────────

interface InternalAgentRecord {
  config: AgentConfig
  status: AgentLifecycleStatus
  instanceId?: string
  saExtensionId?: string
  error?: string
  createdAt: number
}

const agents = new Map<string, InternalAgentRecord>()

// ─── Event emission ──────────────────────────────────────────────────────────

const listeners: Set<LifecycleEventListener> = new Set()

export function onLifecycleEvent(listener: LifecycleEventListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function emit(event: OrchestratorEvent): void {
  for (const listener of listeners) {
    try { listener(event) } catch { /* listeners must not break the runner */ }
  }
}

// ─── Lifecycle transition ────────────────────────────────────────────────────

function transitionAgent(
  agentId: string,
  to: AgentLifecycleStatus,
  extra?: { error?: string },
): void {
  const record = agents.get(agentId)
  if (!record) throw new Error(`[MultiAgentRunner] Unknown agent: ${agentId}`)

  const from = record.status
  if (from === to) return // no-op transition

  if (!isTransitionValid(from, to)) {
    throw new Error(
      `[MultiAgentRunner] Invalid lifecycle transition for ${agentId}: ${from} → ${to}`,
    )
  }

  record.status = to
  record.error = extra?.error ?? (to === 'error' ? record.error : undefined)

  emit({
    type: 'event',
    name: 'agent:lifecycle',
    payload: { agentId, from, to, error: extra?.error },
  })
}

// ─── Helper: kill Chrome by debug port (hardened) ────────────────────────────
//
// ChromeCDP.killChrome() is a singleton — it kills whichever chrome process
// was spawned last. closeChrome() kills ALL chrome.exe. Both are wrong for
// multi-agent.
//
// killByPort() sequence:
//   1. netstat → find PID listening on the debug port
//   2. tasklist → verify PID is chrome.exe
//   3. verify PID command line belongs to this instance's dedicated profile
//   4. re-query netstat → verify PID still owns the port (race guard)
//   5. taskkill /F /PID <pid> /T → targeted kill
//
// If any verification step fails, the kill is aborted rather than risking
// killing the wrong process.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the PID currently listening on a TCP port (Windows).
 * Returns the PID, or null if nothing is listening.
 */
async function findPidOnPort(port: number): Promise<number | null> {
  if (process.platform !== 'win32') {
    try {
      const { execSync } = await import('child_process')
      const out = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 }).trim()
      if (!out) return null
      const pid = parseInt(out.split('\n')[0]!, 10)
      return pid > 0 ? pid : null
    } catch { return null }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { execSync } = await import('child_process')
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 10000 })
      for (const rawLine of out.split('\n')) {
        const line = rawLine.trim()
        if (!line.includes(':' + port) || !line.includes('LISTENING')) continue
        const parts = line.split(/\s+/)
        if (parts[1]?.endsWith(':' + port)) {
          const pid = parseInt(parts[parts.length - 1]!, 10)
          if (pid > 0 && pid !== process.pid) return pid
        }
      }
    } catch (err: any) {
      console.warn(`[MultiAgentRunner] findPidOnPort(${port}) attempt ${attempt} error:`, err?.message)
    }
    if (attempt < 2) await sleep(200)
  }
  return null
}

/**
 * Verify that a given PID is a chrome.exe process (Windows).
 */
async function isPidChrome(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return true // assume yes on non-Windows
  try {
    const { execSync } = await import('child_process')
    const out = execSync(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
    return out.toLowerCase().includes('chrome.exe')
  } catch {
    return false
  }
}

async function killByPort(debugPort: number, instanceId: string): Promise<void> {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_TEST === 'true' ||
    typeof (globalThis as any).describe === 'function'
  ) {
    return
  }

  // Step 1: Find PID listening on this port
  const pid = await findPidOnPort(debugPort)
  console.log(`[MultiAgentRunner] killByPort(${debugPort}) found PID:`, pid)
  if (pid === null) {
    // Nothing listening — Chrome may already be dead. That's fine.
    return
  }

  // Step 2: Verify PID is chrome.exe (don't kill random processes)
  const isChrome = await isPidChrome(pid)
  console.log(`[MultiAgentRunner] killByPort(${debugPort}) PID ${pid} isChrome:`, isChrome)
  if (!isChrome) {
    console.warn(
      `[MultiAgentRunner] PID ${pid} on port ${debugPort} is not chrome.exe. ` +
      'Refusing to kill — port may have been taken by another process.',
    )
    return
  }

  if (!(await isOwnedChromeInstance(pid, debugPort, instanceId))) {
    console.warn(
      `[MultiAgentRunner] Refusing to stop Chrome PID ${pid} on port ${debugPort}: ` +
      `its user-data-dir does not match relay instance ${instanceId}.`,
    )
    return
  }

  // Step 3: Re-verify PID still owns the port (race guard)
  const pidRecheck = await findPidOnPort(debugPort)
  console.log(`[MultiAgentRunner] killByPort(${debugPort}) pidRecheck:`, pidRecheck)
  if (pidRecheck !== pid) {
    console.warn(
      `[MultiAgentRunner] PID on port ${debugPort} changed from ${pid} to ${pidRecheck} ` +
      'during verification. Aborting kill to avoid targeting wrong process.',
    )
    return
  }

  // Step 4: Kill with PID targeting
  console.log(`[MultiAgentRunner] killByPort(${debugPort}) executing taskkill on PID ${pid}...`)
  try {
    const { execSync } = await import('child_process')
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore', timeout: 10000 })
    } else {
      execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'ignore', timeout: 5000 })
    }
  } catch (err: any) {
    console.warn(`[MultiAgentRunner] taskkill failed:`, err?.message)
  }

  // Wait for the port to actually free up
  for (let i = 0; i < 15; i++) {
    if (!(await isDebugPortActive(debugPort))) {
      console.log(`[MultiAgentRunner] killByPort(${debugPort}) port confirmed inactive`)
      return
    }
    await sleep(500)
  }
  console.warn(`[MultiAgentRunner] killByPort(${debugPort}) port still active after wait`)
}

async function isOwnedChromeInstance(
  pid: number,
  debugPort: number,
  instanceId: string,
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false

  try {
    const { execSync } = await import('child_process')
    const output = process.platform === 'win32'
      ? execSync(
        `powershell.exe -NoProfile -NonInteractive -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine"`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      : execSync(`ps -p ${pid} -o args=`, {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })

    const normalizedCommandLine = output.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
    const expectedUserDataDir = path.join(
      process.env.LOCALAPPDATA ?? '',
      'openMCPWEBLOCK',
      'chrome-agents',
      instanceId,
    ).replace(/\\/g, '/').toLowerCase()

    return normalizedCommandLine.includes(`--remote-debugging-port=${debugPort}`) &&
      normalizedCommandLine.includes(`--user-data-dir=${expectedUserDataDir}`)
  } catch (error) {
    console.warn(
      `[MultiAgentRunner] Could not verify ownership of Chrome PID ${pid} on port ${debugPort}; ` +
      `refusing to stop it: ${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

// ─── SA identification ───────────────────────────────────────────────────────
//
// The SA extension exists in two forms:
//   1. Chrome Web Store version: ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
//   2. Local build (chrome-extension/source/dist): dynamic ID assigned by Chrome
//      based on the path. CANNOT be predicted.
//
// For (1): the URL of any SA target contains the CWS ID.
// For (2): the URL contains the dynamic ID but we can't know it a priori.
//         We identify it by the title 'MCP SuperAssistant' or 'SuperAssistant'.
//
// IMPORTANT: Do NOT use 'background.js' as a match criterion. MANY extensions
// (AdBlock, uBlock, etc.) use background.js — this caused the vertical slice
// to falsely report SA present when only AdBlock was active.
// ─────────────────────────────────────────────────────────────────────────────

const SA_CWS_EXTENSION_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'

interface CDPTarget {
  type: string
  url: string
  title?: string
  id?: string
}

/**
 * Test whether a CDP target belongs to the SA extension.
 *
 * Matches:
 *   - URL contains the CWS extension ID (CWS version, profile-synced)
 *   - Title matches 'SuperAssistant' or 'MCP SuperAssistant' (local build)
 *
 * Does NOT match:
 *   - Generic 'background.js' (too broad — many extensions have it)
 *   - Any other extension that doesn't carry the SA identity
 */
function isSATarget(target: CDPTarget): boolean {
  // CWS version: URL always contains the extension ID
  if (target.url?.includes(SA_CWS_EXTENSION_ID)) return true
  // Local build: title set by Chrome from manifest.name
  const title = String(target.title || '')
  if (title.includes('SuperAssistant') || title.includes('MCP SuperAssistant')) return true
  // mcpsuperassistant in URL (some builds use lowercase package name)
  if (target.url?.includes('mcpsuperassistant')) return true
  return false
}

/**
 * Fetch all CDP targets from a debug port and return SA-specific ones.
 * Returns { allTargets, saTargets, saServiceWorkers } for diagnostics.
 */
async function querySATargets(debugPort: number): Promise<{
  allTargets: CDPTarget[]
  saTargets: CDPTarget[]
  saServiceWorkers: CDPTarget[]
}> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`, {
      signal: AbortSignal.timeout(3000),
    })
    const allTargets = await resp.json() as CDPTarget[]
    const saTargets = allTargets.filter(isSATarget)
    const saServiceWorkers = saTargets.filter(t => t.type === 'service_worker')
    return { allTargets, saTargets, saServiceWorkers }
  } catch {
    return { allTargets: [], saTargets: [], saServiceWorkers: [] }
  }
}

/**
 * Check if the SA extension is PRESENT in Chrome's target list.
 *
 * This confirms Chrome loaded the extension (manifest parsed, resources
 * available), but does NOT confirm the SW is active. The extension could
 * be present as a page target, background_page, or service_worker.
 *
 * Matches ONLY targets that positively identify as SA — not any generic
 * extension with 'background.js'.
 */
async function checkExtensionPresent(debugPort: number): Promise<boolean> {
  const { saTargets } = await querySATargets(debugPort)
  return saTargets.length > 0
}

/**
 * Check if SA's service worker SPECIFICALLY is active.
 *
 * Requires: type === 'service_worker' AND positive SA identification.
 * This is strictly narrower than checkExtensionPresent: the extension
 * can be loaded (manifest parsed) but the SW not yet activated, or
 * MV3 may have killed it after 30s of inactivity.
 */
async function checkServiceWorkerActive(debugPort: number): Promise<boolean> {
  const { saServiceWorkers } = await querySATargets(debugPort)
  return saServiceWorkers.length > 0
}

/**
 * Check if an extension with a SPECIFIC known ID is present in Chrome targets.
 *
 * Used when launchChrome() returns a dynamic saExtensionId (SA local loaded
 * via Extensions.loadUnpacked). The dynamic ID cannot be detected by the
 * title-based isSATarget() because Chrome shows "Service Worker chrome-extension://..."
 * as the title, not "SuperAssistant".
 */
async function checkExtensionById(debugPort: number, extensionId: string): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`, {
      signal: AbortSignal.timeout(5000),
    })
    const targets = (await resp.json()) as CDPTarget[]
    return targets.some(
      t =>
        t.url?.includes(`chrome-extension://${extensionId}/`) ||
        t.url?.includes(SA_CWS_EXTENSION_ID) ||
        String(t.title || '').includes('SuperAssistant') ||
        String(t.title || '').includes('MCP SuperAssistant'),
    )
  } catch {
    return false
  }
}

/**
 * Check if a service worker with a SPECIFIC known extension ID is active.
 */
async function checkServiceWorkerById(debugPort: number, extensionId: string): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`, {
      signal: AbortSignal.timeout(5000),
    })
    const targets = (await resp.json()) as CDPTarget[]
    return targets.some(
      t =>
        t.type === 'service_worker' &&
        (t.url?.includes(`chrome-extension://${extensionId}/`) ||
          t.url?.includes(SA_CWS_EXTENSION_ID) ||
          String(t.title || '').includes('SuperAssistant') ||
          String(t.title || '').includes('MCP SuperAssistant')),
    )
  } catch {
    return false
  }
}

/**
 * Check if the MCP SSE server at its configured localhost port is responding.
 *
 * NOTE: This checks the GLOBAL MCP server, not per-instance readiness.
 * There is currently no per-instance MCP channel. Both agents share
 * the same MCP server on the configured port.
 *
 * mcp_server_ready   = this check (global)
 * instance_mcp_ready = not yet demonstrable (no per-instance endpoint)
 */
async function checkMCPServerResponding(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`, {
      signal: AbortSignal.timeout(3000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Query overall system health: aggregates runner agent states and global MCP server health.
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const allAgents = listAgents()
  const totalAgents = allAgents.length
  const runningAgents = allAgents.filter(a => a.status === 'ready').length
  const deadInstances = allAgents.filter(a => a.status === 'lost' || a.status === 'error').length
  const unknownOutcomes = allAgents.reduce((acc, a) => acc + (a.unknownExecutions || 0), 0)
  const mcpServerRunning = await checkMCPServerResponding()

  return {
    mcpServerRunning,
    totalAgents,
    runningAgents,
    deadInstances,
    unknownOutcomes,
    timestamp: Date.now(),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register an agent without starting it. Returns the initial AgentState.
 * Idempotent: re-registering an existing agent returns its current state.
 */
export function createAgent(config: AgentConfig): AgentState {
  const existing = agents.get(config.agentId)
  if (existing) return projectAgentState(config.agentId)

  const record: InternalAgentRecord = {
    config: {
      ...config,
      sessionMode: config.sessionMode ?? 'clean',
      ...(config.sessionMode === 'authenticated'
        ? { masterSessionSourceId: config.masterSessionSourceId ?? 'loco-verde' }
        : { masterSessionSourceId: undefined }),
      ...(config.sessionMode === 'chrome-profile'
        ? { chromeProfileDirectory: config.chromeProfileDirectory }
        : { chromeProfileDirectory: undefined }),
    },
    status: 'created',
    createdAt: Date.now(),
  }
  agents.set(config.agentId, record)

  emit({
    type: 'event',
    name: 'agent:created',
    payload: {
      agentId: config.agentId,
      platformId: config.platformId,
      ...(config.role ? { role: config.role } : {}),
      sessionMode: record.config.sessionMode,
      ...(record.config.masterSessionSourceId
        ? { masterSessionSourceId: record.config.masterSessionSourceId }
        : {}),
      ...(record.config.chromeProfileDirectory
        ? { chromeProfileDirectory: record.config.chromeProfileDirectory }
        : {}),
    },
  })

  return projectAgentState(config.agentId)
}

function inferRecoveryPurpose(
  identity: { agentId?: string; role?: string },
  platformId: string,
): 'agent' | 'user' | undefined {
  if (!identity.agentId) return undefined
  if (identity.role) {
    return identity.role.startsWith('manual-user-') ? 'user' : 'agent'
  }
  if (identity.agentId.startsWith(`web-${platformId}-user-`)) return 'user'
  if (
    identity.agentId.startsWith(`web-${platformId}-agent-`) ||
    identity.agentId.startsWith(`sentinel-${platformId}-guest-`)
  ) {
    return 'agent'
  }
  return undefined
}

/**
 * Adopt previously launched, identity-stamped Chrome instances without
 * spawning browsers or changing their web-session data.
 */
export async function recoverExistingAgents(
  platformId: string,
  sessionMode: AgentConfig['sessionMode'],
  purpose: 'agent' | 'user' | 'infer',
): Promise<AgentRecoveryResult> {
  if (sessionMode !== 'clean' && sessionMode !== 'authenticated' && sessionMode !== 'chrome-profile') {
    throw new Error('Choose whether the existing profiles are clean or authenticated before reconnecting.')
  }

  const { min, max } = getManagedDebugPortRange()
  const candidates = Array.from({ length: max - min + 1 }, (_, index) => min + index)
  const activePorts: number[] = []
  const concurrency = 16
  for (let batchStart = 0; batchStart < candidates.length; batchStart += concurrency) {
    const results = await Promise.all(candidates.slice(batchStart, batchStart + concurrency).map(async port => ({
      port,
      active: await isDebugPortActive(port),
    })))
    activePorts.push(...results.filter(result => result.active).map(result => result.port))
  }

  const adopted: AgentState[] = []
  const skipped: string[] = []
  const seenAgentIds = new Set<string>()
  let matchingIdentitiesFound = 0

  for (let batchStart = 0; batchStart < activePorts.length; batchStart += 8) {
    const ports = activePorts.slice(batchStart, batchStart + 8)
    const identities = await Promise.all(ports.map(async port => ({
      port,
      identity: await getInstanceIdentity(port).catch(() => null),
    })))

    for (const { port, identity } of identities) {
      if (!identity) {
        skipped.push(`Puerto ${port}: no se encontró una identidad SuperAssistant verificable.`)
        continue
      }
      if (
        identity.schema !== 1 ||
        !identity.agentId ||
        !identity.platformId ||
        !identity.instanceId ||
        !/^web-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(identity.instanceId) ||
        identity.profileDir !== identity.instanceId
      ) {
        skipped.push(`Puerto ${port}: la identidad guardada está incompleta o no es válida.`)
        continue
      }
      if (identity.platformId !== platformId) continue
      matchingIdentitiesFound++
      const storedPurpose = inferRecoveryPurpose(identity, platformId)
      if (purpose === 'infer' && !storedPurpose) {
        skipped.push(`${identity.agentId}: no se pudo inferir de forma segura si es agente o ventana manual.`)
        continue
      }
      const expectedPurpose = storedPurpose ?? purpose
      if (purpose !== 'infer' && storedPurpose && storedPurpose !== purpose) {
        skipped.push(`${identity.agentId}: el propósito guardado no coincide con ${purpose}; no se adjuntó.`)
        continue
      }
      if (identity.sessionMode && identity.sessionMode !== sessionMode) {
        skipped.push(
          `${identity.agentId}: el perfil está marcado como ${identity.sessionMode}; ` +
          `no se adjuntó como ${sessionMode}.`,
        )
        continue
      }
      if (seenAgentIds.has(identity.agentId)) {
        skipped.push(`${identity.agentId}: hay más de un Chrome con la misma identidad; ninguno adicional fue adjuntado.`)
        continue
      }
      seenAgentIds.add(identity.agentId)
      if (agents.has(identity.agentId)) {
        skipped.push(`${identity.agentId}: ya está registrado en esta sesión.`)
        continue
      }

      let instance: WebInstance | undefined
      try {
        instance = adoptWebInstance(
          identity.instanceId,
          identity.agentId,
          identity.platformId,
          port,
          identity.profileDir,
        )

        const verifiedIdentity = await getInstanceIdentity(port)
        const verifiedPurpose = verifiedIdentity
          ? inferRecoveryPurpose(verifiedIdentity, platformId)
          : undefined
        if (
          !verifiedIdentity ||
          verifiedIdentity.instanceId !== identity.instanceId ||
          verifiedIdentity.agentId !== identity.agentId ||
          verifiedIdentity.platformId !== identity.platformId ||
          (verifiedIdentity.sessionMode && verifiedIdentity.sessionMode !== sessionMode) ||
          (verifiedPurpose && verifiedPurpose !== expectedPurpose)
        ) {
          throw new Error('La identidad del navegador cambió durante la reconexión.')
        }
        if (agents.has(identity.agentId)) {
          throw new Error('El agente ya fue registrado mientras se inspeccionaba el perfil.')
        }

        createAgent({
          agentId: identity.agentId,
          platformId: identity.platformId,
          role: identity.role ?? (expectedPurpose === 'user' ? 'manual-user-recovered' : 'recovered'),
          sessionMode,
          ...(sessionMode === 'authenticated'
            ? { masterSessionSourceId: identity.masterSessionSourceId ?? 'loco-verde' }
            : {}),
          ...(sessionMode === 'chrome-profile' && identity.chromeProfileDirectory
            ? { chromeProfileDirectory: identity.chromeProfileDirectory }
            : {}),
        })
        const record = agents.get(identity.agentId)!
        record.instanceId = identity.instanceId
        record.saExtensionId = undefined

        transitionAgent(identity.agentId, 'starting')
        emit({
          type: 'event',
          name: 'instance:bound',
          payload: { agentId: identity.agentId, instanceId: identity.instanceId, debugPort: port },
        })
        transitionAgent(identity.agentId, 'chrome_ready')
        transitionAgent(identity.agentId, 'session_ready')
        transitionAgent(identity.agentId, 'extension_loading')
        transitionAgent(identity.agentId, 'service_worker_ready')
        transitionAgent(identity.agentId, 'mcp_ready')
        updateWebInstance(identity.instanceId, { status: 'ready' })
        transitionAgent(identity.agentId, 'ready')
        adopted.push(projectAgentState(identity.agentId))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (instance) {
          const record = agents.get(identity.agentId)
          if (record && record.instanceId === instance.instanceId && record.status !== 'ready') {
            record.instanceId = undefined
            if (record.status !== 'error') {
              transitionAgent(identity.agentId, 'error', { error: message })
            }
          }
          if (record?.status !== 'ready') releaseWebInstance(instance.instanceId)
        }
        skipped.push(`${identity.agentId}: ${message}`)
      }
    }
  }

  return {
    adopted,
    skipped,
    cdpPortsScanned: candidates.length,
    cdpPortsFound: activePorts.length,
    matchingIdentitiesFound,
  }
}

/**
 * Start an agent's Chrome instance. Advances through verification gates.
 *
 * Serialized per-agent: if another lifecycle op is in flight, this waits.
 * If the agent is already running (ready), this is a no-op.
 *
 * On any failure, cleanup runs: Chrome killed by PID, WIR entry released,
 * agent transitions to 'error' with the failure detail.
 */
export function startAgent(agentId: string): Promise<AgentState> {
  return withAgentLock(agentId, () => startAgentImpl(agentId))
}

async function startAgentImpl(agentId: string): Promise<AgentState> {
  const record = agents.get(agentId)
  if (!record) throw new Error(`[MultiAgentRunner] Unknown agent: ${agentId}. Call createAgent() first.`)

  // Already operational — no-op
  if (record.status === 'ready' || record.status === 'chrome_ready' ||
      record.status === 'extension_loading' || record.status === 'service_worker_ready' ||
      record.status === 'mcp_ready') {
    return projectAgentState(agentId)
  }

  // Not in a state that allows starting
  if (record.status !== 'created' && record.status !== 'stopped' && record.status !== 'error') {
    return projectAgentState(agentId)
  }

  // Reclaim stale port locks from dead processes before allocating.
  // reclaimStalePortLocks() only removes locks whose owning PID is dead
  // (checked via process.kill(pid, 0)). Locks from our own process (PID
  // self-check) or from other live processes are never touched.
  try { reclaimStalePortLocks() } catch { /* best effort */ }

  // ── Step 1: Create WIR instance ──────────────────────────────────
  let webInstance: WebInstance
  const platform = getWebPlatformById(record.config.platformId)
  if (!platform) {
    transitionAgent(agentId, 'error', {
      error: `Unknown web platform "${record.config.platformId}".`,
    })
    return projectAgentState(agentId)
  }
  try {
    transitionAgent(agentId, 'starting')

    const excludedDebugPorts = new Set<number>()
    while (true) {
      webInstance = createWebInstance(record.config.platformId, agentId, {
        excludedDebugPorts,
      })
      if (!(await isDebugPortActive(webInstance.debugPort))) break

      excludedDebugPorts.add(webInstance.debugPort)
      console.warn(
        `[MultiAgentRunner] Port ${webInstance.debugPort} is already serving Chrome; ` +
        'leaving that browser untouched and allocating another relay port.',
      )
      releaseWebInstance(webInstance.instanceId)
    }
    record.instanceId = webInstance.instanceId

    emit({
      type: 'event',
      name: 'instance:bound',
      payload: {
        agentId,
        instanceId: webInstance.instanceId,
        debugPort: webInstance.debugPort,
      },
    })
  } catch (err: any) {
    transitionAgent(agentId, 'error', { error: `Failed to create web instance: ${err.message}` })
    return projectAgentState(agentId)
  }

  // From here on, any failure must clean up the WIR entry and Chrome
  try {
    // ── Step 2: Launch Chrome (opaque) ─────────────────────────────
    // launchChrome() internally:
    //   - syncs profile to relay dir
    //   - installs SA via CDP WebSocket Extensions.loadUnpacked (if needed)
    //   - spawns Chrome process
    //   - waitForDebugPort(20000) — THROWS on timeout
    //   - waitForSAServiceWorker(20000) — WARNS only on failure
    //   - verifyRelayPageReady()
    //
    // When this returns without throwing, the debug port IS active.
    // SA SW may or may not be active (warn-only on failure inside).
    // Returns { saExtensionId } — the dynamic ID of the loaded SA.
    updateWebInstance(webInstance.instanceId, { status: 'starting' })

    const { saExtensionId } = await launchChrome('about:blank', 'Default', {
      instanceId: webInstance.instanceId,
      debugPort: webInstance.debugPort,
      sessionMode: record.config.sessionMode,
      chromeProfileDirectory: record.config.chromeProfileDirectory,
      skipNavigation: true,
      startMinimized: record.config.startMinimized,
    })
    record.saExtensionId = saExtensionId

    // ── Gate: chrome_ready ──────────────────────────────────────────
    // CONFIRMED: launchChrome() returned without throwing, meaning
    // waitForDebugPort() succeeded internally. This is a REAL state,
    // not a post-hoc recheck.
    transitionAgent(agentId, 'chrome_ready')
    updateWebInstance(webInstance.instanceId, { status: 'ready' })

    // ── Gate: session_ready ─────────────────────────────────────────
    // Transfer a supported Master Session in memory, then navigate to the
    // selected platform before checking the remaining startup gates.
    const isTest = process.env.NODE_ENV === 'test' || typeof (globalThis as any).describe === 'function' || !!process.env.BUN_TEST

    if (record.config.sessionMode === 'authenticated' && !isTest) {
      if (webInstance.platformId !== 'chatgpt' && webInstance.platformId !== 'claude') {
        transitionAgent(agentId, 'error', {
          error: `Authenticated sessions are not supported for "${webInstance.platformId}".`,
        })
        await cleanupFailedStart(agentId, webInstance)
        return projectAgentState(agentId)
      }
      const sessionBroker = SessionBroker.getInstance()
      const sourceId = record.config.masterSessionSourceId ?? 'loco-verde'
      const transferResult = await sessionBroker.applySessionToRelay(
        webInstance.debugPort,
        sourceId,
        webInstance.platformId,
      )
      if (!transferResult.ok) {
        transitionAgent(agentId, 'error', {
          error: `Session transfer failed: ${transferResult.reason || 'Master session not authenticated'}`,
        })
        await cleanupFailedStart(agentId, webInstance)
        return projectAgentState(agentId)
      }

      // Navigate to destination
      await navigateRelayPage(webInstance.debugPort, platform.url)

      // Layered authentication verification
      const authResult = webInstance.platformId === 'claude'
        ? await verifyClaudeAuth(webInstance.debugPort, { timeoutMs: 25000 })
        : await verifyChatGPTAuth(webInstance.debugPort, { timeoutMs: 25000 })
      if (authResult.status !== 'authenticated') {
        transitionAgent(agentId, 'error', {
          error: `${platform.name} authentication verification failed (${authResult.status}): ${authResult.reason}`,
        })
        await cleanupFailedStart(agentId, webInstance)
        return projectAgentState(agentId)
      }
    } else {
      await navigateRelayPage(webInstance.debugPort, platform.url)
      if (record.config.sessionMode === 'chrome-profile' && !isTest) {
        if (webInstance.platformId !== 'chatgpt') {
          transitionAgent(agentId, 'error', {
            error: `Los perfiles locales de Chrome solo se admiten para ChatGPT; plataforma recibida: "${webInstance.platformId}".`,
          })
          await cleanupFailedStart(agentId, webInstance)
          return projectAgentState(agentId)
        }
        const authResult = await verifyChatGPTAuth(webInstance.debugPort, { timeoutMs: 25000 })
        if (authResult.status !== 'authenticated') {
          console.warn(
            `[MultiAgentRunner] Chrome profile copy requires sign-in on port ${webInstance.debugPort} ` +
            `(${authResult.status}): ${authResult.reason}. The copied profile is isolated from normal Chrome; ` +
            'keeping the visible Relay open for sign-in.',
          )
        }
      }
    }
    transitionAgent(agentId, 'session_ready')

    // ── Gate: extension_loading ────────────────────────────────────
    // POST-HOC VERIFICATION: independently check that SA extension
    // is present in Chrome's target list. This can fail even though
    // launchChrome() succeeded (extension loading may have failed
    // silently, or Chrome's Secure Preferences rejected it).
    transitionAgent(agentId, 'extension_loading')

    const extAttempts = isTest ? 1 : 6
    let extensionPresent = false
    for (let attempt = 0; attempt < extAttempts; attempt++) {
      extensionPresent = saExtensionId
        ? await checkExtensionById(webInstance.debugPort, saExtensionId)
        : await checkExtensionPresent(webInstance.debugPort)
      if (extensionPresent) break
      if (attempt < extAttempts - 1) await sleep(1000)
    }
    if (!extensionPresent) {
      transitionAgent(agentId, 'error', {
        error: 'SA extension not detected in Chrome targets after launch. ' +
          'This is a known issue with Chrome 153 relay profiles where Secure ' +
          'Preferences silently rejects copied extensions. ' +
          'Use a profile with SA pre-installed via the Chrome Web Store.',
      })
      await cleanupFailedStart(agentId, webInstance)
      return projectAgentState(agentId)
    }

    // ── Gate: service_worker_ready ─────────────────────────────────
    // POST-HOC VERIFICATION: independently confirm the SW is active.
    // Distinct from extension presence: the extension manifest can be
    // loaded but the SW not yet activated, or MV3 killed it after 30s.
    transitionAgent(agentId, 'service_worker_ready')

    const isTestEnv = process.env.NODE_ENV === 'test' || typeof (globalThis as any).describe === 'function' || !!process.env.BUN_TEST
    const maxAttempts = isTestEnv ? 2 : 6
    const retryDelay = isTestEnv ? 50 : 1500

    let swActive = false
    for (let swAttempt = 0; swAttempt < maxAttempts; swAttempt++) {
      swActive = saExtensionId
        ? await checkServiceWorkerById(webInstance.debugPort, saExtensionId)
        : await checkServiceWorkerActive(webInstance.debugPort)
      if (swActive) break
      if (swAttempt < maxAttempts - 1) await sleep(retryDelay)
    }
    if (!swActive) {
      transitionAgent(agentId, 'error', {
        error: `SA service worker not active on port ${webInstance.debugPort}. ` +
          'Extension is present but its background service worker failed to start. ' +
          'This may be a Chrome MV3 activation issue.',
      })
      await cleanupFailedStart(agentId, webInstance)
      return projectAgentState(agentId)
    }

    // ── Gate: mcp_ready ────────────────────────────────────────────
    // REAL-TIME CHECK: stamp identity (which happens NOW, not inside
    // launchChrome) and verify MCP server health.
    transitionAgent(agentId, 'mcp_ready')

    const stampResult = await stampInstanceIdentity(webInstance.debugPort, {
      instanceId: webInstance.instanceId,
      agentId: webInstance.agentId,
      role: record.config.role,
      platformId: webInstance.platformId,
      profileDir: webInstance.profileDir,
      sessionMode: record.config.sessionMode ?? 'clean',
      masterSessionSourceId: record.config.masterSessionSourceId,
      chromeProfileDirectory: record.config.chromeProfileDirectory,
    }, saExtensionId)

    if (!stampResult.ok) {
      // Non-blocking: identity stamp failure degrades isolation but
      // doesn't prevent operation. See docs/EXECUTION_FORENSIC_STATE.md §2.
      console.warn(
        `[MultiAgentRunner] Identity stamp failed for ${agentId}: ${stampResult.reason}. ` +
        'Instance will operate with degraded isolation.',
      )
    }

    const mcpRunning = await checkMCPServerResponding()
    if (!mcpRunning) {
      // Non-blocking: MCP server may not be started yet. The extension
      // can connect to it later when a page is navigated.
      console.warn(
        `[MultiAgentRunner] MCP server not responding on :${MCP_PORT} for ${agentId}. ` +
        'Extension may connect when an AI platform page is visited.',
      )
    }

    // ── Gate: ready ────────────────────────────────────────────────
    // All verification gates passed (some non-blocking warnings may
    // have been emitted). The agent is operational.
    transitionAgent(agentId, 'ready')

    return projectAgentState(agentId)
  } catch (err: any) {
    // ── Cleanup on failure ──────────────────────────────────────────
    await cleanupFailedStart(agentId, webInstance)

    if (record.status !== 'error') {
      transitionAgent(agentId, 'error', { error: `Start failed: ${err.message}` })
    }

    return projectAgentState(agentId)
  }
}

/**
 * Stop an agent's Chrome instance.
 *
 * Idempotent: stopping an already-stopped agent is a no-op.
 * Serialized per-agent.
 */
export function stopAgent(agentId: string): Promise<AgentState> {
  return withAgentLock(agentId, () => stopAgentImpl(agentId))
}

async function stopAgentImpl(agentId: string): Promise<AgentState> {
  const record = agents.get(agentId)
  if (!record) throw new Error(`[MultiAgentRunner] Unknown agent: ${agentId}`)
  console.log(`[MultiAgentRunner] stopAgentImpl(${agentId}) status=${record.status} instanceId=${record.instanceId}`)

  // Already stopped — idempotent
  if (record.status === 'stopped') {
    return projectAgentState(agentId)
  }

  // Can't stop if never started (created only)
  if (record.status === 'created') {
    transitionAgent(agentId, 'stopped')
    emit({ type: 'event', name: 'agent:stopped', payload: { agentId } })
    return projectAgentState(agentId)
  }

  // Transition to stopping
  try {
    transitionAgent(agentId, 'stopping')
  } catch {
    // If transition is invalid (e.g. from 'stopping'), just proceed
  }

  const instanceId = record.instanceId
  if (instanceId) {
    const instance = getWebInstance(instanceId)
    if (instance) {
      // Kill the Chrome process for this port (hardened PID verification)
      await killByPort(instance.debugPort, instance.instanceId)

      // Update WIR status and release
      try { updateWebInstance(instanceId, { status: 'stopped' }) } catch { /* may fail if already stopped */ }
      releaseWebInstance(instanceId)
    }
    record.instanceId = undefined
    record.saExtensionId = undefined
  }

  transitionAgent(agentId, 'stopped')
  emit({ type: 'event', name: 'agent:stopped', payload: { agentId } })

  return projectAgentState(agentId)
}

/**
 * Restart an agent: controlled stop → cleanup → start.
 *
 * Serialized per-agent. Will not launch a second instance accidentally
 * because stop completes (including cleanup) before start begins.
 */
export function restartAgent(agentId: string): Promise<AgentState> {
  return withAgentLock(agentId, async () => {
    const record = agents.get(agentId)
    if (!record) throw new Error(`[MultiAgentRunner] Unknown agent: ${agentId}`)

    if (record.status !== 'stopped' && record.status !== 'created') {
      if (record.status === 'lost') {
        transitionAgent(agentId, 'restarting')
      }
      await stopAgentImpl(agentId)
    }

    return startAgentImpl(agentId)
  })
}

/**
 * Get the current state of an agent.
 */
export function getAgentStatus(agentId: string): AgentState | null {
  if (!agents.has(agentId)) return null
  return projectAgentState(agentId)
}

export function setAgentStartupVerificationStatus(agentId: string): Promise<AgentState> {
  return withAgentLock(agentId, async () => {
    const record = agents.get(agentId)
    if (!record || record.status !== 'sa_preparing') {
      throw new Error('Startup verification requires an agent in SA preparation: ' + agentId)
    }
    transitionAgent(agentId, 'startup_verifying')
    return projectAgentState(agentId)
  })
}

export function setAgentSAConfigurationStatus(
  agentId: string,
  preparing: boolean,
): Promise<AgentState> {
  return withAgentLock(agentId, async () => {
    const record = agents.get(agentId)
    if (!record) throw new Error(`[MultiAgentRunner] Unknown agent: ${agentId}`)
    const expectedStatus = preparing ? 'ready' : 'sa_preparing'
    if (record.status !== expectedStatus && !(preparing === false && record.status === 'startup_verifying')) {
      throw new Error(
        `[MultiAgentRunner] Cannot ${preparing ? 'begin' : 'complete'} SA preparation for ${agentId} in status ${record.status}.`,
      )
    }
    transitionAgent(agentId, preparing ? 'sa_preparing' : 'ready')
    return projectAgentState(agentId)
  })
}

/**
 * List all registered agents.
 */
export function listAgents(): AgentState[] {
  return Array.from(agents.keys()).map(id => projectAgentState(id))
}

/**
 * Remove an agent registration entirely. Must be stopped first.
 */
export function removeAgent(agentId: string): void {
  const record = agents.get(agentId)
  if (!record) return
  if (record.status !== 'stopped' && record.status !== 'created') {
    throw new Error(`[MultiAgentRunner] Cannot remove agent ${agentId} in status ${record.status}. Stop it first.`)
  }
  agents.delete(agentId)
  agentMutex.delete(agentId)
}

/**
 * Mark an agent as lost when its backing Chrome instance unexpectedly terminates.
 * Transitions from 'ready' to 'lost'.
 */
export function markAgentLost(agentId: string): void {
  const record = agents.get(agentId)
  if (!record || record.status !== 'ready') return
  try {
    transitionAgent(agentId, 'lost')
  } catch {
    // If transition is invalid from current state, ignore
  }
}

/**
 * Reset runner state. For testing only.
 */
export function resetRunner(): void {
  agents.clear()
  agentMutex.clear()
  listeners.clear()
}

// ─── Exported for testing ────────────────────────────────────────────────────

export { findPidOnPort, isPidChrome }

// ─── Internal helpers ────────────────────────────────────────────────────────

async function cleanupFailedStart(agentId: string, webInstance: WebInstance): Promise<void> {
  try {
    await killByPort(webInstance.debugPort, webInstance.instanceId)
  } catch { /* best effort */ }

  try {
    updateWebInstance(webInstance.instanceId, { status: 'error' })
  } catch { /* may already be released or in incompatible state */ }

  try {
    releaseWebInstance(webInstance.instanceId)
  } catch { /* best effort */ }

  const record = agents.get(agentId)
  if (record) {
    record.instanceId = undefined
    record.saExtensionId = undefined
  }
}

/**
 * Project the internal agent record + WIR data into a public AgentState.
 * This is the ONLY place where AgentState is constructed — ensuring
 * consistency between the runner's knowledge and WIR's data.
 */
function projectAgentState(agentId: string): AgentState {
  const record = agents.get(agentId)
  if (!record) {
    return {
      agentId,
      platformId: '',
      status: 'stopped' as AgentLifecycleStatus,
      activeExecutions: 0,
      unknownExecutions: 0,
      createdAt: 0,
    }
  }

  let debugPort: number | undefined
  if (record.instanceId) {
    const instance = getWebInstance(record.instanceId)
    if (instance) {
      debugPort = instance.debugPort
    }
  }

  return {
    agentId,
    platformId: record.config.platformId,
    role: record.config.role,
    sessionMode: record.config.sessionMode ?? 'clean',
    masterSessionSourceId: record.config.masterSessionSourceId,
    instanceId: record.instanceId,
    saExtensionId: record.saExtensionId,
    status: record.status,
    debugPort,
    // Execution counts are populated by Sentinel, not by the runner.
    // The runner doesn't read ExecutionRegistry.
    activeExecutions: 0,
    unknownExecutions: 0,
    error: record.error,
    createdAt: record.createdAt,
  }
}
