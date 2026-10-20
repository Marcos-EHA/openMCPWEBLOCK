/**
 * WebInstanceRegistry — tracks Chrome instances backing web agents.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (architecture review, 2026-09-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous `nextDebugPort()` allocated from an in-process `Set`:
 *
 *     let port = 9222
 *     while (reservedPorts.has(port)) port += 1
 *
 * That set lives in RAM and dies with the process. The failure is concrete and
 * routine, not hypothetical:
 *
 *   1. Run the CLI. Agent A gets port 9222 and launches Chrome.
 *   2. Restart the CLI (crash, reload, Ctrl-C). `reservedPorts` is now empty.
 *   3. Agent B asks for a port. It gets 9222 — while agent A's Chrome is still
 *      alive and listening there.
 *   4. CDP attaches to agent A's browser. Agent B's prompts are typed into
 *      agent A's ChatGPT conversation, and agent A's replies are read back as
 *      agent B's results.
 *
 * `releaseWebInstance()` made it worse by returning the port to the pool
 * immediately, so the same collision could happen inside a single run.
 *
 * Fixes here:
 *   - Port ownership is a LOCK FILE on disk, not a Set in memory. It survives
 *     restarts and is visible to every process on the machine.
 *   - Stale locks are reclaimed only after verifying the owning PID is dead.
 *   - Instance identity must be verified after connecting (`verifyInstanceIdentity`)
 *     before any command is issued. A port is a transport, never an identity.
 *   - agent→instance binding is an append-only LEASE with history, not a
 *     mutable field, so pooling stays possible and observability questions
 *     ("which Chrome had agent 7 at 14:32?") remain answerable.
 *   - Status changes are validated against a state machine instead of a blind
 *     Object.assign.
 */

import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export type WebInstanceStatus = 'created' | 'starting' | 'ready' | 'busy' | 'stopped' | 'error'

export interface WebInstance {
  instanceId: string
  agentId?: string
  platformId: string
  debugPort: number
  profileDir: string
  tabId?: string
  status: WebInstanceStatus
  /** Boot epoch that allocated this instance. */
  bootId: string
  /** Absolute path of the lock file asserting ownership of `debugPort`. */
  portLockPath: string
  createdAt: number
}

export interface InstanceLease {
  agentId: string
  instanceId: string
  startedAt: number
  endedAt?: number
  reason?: string
}

const BASE_DEBUG_PORT = 9222
const MAX_DEBUG_PORT = 9322
const LOCK_DIR = join(tmpdir(), 'openmcpweblock', 'ports')

const BOOT_ID = randomUUID()

const instances = new Map<string, WebInstance>()
const agentToInstance = new Map<string, string>()
/** Append-only lease history. Current binding is a projection of this. */
const leaseHistory: InstanceLease[] = []

const VALID_TRANSITIONS: Record<WebInstanceStatus, WebInstanceStatus[]> = {
  created: ['starting', 'error', 'stopped'],
  starting: ['ready', 'error', 'stopped'],
  ready: ['busy', 'stopped', 'error'],
  busy: ['ready', 'stopped', 'error'],
  stopped: ['starting'],
  error: ['starting', 'stopped'],
}

export function getManagedDebugPortRange(): { min: number; max: number } {
  return { min: BASE_DEBUG_PORT, max: MAX_DEBUG_PORT }
}

// ─── Port ownership via on-disk locks ────────────────────────────────────────

interface PortLock {
  port: number
  instanceId: string
  pid: number
  bootId: string
  claimedAt: number
}

function ensureLockDir(): void {
  try {
    mkdirSync(LOCK_DIR, { recursive: true })
  } catch {
    /* best effort */
  }
}

function lockPath(port: number): string {
  return join(LOCK_DIR, `${port}.lock.json`)
}

/** True when the PID in a lock is no longer running. */
function isProcessDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (pid === process.pid) return false
  try {
    // Signal 0 performs an existence/permission check without delivering.
    process.kill(pid, 0)
    return false
  } catch (err: any) {
    // EPERM means it exists but we may not signal it — still alive.
    return err?.code !== 'EPERM'
  }
}

function readLock(port: number): PortLock | null {
  const path = lockPath(port)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PortLock
    if (typeof parsed?.port !== 'number' || typeof parsed?.pid !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function claimLock(port: number, instanceId: string): boolean {
  ensureLockDir()
  const existing = readLock(port)

  if (existing) {
    const ownedByUs = existing.bootId === BOOT_ID
    const stale = isProcessDead(existing.pid)
    if (!stale && !ownedByUs) return false
    if (!stale && ownedByUs && existing.instanceId !== instanceId) return false
  }

  const lock: PortLock = {
    port,
    instanceId,
    pid: process.pid,
    bootId: BOOT_ID,
    claimedAt: Date.now(),
  }

  try {
    writeFileSync(lockPath(port), JSON.stringify(lock), { encoding: 'utf8', flag: 'w' })
    // Re-read to catch a concurrent writer that won the race.
    const confirmed = readLock(port)
    return confirmed?.instanceId === instanceId && confirmed?.pid === process.pid
  } catch {
    return false
  }
}

function releaseLock(port: number, instanceId: string): void {
  const existing = readLock(port)
  if (!existing) return
  if (existing.instanceId !== instanceId) return
  try {
    rmSync(lockPath(port), { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Allocate a debug port that no live process owns.
 *
 * NOTE: this proves nobody *we know about* owns the port. It does not prove the
 * port is free at the TCP level — an unrelated process may be listening. That
 * is why `verifyInstanceIdentity()` below is mandatory before issuing commands.
 */
function allocateDebugPort(
  instanceId: string,
  excludedPorts: ReadonlySet<number> = new Set(),
): { port: number; lockPath: string } {
  for (let port = BASE_DEBUG_PORT; port <= MAX_DEBUG_PORT; port++) {
    if (excludedPorts.has(port)) continue
    const inMemory = Array.from(instances.values()).some(i => i.debugPort === port)
    if (inMemory) continue
    if (claimLock(port, instanceId)) {
      return { port, lockPath: lockPath(port) }
    }
  }
  throw new Error(
    `No free debug port in range ${BASE_DEBUG_PORT}-${MAX_DEBUG_PORT}. ` +
      `Stale locks live in ${LOCK_DIR}; remove them only if the owning Chrome is gone.`,
  )
}

/** Remove locks whose owning process is dead. Safe to call at startup. */
export function reclaimStalePortLocks(): number {
  ensureLockDir()
  let reclaimed = 0
  let entries: string[] = []
  try {
    entries = readdirSync(LOCK_DIR)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock.json')) continue
    const port = Number.parseInt(entry, 10)
    if (!Number.isFinite(port)) continue
    const lock = readLock(port)
    if (lock && isProcessDead(lock.pid)) {
      try {
        rmSync(lockPath(port), { force: true })
        reclaimed++
      } catch {
        /* best effort */
      }
    }
  }
  return reclaimed
}

// ─── Identity verification ───────────────────────────────────────────────────

/**
 * Verify that the browser answering on `debugPort` is the one we launched.
 *
 * MUST be called after connecting and BEFORE issuing any command. Skipping this
 * is what turns a recycled port into a cross-agent contamination incident.
 *
 * `readStampedIdentity` should read chrome.storage.local['mcp:instance-identity']
 * over CDP. Returning null (not yet stamped) fails closed.
 */
export async function verifyInstanceIdentity(
  instanceId: string,
  readStampedIdentity: () => Promise<{ instanceId?: string; bootId?: string } | null>,
): Promise<boolean> {
  const instance = instances.get(instanceId)
  if (!instance) return false

  let stamped: { instanceId?: string; bootId?: string } | null = null
  try {
    stamped = await readStampedIdentity()
  } catch {
    return false
  }

  if (!stamped || !stamped.instanceId) {
    console.error(
      `[WebInstanceRegistry] Port ${instance.debugPort} answered but carries no identity stamp. ` +
        'Refusing to issue commands (fail-closed).',
    )
    return false
  }

  if (stamped.instanceId !== instanceId) {
    console.error(
      `[WebInstanceRegistry] IDENTITY MISMATCH on port ${instance.debugPort}: ` +
        `expected ${instanceId}, found ${stamped.instanceId}. Port was recycled by another browser.`,
    )
    updateWebInstance(instanceId, { status: 'error' })
    return false
  }

  return true
}

// ─── Instance lifecycle ──────────────────────────────────────────────────────

export function createWebInstance(
  platformId: string,
  agentId?: string,
  options?: { excludedDebugPorts?: ReadonlySet<number> },
): WebInstance {
  if (agentId) {
    const existingId = agentToInstance.get(agentId)
    if (existingId) {
      const existing = instances.get(existingId)
      // Only reuse when the platform matches. Reusing across platforms silently
      // pointed an agent at the wrong site.
      if (existing && existing.platformId === platformId && existing.status !== 'stopped') {
        return existing
      }
    }
  }

  const instanceId = `web-${randomUUID()}`
  const { port, lockPath: portLockPath } = allocateDebugPort(
    instanceId,
    options?.excludedDebugPorts,
  )

  const instance: WebInstance = {
    instanceId,
    agentId,
    platformId,
    debugPort: port,
    profileDir: instanceId,
    status: 'created',
    bootId: BOOT_ID,
    portLockPath,
    createdAt: Date.now(),
  }

  instances.set(instanceId, instance)
  if (agentId) {
    agentToInstance.set(agentId, instanceId)
    leaseHistory.push({ agentId, instanceId, startedAt: Date.now() })
  }
  return instance
}

/** Register an already-running browser after its SA identity has been verified by the caller. */
export function adoptWebInstance(
  instanceId: string,
  agentId: string,
  platformId: string,
  debugPort: number,
  profileDir: string,
): WebInstance {
  if (instances.has(instanceId)) {
    throw new Error(`Web instance ${instanceId} is already registered in this process.`)
  }
  if (agentToInstance.has(agentId)) {
    throw new Error(`Agent ${agentId} is already bound to a web instance in this process.`)
  }
  if (!claimLock(debugPort, instanceId)) {
    throw new Error(
      `Port ${debugPort} is owned by another live OpenMCPWEBLOCK process; refusing to attach concurrently.`,
    )
  }

  const instance: WebInstance = {
    instanceId,
    agentId,
    platformId,
    debugPort,
    profileDir,
    status: 'starting',
    bootId: BOOT_ID,
    portLockPath: lockPath(debugPort),
    createdAt: Date.now(),
  }
  instances.set(instanceId, instance)
  agentToInstance.set(agentId, instanceId)
  leaseHistory.push({ agentId, instanceId, startedAt: Date.now() })
  return instance
}

export function getWebInstance(instanceId: string): WebInstance | undefined {
  return instances.get(instanceId)
}

export function getWebInstanceForAgent(agentId: string): WebInstance | undefined {
  const instanceId = agentToInstance.get(agentId)
  return instanceId ? instances.get(instanceId) : undefined
}

export function bindWebInstanceToAgent(instanceId: string, agentId: string): WebInstance {
  const instance = instances.get(instanceId)
  if (!instance) throw new Error(`Unknown web instance: ${instanceId}`)

  const previousId = agentToInstance.get(agentId)
  if (previousId && previousId !== instanceId) {
    const previous = instances.get(previousId)
    if (previous) {
      previous.agentId = undefined
      // The old instance is now unreachable by agent lookup but still holds a
      // port and a live Chrome. Previously it leaked silently.
      console.warn(
        `[WebInstanceRegistry] Agent ${agentId} rebound from ${previousId} to ${instanceId}. ` +
          `Instance ${previousId} is now unowned on port ${previous.debugPort} — release it.`,
      )
    }
    const open = leaseHistory.find(l => l.agentId === agentId && l.instanceId === previousId && !l.endedAt)
    if (open) {
      open.endedAt = Date.now()
      open.reason = 'rebound'
    }
  }

  instance.agentId = agentId
  agentToInstance.set(agentId, instanceId)
  if (!leaseHistory.some(l => l.agentId === agentId && l.instanceId === instanceId && !l.endedAt)) {
    leaseHistory.push({ agentId, instanceId, startedAt: Date.now() })
  }
  return instance
}

export function updateWebInstance(
  instanceId: string,
  patch: Partial<Omit<WebInstance, 'instanceId' | 'debugPort' | 'bootId' | 'portLockPath'>>,
): WebInstance {
  const instance = instances.get(instanceId)
  if (!instance) throw new Error(`Unknown web instance: ${instanceId}`)

  if (patch.status && patch.status !== instance.status) {
    const allowed = VALID_TRANSITIONS[instance.status]
    if (!allowed.includes(patch.status)) {
      throw new Error(
        `Invalid instance transition: ${instance.status} -> ${patch.status} (${instanceId})`,
      )
    }
  }

  Object.assign(instance, patch)
  return instance
}

export function releaseWebInstance(instanceId: string): void {
  const instance = instances.get(instanceId)
  if (!instance) return

  if (instance.agentId && agentToInstance.get(instance.agentId) === instanceId) {
    agentToInstance.delete(instance.agentId)
    const open = leaseHistory.find(
      l => l.agentId === instance.agentId && l.instanceId === instanceId && !l.endedAt,
    )
    if (open) {
      open.endedAt = Date.now()
      open.reason = 'released'
    }
  }

  releaseLock(instance.debugPort, instanceId)
  instances.delete(instanceId)
}

export function listWebInstances(): WebInstance[] {
  return Array.from(instances.values())
}

/** Full binding history. Answers "which Chrome had agent X at time T?". */
export function listInstanceLeases(agentId?: string): InstanceLease[] {
  return agentId ? leaseHistory.filter(l => l.agentId === agentId) : [...leaseHistory]
}

export function getRegistryBootId(): string {
  return BOOT_ID
}

export function resetWebInstanceRegistry(): void {
  for (const instance of instances.values()) {
    releaseLock(instance.debugPort, instance.instanceId)
  }
  instances.clear()
  agentToInstance.clear()
  leaseHistory.length = 0
}
