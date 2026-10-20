/**
 * ExecutionRegistry — durable registry of tool executions inside the MV3
 * service worker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (architecture review, 2026-09-17)
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous implementation used `executionKey = instanceId ? `${instanceId}:${callId}` : callId`
 * as the primary identity. That produced four live defects:
 *
 *  1. CROSS-AGENT CONTAMINATION. `instanceId` was optional. Whenever it was
 *     absent — which is exactly what happens while the service worker is
 *     restarting, before CDP has re-stamped identity — every agent collapsed
 *     into one global keyspace indexed by the model's `callId`. Agent A's
 *     `call_1` and Agent B's `call_1` were literally the same record.
 *
 *  2. SILENT NO-OP EXECUTIONS. `createExecution` returned the existing record
 *     when it was non-terminal. Models reuse callIds constantly (`call_1`,
 *     `call_2`, …). The second distinct tool call at the same address was
 *     silently handed the FIRST call's execution and never ran, while the page
 *     was told it succeeded.
 *
 *  3. PERMANENTLY POISONED ADDRESSES. MV3 kills the worker every ~30s idle.
 *     Any execution left in `running` stayed `running` forever, and rule (2)
 *     meant that address could never execute again for the life of the profile.
 *
 *  4. STATE-MACHINE RACE. `transition()` did read → await → mutate → await
 *     persist. Two concurrent messages both read `running`, both passed the
 *     transition guard, and both wrote. The guard was decorative.
 *
 * The fix separates three concepts the old code conflated:
 *
 *   ADDRESS     `${scope}:${callId}` — a mailbox slot, derived from untrusted
 *               model output, MAY be re-pointed over time. Never identity.
 *   IDENTITY    `executionId` — minted here, opaque, stable across attempts.
 *   DEDUP       `idempotencyKey` — scope + tool + canonical args, valid only
 *               inside a TTL window. Never identity.
 *
 * The public API is unchanged: callers keep passing the address returned by
 * `executionKey()` and everything resolves through an address→identity index.
 */

import type { ExecutionStatus, WebExecution } from '../../../pages/content/src/types/messages';

const STORAGE_KEY = 'mcp:execution-registry:v2';
const LEGACY_STORAGE_KEY = 'mcp:execution-registry:v1';
const RESULT_PREFIX = 'mcp:execution-result:';

/** chrome.storage.local is quota-limited. Inline results WILL exhaust it, and a
 *  full quota bricks the entire registry, not just the oversized record. */
const MAX_INLINE_RESULT_BYTES = 8 * 1024;
const MAX_STORED_RESULT_BYTES = 4 * 1024 * 1024;

/** Retention. Terminal records beyond this are pruned oldest-first. */
const MAX_RETAINED_EXECUTIONS = 400;

/** A `running` record from a previous boot epoch is not known-dead; it is
 *  known-unobservable. We annotate, we do not reap. Reaping duplicates work. */
const STALE_RUNNING_MS = 5 * 60_000;

/** Dedup window. Outside it, an identical call is a legitimate re-run. */
const IDEMPOTENCY_WINDOW_MS = 30_000;

/** Boot epoch for this service-worker life. MV3 restarts constantly; without
 *  this we cannot distinguish "running now" from "running before the restart". */
const BOOT_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

const executions = new Map<string, WebExecution>(); // executionId -> record
const addressIndex = new Map<string, string>(); // address    -> executionId (live)
const listeners = new Set<(execution: WebExecution) => void>();

let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

/**
 * Durable identity stamped by the CLI via CDP into
 * chrome.storage.local['mcp:instance-identity'] (see ChromeCDP.stampInstanceIdentity).
 * Read once at hydrate() and kept live via storage.onChanged, because the CLI's
 * stamp lands AFTER launchChrome() starts this worker — there is no ordering
 * guarantee that identity exists yet the first time hydrate() runs.
 *
 * Preferred over whatever instanceId/agentId a caller passes into
 * createExecution(): those originate in a message payload from the content
 * script, which per design must never be the source of an agent's identity.
 * Falls back to the caller-supplied value only when no stamp exists yet (manual
 * / unmanaged mode, or the brief window before the CLI's stamp lands), so
 * behaviour for a profile the CLI never launched is unchanged.
 */
const INSTANCE_IDENTITY_KEY = 'mcp:instance-identity';
let STAMPED_IDENTITY: { instanceId?: string; agentId?: string; platformId?: string } = {};
let identityWatcherAttached = false;

function attachIdentityWatcher(): void {
  if (identityWatcherAttached) return;
  identityWatcherAttached = true;
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[INSTANCE_IDENTITY_KEY]) return;
      const next = changes[INSTANCE_IDENTITY_KEY].newValue;
      STAMPED_IDENTITY = next && typeof next === 'object' ? next : {};
      console.log('[ExecutionRegistry] instance identity updated:', STAMPED_IDENTITY);
    });
  } catch {
    /* storage.onChanged unavailable (e.g. test shim) — identity stays read-once */
  }
}

/** Read-only view of the identity stamped for this Service Worker, if any. */
export function getStampedIdentity(): Readonly<typeof STAMPED_IDENTITY> {
  return STAMPED_IDENTITY;
}

/** Serializes every mutation. Kills defect (4): the guard is now atomic with
 *  respect to the await boundaries, because nothing else can interleave. */
let mutationChain: Promise<unknown> = Promise.resolve();

export interface CreateExecutionInput {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  instanceId?: string;
  agentId?: string;
  platformId?: string;
  tabId?: number;
  contentSignature?: string;
  /** Explicit override of the unknown-outcome block. Human decision only. */
  force?: boolean;
  /** Side-effect class. Defaults to the safe end: unknown tools are treated as
   *  effectful, so we never auto-retry something we cannot reason about. */
  effectClass?: 'pure' | 'idempotent-keyed' | 'effectful';
}

// ─── Identity primitives ─────────────────────────────────────────────────────

function mintExecutionId(): string {
  try {
    return `exec-${crypto.randomUUID()}`;
  } catch {
    return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * Scope for an address. NEVER returns a globally shared value.
 *
 * When `instanceId` is missing we fall back to the boot epoch rather than to a
 * bare callId. A boot-scoped collision costs one wasted execution inside a
 * single worker life; a global collision delivers agent A's result to agent B.
 */
function resolveScope(instanceId?: string): string {
  return instanceId && instanceId.length > 0 ? instanceId : `boot:${BOOT_ID}`;
}

/**
 * Address for a call. Kept as the public handle for backward compatibility.
 *
 * NOTE: this is an address, not identity. Two different executions may occupy
 * this address at different times. Resolve it through the index; do not treat
 * it as a stable key for anything you intend to keep.
 */
export function executionKey(callId: string, instanceId?: string): string {
  return `${resolveScope(instanceId)}:${callId}`;
}

/** Stable stringify so `{a:1,b:2}` and `{b:2,a:1}` hash identically. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** FNV-1a. Sync on purpose: crypto.subtle is async and this sits on the hot path. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function computeIdempotencyKey(input: CreateExecutionInput): string {
  const scope = resolveScope(input.instanceId);
  return `${scope}::${input.toolName}::${fnv1a(canonicalize(input.args ?? {}))}`;
}

const isTerminal = (status: ExecutionStatus) =>
  status === 'success' || status === 'error' || status === 'cancelled';

const transitions: Record<ExecutionStatus, ExecutionStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['success', 'error', 'cancelled'],
  success: [],
  error: [],
  cancelled: [],
};

// ─── Persistence ─────────────────────────────────────────────────────────────

function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length * 2;
  }
}

/**
 * Offload oversized results. The record keeps a bounded projection plus a ref;
 * the full payload lives under its own storage key so one large result cannot
 * blow the quota for every other execution.
 */
async function storeResult(
  execution: WebExecution,
  result: unknown,
): Promise<void> {
  let serialized: string;
  try {
    serialized = typeof result === 'string' ? result : JSON.stringify(result) ?? 'null';
  } catch {
    serialized = String(result);
  }

  const bytes = byteLength(serialized);
  execution.resultBytes = bytes;

  if (bytes <= MAX_INLINE_RESULT_BYTES) {
    execution.result = result;
    execution.resultTruncated = false;
    delete execution.resultRef;
    return;
  }

  const ref = `${RESULT_PREFIX}${execution.executionId}`;
  const storable = bytes <= MAX_STORED_RESULT_BYTES;

  if (storable) {
    try {
      await chrome.storage.local.set({ [ref]: serialized });
      execution.resultRef = ref;
    } catch (error) {
      console.error('[ExecutionRegistry] Failed to store result blob:', error);
    }
  }

  execution.result = `${serialized.slice(0, MAX_INLINE_RESULT_BYTES)}\n\n[truncated: ${bytes} bytes total${
    execution.resultRef ? `, full payload at ${execution.resultRef}` : ', payload too large to retain'
  }]`;
  execution.resultTruncated = true;
}

export async function readFullResult(keyOrId: string): Promise<string | null> {
  await hydrate();
  const execution = resolve(keyOrId);
  if (!execution) return null;
  if (!execution.resultRef) {
    return typeof execution.result === 'string'
      ? execution.result
      : JSON.stringify(execution.result ?? null);
  }
  try {
    const stored = await chrome.storage.local.get(execution.resultRef);
    return (stored[execution.resultRef] as string) ?? null;
  } catch (error) {
    console.error('[ExecutionRegistry] Failed to read result blob:', error);
    return null;
  }
}

async function pruneRetention(): Promise<void> {
  const excess = executions.size - MAX_RETAINED_EXECUTIONS;
  if (excess <= 0) return;

  // Oldest-first across BOTH pools. Terminal records go first because they are
  // finished; if that is not enough to reach the cap we continue into
  // non-terminal records, which are otherwise never reclaimed and let the map
  // grow without bound (observed: 405 retained with a cap of 400).
  const byAge = (a: WebExecution, b: WebExecution) =>
    (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt);

  const terminal = Array.from(executions.values()).filter(e => isTerminal(e.status)).sort(byAge);
  const nonTerminal = Array.from(executions.values()).filter(e => !isTerminal(e.status)).sort(byAge);

  const doomed = terminal.slice(0, excess);
  if (doomed.length < excess) {
    // Never evict an unacknowledged unknown outcome: that record is the only
    // thing standing between the user and a duplicated side effect.
    const spillover = nonTerminal.filter(e => !(e.unknownOutcome && !e.unknownAcknowledgedAt));
    doomed.push(...spillover.slice(0, excess - doomed.length));
  }

  const refs: string[] = [];

  for (const execution of doomed) {
    executions.delete(execution.executionId!);
    if (addressIndex.get(execution.executionKey) === execution.executionId) {
      addressIndex.delete(execution.executionKey);
    }
    if (execution.resultRef) refs.push(execution.resultRef);
  }

  if (refs.length > 0) {
    try {
      await chrome.storage.local.remove(refs);
    } catch (error) {
      console.error('[ExecutionRegistry] Failed to prune result blobs:', error);
    }
  }
}

async function persist(): Promise<void> {
  try {
    await pruneRetention();
    await chrome.storage.local.set({
      [STORAGE_KEY]: Array.from(executions.values()),
    });
  } catch (error) {
    // Quota exhaustion is the realistic failure. Shed terminal records and
    // retry once rather than losing the live ones.
    console.error('[ExecutionRegistry] Failed to persist:', error);
    try {
      // Shed PAYLOAD, never RECORDS.
      //
      // The previous recovery branch persisted only non-terminal records, so a
      // confirmed success and its result vanished from storage while an
      // unfinished execution survived — exactly backwards. A terminal record is
      // the answer the user is waiting for; a non-terminal one may already
      // have side effects and must never be reconstructed by re-running.
      // Compact only stored projections with a full-result reference while
      // preserving every record's identity and status.
      // Compact storage snapshots only. Never replace the live response that
      // callers and execution-update subscribers are about to receive.
      const all = Array.from(executions.values(), execution => ({ ...execution }));
      const sheddable = all
        .filter(e => isTerminal(e.status) && e.resultTruncated && e.resultRef)
        .sort((a, b) => (a.completedAt ?? a.createdAt) - (b.completedAt ?? b.createdAt));

      for (const execution of sheddable) {
        execution.result = `[evicted: storage quota${execution.resultRef ? `, full payload at ${execution.resultRef}` : ''}]`;
      }

      await chrome.storage.local.set({ [STORAGE_KEY]: all });
    } catch (retryError) {
      console.error('[ExecutionRegistry] Persist retry failed:', retryError);
      // Keep the previous persisted snapshot and every live record. Pending
      // work must remain discoverable; a storage failure is not cancellation
      // and does not make it safe to repeat an execution.
      // This save failed: the latest revisions are still only in memory.
    }
  }
}

// ─── Hydration & boot reconciliation ─────────────────────────────────────────

function adoptRecord(value: WebExecution): void {
  if (!value.executionId) value.executionId = mintExecutionId();
  if (typeof value.attempt !== 'number') value.attempt = 1;
  if (typeof value.revision !== 'number') value.revision = 0;
  executions.set(value.executionId, value);
}

/**
 * Reconcile, do not reap.
 *
 * A `running` record from a previous boot may still be executing in a page we
 * can no longer observe. Marking it failed and retrying is how you duplicate a
 * `git push`. We annotate liveness, free the ADDRESS so the agent is not
 * deadlocked, and keep the record intact under its own identity.
 *
 * Effectful executions additionally get `unknownOutcome`, which callers must
 * escalate rather than silently retry.
 */
function reconcileBoot(): void {
  const now = Date.now();

  for (const execution of executions.values()) {
    const fromPreviousBoot = execution.bootId !== BOOT_ID;
    const stale = now - (execution.startedAt ?? execution.createdAt) > STALE_RUNNING_MS;

    if (execution.status !== 'running' && execution.status !== 'queued') continue;
    if (!fromPreviousBoot && !stale) continue;

    execution.livenessUnknown = true;
    if (execution.effectClass === 'effectful') {
      execution.unknownOutcome = true;
      console.warn(
        `[ExecutionRegistry] Effectful execution ${execution.executionId} (${execution.functionName}) ` +
          'was interrupted. Outcome UNKNOWN — will not be auto-retried.',
      );
    }

    // Free the address. The record survives; the mailbox slot does not.
    if (addressIndex.get(execution.executionKey) === execution.executionId) {
      addressIndex.delete(execution.executionKey);
    }
  }
}

async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, INSTANCE_IDENTITY_KEY]);
      const values = stored[STORAGE_KEY] ?? stored[LEGACY_STORAGE_KEY];
      const identity = stored[INSTANCE_IDENTITY_KEY];
      if (identity && typeof identity === 'object') {
        STAMPED_IDENTITY = identity as typeof STAMPED_IDENTITY;
        console.log('[ExecutionRegistry] hydrated stamped identity:', STAMPED_IDENTITY);
      }
      attachIdentityWatcher();

      if (Array.isArray(values)) {
        for (const value of values) {
          if (!value || typeof value !== 'object') continue;
          if (typeof value.executionKey !== 'string') continue;
          if (typeof value.callId !== 'string') continue;
          if (typeof value.functionName !== 'string') continue;
          if (typeof value.status !== 'string') continue;
          adoptRecord(value as WebExecution);
        }
      }

      // Rebuild the address index newest-first so the live record wins.
      //
      // Terminal records are indexed TOO (invariant 14). Skipping them meant
      // that after every MV3 restart `getExecution(address)` returned null for
      // a finished execution, so the content script — which only ever held the
      // address — could never recover a result it had already produced. Live
      // records still take precedence: they are indexed first, and a terminal
      // record only fills an address nobody live occupies.
      const ordered = Array.from(executions.values()).sort((a, b) => b.createdAt - a.createdAt);
      for (const execution of ordered) {
        if (isTerminal(execution.status)) continue;
        if (!addressIndex.has(execution.executionKey)) {
          addressIndex.set(execution.executionKey, execution.executionId!);
        }
      }
      for (const execution of ordered) {
        if (!isTerminal(execution.status)) continue;
        if (!addressIndex.has(execution.executionKey)) {
          addressIndex.set(execution.executionKey, execution.executionId!);
        }
      }

      reconcileBoot();
    } catch (error) {
      console.error('[ExecutionRegistry] Failed to hydrate:', error);
    } finally {
      hydrated = true;
      hydrationPromise = null;
    }
  })();

  return hydrationPromise;
}

function emit(execution: WebExecution): void {
  for (const listener of listeners) {
    try {
      listener(execution);
    } catch (error) {
      console.error('[ExecutionRegistry] Listener failed:', error);
    }
  }
}

/**
 * DISCOVERY ONLY. Accepts an address or a raw executionId.
 *
 * Never use this to resolve the target of a MUTATION. An address may be
 * re-pointed at a different execution while the first is still in flight, so
 * mutating through it delivers A's outcome to B. Mutations go through
 * `resolveById` below, which cannot alias.
 */
function resolve(keyOrId: string): WebExecution | undefined {
  const direct = executions.get(keyOrId);
  if (direct) return direct;
  const mapped = addressIndex.get(keyOrId);
  return mapped ? executions.get(mapped) : undefined;
}

/** MUTATION ONLY. Identity, never address. Invariant 2/5. */
function resolveById(executionId: string): WebExecution | undefined {
  return executions.get(executionId);
}

/** Every mutation runs through here, serialized. */
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(work, work);
  mutationChain = next.catch(() => undefined);
  return next;
}

// ─── Transitions ─────────────────────────────────────────────────────────────

async function transition(
  executionId: string,
  status: ExecutionStatus,
  result?: unknown,
  error?: string,
): Promise<WebExecution> {
  await hydrate();

  return serialize(async () => {
    // Identity only. Passing an address here used to let a finished execution
    // write its result into whatever record currently occupied its mailbox.
    const execution = resolveById(executionId);
    if (!execution) {
      if (addressIndex.has(executionId)) {
        throw new Error(
          `Refusing to mutate through an address: "${executionId}". ` +
            'Pass execution.executionId. (invariant 2)',
        );
      }
      throw new Error(`Unknown execution: ${executionId}`);
    }

    if (!transitions[execution.status].includes(status)) {
      throw new Error(
        `Invalid execution transition: ${execution.status} -> ${status} (${execution.executionId})`,
      );
    }

    execution.status = status;
    execution.revision = (execution.revision ?? 0) + 1;

    if (status === 'running') {
      execution.startedAt = execution.startedAt ?? Date.now();
      execution.bootId = BOOT_ID;
      execution.livenessUnknown = false;
    }

    if (isTerminal(status)) {
      execution.completedAt = Date.now();
      execution.livenessUnknown = false;
      // NOTE (corrección forense): este bloque antes borraba la dirección del
      // addressIndex al llegar a un estado terminal, razonando que así un
      // callId reutilizado con contenido distinto no heredaría un resultado
      // viejo (fix de C4). Pero background/index.ts expone 'mcp:get-execution' y
      // 'mcp:resume-execution', y content/.../storage.ts implementa
      // storeExecutionKeyMapping/getExecutionKeyMapping explícitamente "for
      // post-refresh recovery": el content script necesita resolver la
      // executionKey DESPUÉS de que la ejecución ya terminó (para leer su
      // resultado tras un refresco de página). Borrar la dirección aquí rompe
      // esa recuperación para toda ejecución que ya haya llegado a un estado
      // terminal. La protección de C4 no depende de este borrado eager: ya la
      // da createExecution() más abajo, que ignora un 'live' terminal en el
      // índice y simplemente lo reemplaza por una ejecución nueva cuando llega
      // contenido distinto en la misma dirección. La dirección de una
      // ejecución terminal se mantiene resoluble hasta que ese reemplazo
      // ocurra o hasta que la retención la purgue.
    }

    if (status === 'success') {
      await storeResult(execution, result);
      delete execution.error;
      execution.unknownOutcome = false;
    }

    if (status === 'error' || status === 'cancelled') {
      execution.error = error ?? 'Execution cancelled';
      delete execution.result;
      // Cancelling an effectful execution does NOT mean it did not happen.
      if (status === 'cancelled' && execution.effectClass === 'effectful' && execution.startedAt) {
        execution.unknownOutcome = true;
      }
    }

    await persist();
    emit(execution);
    return execution;
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function initializeExecutionRegistry(): Promise<void> {
  await hydrate();
}

/** Boot epoch of this service-worker life. Exposed for diagnostics. */
export function getBootId(): string {
  return BOOT_ID;
}

export interface CreateExecutionResult {
  execution: WebExecution;
  /**
   * True when this call did NOT create anything: it matched a live execution
   * with identical content inside the dedup window. The caller MUST NOT start
   * a second worker for a coalesced result. Invariant 8.
   */
  coalesced: boolean;
  /** Set when creation was refused because the address holds an unknown outcome. */
  blockedByUnknownOutcome?: WebExecution;
}

export async function createExecution(input: CreateExecutionInput): Promise<CreateExecutionResult> {
  await hydrate();

  return serialize(async () => {
    // Preferir SIEMPRE la identidad estampada por el CLI vía CDP sobre lo que
    // venga en el payload del mensaje (que se origina en el content script, y
    // que por diseño nunca debe ser la fuente de la identidad de un agente).
    // Cae al valor del input solo cuando aun no existe ningun sello — modo
    // manual/unmanaged, o la breve ventana antes de que el CLI complete el
    // stamp — preservando el comportamiento actual para perfiles que el CLI
    // nunca lanzó.
    const effectiveInstanceId = STAMPED_IDENTITY.instanceId ?? input.instanceId;
    const effectiveAgentId = STAMPED_IDENTITY.agentId ?? input.agentId;
    const effectivePlatformId = input.platformId ?? STAMPED_IDENTITY.platformId;

    const address = executionKey(input.callId, effectiveInstanceId);
    const idempotencyKey = computeIdempotencyKey({ ...input, instanceId: effectiveInstanceId });
    const effectClass = input.effectClass ?? 'effectful';
    const now = Date.now();

    const liveId = addressIndex.get(address);
    const live = liveId ? executions.get(liveId) : undefined;

    if (live && !isTerminal(live.status)) {
      // Same address AND same content inside the dedup window => genuine
      // duplicate delivery of one call. Coalesce.
      const sameContent = live.idempotencyKey === idempotencyKey;
      const withinWindow = now - live.createdAt < IDEMPOTENCY_WINDOW_MS;

      if (sameContent && withinWindow) return { execution: live, coalesced: true };

      // Same address, DIFFERENT content: the model reused its callId for a new
      // tool call. The old behaviour returned the stale record and never ran
      // this one. Detach the old execution and mint a fresh identity.
      console.warn(
        `[ExecutionRegistry] callId "${input.callId}" reused at ${address} with different content. ` +
          `Detaching ${live.executionId} and creating a new execution.`,
      );
      live.livenessUnknown = true;
      if (live.effectClass === 'effectful') {
        live.unknownOutcome = true;
        live.unknownReason = 'detached: callId reused with different content';
      }
      addressIndex.delete(address);
    }

    // Invariant 12: an effectful execution whose outcome we never observed
    // blocks this address. Re-running is exactly how a `git push` happens
    // twice. Requires an explicit human decision (acknowledgeUnknownOutcome)
    // or `force`.
    if (!input.force) {
      const pendingUnknown = Array.from(executions.values()).find(
        e =>
          e.executionKey === address &&
          e.unknownOutcome === true &&
          e.effectClass === 'effectful' &&
          !e.unknownAcknowledgedAt,
      );
      if (pendingUnknown) {
        console.warn(
          `[ExecutionRegistry] Refusing to create at ${address}: execution ` +
            `${pendingUnknown.executionId} (${pendingUnknown.functionName}) has an UNKNOWN outcome. ` +
            'Acknowledge it or pass force:true.',
        );
        return {
          execution: pendingUnknown,
          coalesced: false,
          blockedByUnknownOutcome: pendingUnknown,
        };
      }
    }

    const execution: WebExecution = {
      executionKey: address,
      executionId: mintExecutionId(),
      bootId: BOOT_ID,
      attempt: 1,
      revision: 0,
      idempotencyKey,
      effectClass,
      callId: input.callId,
      instanceId: effectiveInstanceId,
      agentId: effectiveAgentId,
      platformId: effectivePlatformId,
      tabId: input.tabId,
      functionName: input.toolName,
      params: input.args,
      contentSignature: input.contentSignature,
      status: 'queued',
      createdAt: now,
    };

    executions.set(execution.executionId!, execution);
    addressIndex.set(address, execution.executionId!);

    await persist();
    emit(execution);
    return { execution, coalesced: false };
  });
}

/**
 * Whether a new attempt is safe WITHOUT a human/orchestrator decision.
 * A timeout is not evidence that a side effect did not land.
 */
export function canAutoRetry(execution: WebExecution): boolean {
  if (execution.unknownOutcome) return false;
  if (execution.effectClass === 'effectful') return false;
  return true;
}

export const markRunning = (executionId: string) => transition(executionId, 'running');
export const completeExecution = (executionId: string, result: unknown) =>
  transition(executionId, 'success', result);
export const failExecution = (executionId: string, error: unknown) =>
  transition(executionId, 'error', undefined, error instanceof Error ? error.message : String(error));
export const cancelExecution = (executionId: string, reason?: string) =>
  transition(executionId, 'cancelled', undefined, reason);

/**
 * Terminal state for an outcome we could not observe.
 *
 * A transport timeout or an exhausted poll is NOT a confirmed failure. Routing
 * those through `failExecution` is what produced "Retry Execution" on a tool
 * that had actually succeeded. Invariants 10/11/13.
 */
export const markUnknownOutcome = async (executionId: string, reason: string): Promise<WebExecution> => {
  await hydrate();
  return serialize(async () => {
    const execution = resolveById(executionId);
    if (!execution) throw new Error(`Unknown execution: ${executionId}`);
    execution.livenessUnknown = true;
    execution.unknownOutcome = true;
    execution.unknownReason = reason;
    execution.revision = (execution.revision ?? 0) + 1;
    if (addressIndex.get(execution.executionKey) === execution.executionId) {
      addressIndex.delete(execution.executionKey);
    }
    await persist();
    emit(execution);
    return execution;
  });
};

/**
 * Explicit human decision to clear an unknown outcome so the address can be
 * used again. Invariant 13: there must be a route out, and it must be taken
 * deliberately rather than by an automatic retry.
 */
export async function acknowledgeUnknownOutcome(executionId: string): Promise<WebExecution | null> {
  await hydrate();
  return serialize(async () => {
    const execution = resolveById(executionId);
    if (!execution) return null;
    execution.unknownOutcome = false;
    execution.unknownAcknowledgedAt = Date.now();
    execution.revision = (execution.revision ?? 0) + 1;
    await persist();
    emit(execution);
    return execution;
  });
}

export async function getExecution(key: string): Promise<WebExecution | null> {
  await hydrate();
  return resolve(key) ?? null;
}

export async function attachExecutionTab(key: string, tabId: number): Promise<WebExecution | null> {
  await hydrate();
  return serialize(async () => {
    const execution = resolve(key);
    if (!execution) return null;
    if (execution.tabId !== tabId) {
      execution.tabId = tabId;
      execution.revision = (execution.revision ?? 0) + 1;
      await persist();
    }
    return execution;
  });
}

export async function listExecutions(): Promise<WebExecution[]> {
  await hydrate();
  return Array.from(executions.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Executions needing escalation: interrupted with a side effect of unknown status. */
export async function listUnknownOutcomes(): Promise<WebExecution[]> {
  await hydrate();
  return Array.from(executions.values()).filter(e => e.unknownOutcome === true);
}

export function subscribe(listener: (execution: WebExecution) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
