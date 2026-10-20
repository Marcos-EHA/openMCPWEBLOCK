/**
 * Storage functionality for executed functions
 * This module provides utilities to store and retrieve information about executed functions
 * Implements canonical LogicalCallKey, Web Locks cross-tab atomic claims, and isolated scopes.
 */

import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('MCPStorage');

export type ExecutionStatus = 'running' | 'success' | 'error' | 'cancelled' | 'unknown';

export interface ExecutionClaim {
  logicalCallKey: string;
  scopeKey: string;
  functionName: string;
  callId: string;
  contentSignature: string;
  status: ExecutionStatus;
  timestamp: number;
  params?: Record<string, any>;
  result?: unknown;
  errorMessage?: string;
  /** ADDRESS. Discovery only; may point at a different execution over time. */
  executionKey?: string;
  /** IDENTITY. Stable handle for this execution; persist and resolve by this. */
  executionId?: string;
}

export interface ClaimResult {
  granted: boolean;
  reason?: 'already_claimed' | 'already_terminal' | 'locks_unavailable' | 'claim_conflict';
  claim?: ExecutionClaim;
}

export interface ExecutedFunction {
  functionName: string;
  callId: string;
  contentSignature: string;
  executedAt: number;
  params: Record<string, any>;
  status?: ExecutionStatus;
  errorMessage?: string;
}

interface URLBasedFunctionHistory {
  [url: string]: Record<string, ExecutedFunction>;
}

// Storage keys
const STORAGE_KEY = 'mcp_url_based_function_history';
const CLAIMS_STORAGE_KEY = 'openmcp_execution_claims_v2';
const TAB_SESSION_STORAGE_KEY = 'openmcp_tab_session_id';

// ---------------------------------------------------------------------------
// Scope and Identity primitives
// ---------------------------------------------------------------------------

/**
 * Returns a stable tab session identifier stored in sessionStorage.
 * Survives in-page navigations for this specific tab, never shared across tabs.
 */
export const getTabSessionId = (): string => {
  try {
    let sessionId = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!sessionId) {
      sessionId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, sessionId);
    }
    return sessionId;
  } catch {
    return 'tab-fallback';
  }
};

// ---------------------------------------------------------------------------
// Platform scope resolution
// ---------------------------------------------------------------------------

/**
 * Conversation-id extractors, one per platform we can actually verify.
 *
 * The previous implementation matched `/c/<id>` against ANY hostname and
 * labelled the result `chatgpt:c:` — so a Gemini or Perplexity conversation
 * either collided with a ChatGPT scope or, far more often, fell through to a
 * tab-scoped draft that died with the tab. Every claim outside ChatGPT was
 * effectively unscoped.
 *
 * `platformId` comes from the adapter hostnames declared in
 * `plugins/adapters/*.adapter.ts`. A platform with no verified conversation-id
 * shape gets `conversation: null` and degrades EXPLICITLY to draft scope —
 * we never fabricate a conversation id we cannot confirm is stable.
 */
interface PlatformScopeRule {
  platformId: string;
  matches: (hostname: string) => boolean;
  /** Returns a stable conversation id, or null when this URL has none. */
  conversation: ((pathname: string, search: string) => string | null) | null;
}

const PLATFORM_SCOPE_RULES: PlatformScopeRule[] = [
  {
    platformId: 'chatgpt',
    matches: h => h.includes('chatgpt.com') || h.includes('chat.openai.com'),
    conversation: p => p.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'gemini',
    matches: h => h.includes('gemini.google.com'),
    conversation: p => p.match(/\/app\/([a-zA-Z0-9_-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'aistudio',
    matches: h => h.includes('aistudio.google.com'),
    conversation: p => p.match(/\/prompts\/([a-zA-Z0-9_-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'deepseek',
    matches: h => h.includes('chat.deepseek.com'),
    conversation: p => p.match(/\/a\/chat\/s\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'chathub',
    matches: h => h === 'app.chathub.gg' || h.endsWith('.chathub.gg'),
    conversation: (pathname, search) => {
      if (!/^\/chat\/[^/]+\/?$/.test(pathname)) return null;
      const cid = new URLSearchParams(search).get('cid');
      return cid && /^[a-zA-Z0-9-]+$/.test(cid) ? cid : null;
    },
  },
  {
    platformId: 'grok',
    matches: h => h.includes('grok.com') || h.includes('x.com') || h.includes('twitter.com'),
    conversation: p => p.match(/\/chat\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 't3chat',
    matches: h => h.includes('t3.chat'),
    conversation: p => p.match(/\/chat\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'mistral',
    matches: h => h.includes('chat.mistral.ai'),
    conversation: p => p.match(/\/chat\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'openrouter',
    matches: h => h.includes('openrouter.ai'),
    conversation: null,
  },
  {
    platformId: 'perplexity',
    matches: h => h.includes('perplexity.ai'),
    conversation: p => p.match(/\/search\/([a-zA-Z0-9-]+)/)?.[1] ?? null,
  },
  {
    platformId: 'kimi',
    matches: h => h.includes('kimi.com'),
    conversation: null,
  },
  {
    platformId: 'qwen',
    matches: h => h.includes('qwen.ai'),
    conversation: null,
  },
  {
    platformId: 'z',
    matches: h => h.includes('z.ai'),
    conversation: null,
  },
  {
    platformId: 'ghcopilot',
    matches: h => h.includes('github.com'),
    conversation: null,
  },
];

/** Platform id for the current tab, derived from the adapter hostname table. */
export const getPlatformId = (): string => {
  const hostname = window.location.hostname;
  const rule = PLATFORM_SCOPE_RULES.find(r => r.matches(hostname));
  if (rule) return rule.platformId;
  return hostname.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
};

/**
 * Derives the active scope key.
 *
 *   <platform>:c:<conversationId>   stable across tabs and reloads
 *   <platform>:draft:<tabSessionId> explicit fallback, dies with the tab
 *
 * A platform without a verified conversation-id shape ALWAYS lands in the
 * second form. That is a real limitation, surfaced rather than faked: a fake
 * stable scope would let two unrelated conversations share claims.
 */
export const getScopeKey = (): string => {
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;
  const rule = PLATFORM_SCOPE_RULES.find(r => r.matches(hostname));
  const platformId = rule ? rule.platformId : hostname.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';

  if (rule?.conversation) {
    const conversationId = rule.conversation(pathname, window.location.search);
    if (conversationId) return `${platformId}:c:${conversationId}`;
  }

  return `${platformId}:draft:${getTabSessionId()}`;
};

/** True when the current scope is bound to a durable conversation. */
export const hasStableConversationScope = (): boolean => getScopeKey().includes(':c:');

/**
 * Builds the canonical LogicalCallKey.
 */
export const buildLogicalCallKey = (
  scopeKey: string,
  functionName: string,
  callId: string | number,
  contentSignature: string,
): string => {
  return `${scopeKey}__${functionName}__${String(callId)}__${contentSignature}`;
};

/**
 * Checks if a status is terminal (success, error, cancelled).
 */
export const isTerminalStatus = (status: ExecutionStatus): boolean => {
  return status === 'success' || status === 'error' || status === 'cancelled';
};

// ---------------------------------------------------------------------------
// Claims Storage & Atomic Web Locks
// ---------------------------------------------------------------------------

/** Raised when the claims blob cannot be read. Distinguishes "no claims yet"
 *  (legitimately `{}`) from "storage is broken" (must fail closed). */
export class ClaimStorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Execution claim storage unavailable: ${String(cause)}`);
    this.name = 'ClaimStorageUnavailableError';
  }
}

const getAllClaims = (): Record<string, ExecutionClaim> => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CLAIMS_STORAGE_KEY);
  } catch (error) {
    // SecurityError / disabled storage. Returning {} here is what made the
    // claim check fail OPEN: every claimant saw "no existing claim".
    logger.error('Failed to read execution claims from storage:', error);
    throw new ClaimStorageUnavailableError(error);
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('claims blob is not an object');
    return parsed as Record<string, ExecutionClaim>;
  } catch (error) {
    logger.error('Execution claims blob is corrupt:', error);
    throw new ClaimStorageUnavailableError(error);
  }
};

export const getExecutionClaim = (logicalCallKey: string): ExecutionClaim | null => {
  try {
    const claims = getAllClaims();
    return claims[logicalCallKey] || null;
  } catch (error) {
    logger.error(`Failed to get execution claim for ${logicalCallKey}:`, error);
    return null;
  }
};

/**
 * Persist a claim and CONFIRM it landed.
 *
 * Returns false when the claim is not durable. Callers that gate execution on a
 * claim must treat false as "do not execute": previously this swallowed quota
 * and SecurityError failures and returned void, so `claimExecutionAtomic` handed
 * out `granted: true` with nothing on disk and two tabs both ran the tool.
 *
 * ASYNC + LOCKED. Reproduced live in two real Chrome tabs: this function reads
 * the FULL claims blob, merges one key, and writes the whole blob back. The
 * per-key lock in `claimExecutionAtomic` (`claim:<logicalCallKey>`) only
 * serializes writers targeting the SAME key — it does nothing for two tabs
 * claiming DIFFERENT keys at once. Two real tabs, two different keys, fired
 * concurrently: both reported `granted:true`, both passed their own read-back
 * verification, and the SECOND write still silently erased the FIRST tab's
 * claim from the shared blob (classic read-modify-write lost update). A lost
 * claim record means a later auto-execution attempt for that same key sees no
 * claim and can be granted again. This lock is scoped to the blob itself
 * (`claims-blob-write`), distinct from the per-key lock, so it does not change
 * the same-key exclusion semantics that were already proven to work — it only
 * serializes the underlying storage write across DIFFERENT keys too.
 */
export const writeExecutionClaim = async (logicalCallKey: string, claim: ExecutionClaim): Promise<boolean> => {
  const doWrite = (): boolean => {
    try {
      const claims = getAllClaims();
      claims[logicalCallKey] = claim;
      localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(claims));

      // Read back. A silent quota failure, a full disk, or a storage partition
      // that accepted the write and dropped it are all indistinguishable from
      // success without this.
      const raw = localStorage.getItem(CLAIMS_STORAGE_KEY);
      if (!raw) return false;
      const confirmed = JSON.parse(raw) as Record<string, ExecutionClaim>;
      return confirmed[logicalCallKey]?.timestamp === claim.timestamp;
    } catch (error) {
      logger.error(`Failed to write execution claim for ${logicalCallKey}:`, error);
      return false;
    }
  };

  if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof navigator.locks?.request !== 'function') {
    // No Web Locks: fall back to the unlocked write rather than throwing, since
    // callers outside claimExecutionAtomic (which already fails closed without
    // Web Locks before ever reaching here) still need a best-effort write path.
    return doWrite();
  }

  return navigator.locks.request('claims-blob-write', { mode: 'exclusive' }, async () => doWrite());
};

/**
 * Update fields on an existing claim.
 *
 * ASYNC + LOCKED, same reasoning and same lock name as `writeExecutionClaim`.
 * Reproduced live in two real Chrome tabs, seeding two independent existing
 * claims then updating them concurrently from two tabs: the unlocked version
 * lost one of the two updates in 5 of 6 rounds — worse odds than
 * `writeExecutionClaim` had, because this function previously had no lock at
 * all, not even a per-key one. Same root cause: full-blob read-modify-write
 * with nothing serializing it against a concurrent write under a different
 * key. Same fix: the blob-scoped lock, verified empirically at 0/6 after.
 *
 * This function has NO write-back verification (unlike writeExecutionClaim);
 * that is unchanged here — scope of this fix is strictly the missing lock,
 * per the "cambio mínimo" constraint for this pass.
 */
export const updateExecutionClaim = async (
  logicalCallKey: string,
  partial: Partial<ExecutionClaim>,
): Promise<ExecutionClaim | null> => {
  const doUpdate = (): ExecutionClaim | null => {
    try {
      const claims = getAllClaims();
      const existing = claims[logicalCallKey];
      if (!existing) return null;

      const updated: ExecutionClaim = {
        ...existing,
        ...partial,
        timestamp: partial.timestamp ?? Date.now(),
      };
      claims[logicalCallKey] = updated;
      localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(claims));
      return updated;
    } catch (error) {
      logger.error(`Failed to update execution claim for ${logicalCallKey}:`, error);
      return null;
    }
  };

  if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof navigator.locks?.request !== 'function') {
    return doUpdate();
  }

  return navigator.locks.request('claims-blob-write', { mode: 'exclusive' }, async () => doUpdate());
};

/**
 * Atomic cross-tab execution claim using Web Locks API.
 * FAIL-CLOSED policy: if navigator.locks is unavailable, auto-execution is strictly blocked.
 */
export const claimExecutionAtomic = async (
  logicalCallKey: string,
  claimData: {
    scopeKey: string;
    functionName: string;
    callId: string;
    contentSignature: string;
    params?: Record<string, any>;
  },
): Promise<ClaimResult> => {
  const hasWebLocks =
    typeof navigator !== 'undefined' &&
    'locks' in navigator &&
    typeof navigator.locks?.request === 'function';

  if (!hasWebLocks) {
    logger.warn(`[Storage] Web Locks API unavailable. Auto-execution BLOCKED (fail-closed) for ${logicalCallKey}`);
    return { granted: false, reason: 'locks_unavailable' };
  }

  try {
    return await navigator.locks.request(
      `openmcp:claim:${logicalCallKey}`,
      { mode: 'exclusive' },
      async (): Promise<ClaimResult> => {
        // FAIL CLOSED on unreadable storage. `getAllClaims` used to swallow the
        // error and return {}, so a corrupt blob or a SecurityError made every
        // claimant believe the slot was free — two tabs, two executions.
        let existing: ExecutionClaim | null;
        try {
          existing = getAllClaims()[logicalCallKey] ?? null;
        } catch (error) {
          logger.error(
            `[Storage] Claim storage unreadable for ${logicalCallKey}. Auto-execution BLOCKED (fail-closed).`,
            error,
          );
          return { granted: false, reason: 'locks_unavailable' };
        }

        if (existing) {
          const isTerminal = isTerminalStatus(existing.status);
          return {
            granted: false,
            reason: isTerminal ? 'already_terminal' : 'already_claimed',
            claim: existing,
          };
        }

        const newClaim: ExecutionClaim = {
          logicalCallKey,
          scopeKey: claimData.scopeKey,
          functionName: claimData.functionName,
          callId: claimData.callId,
          contentSignature: claimData.contentSignature,
          status: 'running',
          timestamp: Date.now(),
          params: claimData.params,
        };

        // A claim is only a claim once it is durable. Granting on an unverified
        // write is the same as not claiming at all.
        const persisted = await writeExecutionClaim(logicalCallKey, newClaim);
        if (!persisted) {
          logger.error(
            `[Storage] Claim for ${logicalCallKey} could not be persisted. Auto-execution BLOCKED (fail-closed).`,
          );
          return { granted: false, reason: 'claim_conflict' };
        }

        return { granted: true, claim: newClaim };
      },
    );
  } catch (error) {
    logger.error(`[Storage] Lock acquisition error for ${logicalCallKey}:`, error);
    return { granted: false, reason: 'claim_conflict' };
  }
};

/**
 * Remove a pre-dispatch claim only if it is still the same running claim and
 * has not acquired an execution identity.
 */
export const releaseUnstartedExecutionClaim = async (
  logicalCallKey: string,
  expectedTimestamp: number,
): Promise<boolean> => {
  const doRelease = (): boolean => {
    try {
      const claims = getAllClaims();
      const claim = claims[logicalCallKey];
      if (
        !claim ||
        claim.status !== 'running' ||
        claim.timestamp !== expectedTimestamp ||
        claim.executionId ||
        claim.executionKey
      ) {
        return false;
      }

      delete claims[logicalCallKey];
      localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(claims));
      return getAllClaims()[logicalCallKey] === undefined;
    } catch (error) {
      logger.error(`Failed to release unstarted execution claim for ${logicalCallKey}:`, error);
      return false;
    }
  };

  if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof navigator.locks?.request !== 'function') {
    logger.error(`[Storage] Cannot safely release unstarted execution claim without Web Locks: ${logicalCallKey}`);
    return false;
  }

  try {
    return await navigator.locks.request('claims-blob-write', { mode: 'exclusive' }, async () => doRelease());
  } catch (error) {
    logger.error(`Failed to acquire storage lock to release execution claim for ${logicalCallKey}:`, error);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Draft / Conversation Disjoint Scope Helpers
// ---------------------------------------------------------------------------

/**
 * Finds if there is an existing claim executed in this specific tab's draft
 * matching the same (functionName, callId, contentSignature).
 */
export const findDraftClaim = (
  functionName: string,
  callId: string | number,
  contentSignature: string,
): ExecutionClaim | null => {
  // The draft scope must use the CURRENT platform. Hardcoding `chatgpt:` made
  // this return null on every other platform, so the draft-conflict guard — the
  // thing that stops a draft execution being repeated once the conversation
  // gets its real id — never fired anywhere but ChatGPT.
  const draftScope = `${getPlatformId()}:draft:${getTabSessionId()}`;
  const draftKey = buildLogicalCallKey(draftScope, functionName, callId, contentSignature);
  return getExecutionClaim(draftKey);
};

/**
 * Adopts a draft claim into a conversation scope upon explicit user manual action.
 */
export const adoptDraftClaim = async (
  conversationScopeKey: string,
  draftClaim: ExecutionClaim,
): Promise<ExecutionClaim> => {
  const newLogicalKey = buildLogicalCallKey(
    conversationScopeKey,
    draftClaim.functionName,
    draftClaim.callId,
    draftClaim.contentSignature,
  );
  const adopted: ExecutionClaim = {
    ...draftClaim,
    logicalCallKey: newLogicalKey,
    scopeKey: conversationScopeKey,
    timestamp: Date.now(),
  };
  await writeExecutionClaim(newLogicalKey, adopted);
  return adopted;
};

// ---------------------------------------------------------------------------
// Backward-compatible Storage APIs
// ---------------------------------------------------------------------------

export const storeExecutedFunction = async (
  functionName: string,
  callId: string,
  params: Record<string, any>,
  contentSignature: string,
  status: ExecutionStatus = 'success',
  errorMessage?: string,
  result?: unknown,
): Promise<ExecutedFunction> => {
  const url = window.location.href;
  const scopeKey = getScopeKey();
  const logicalCallKey = buildLogicalCallKey(scopeKey, functionName, callId, contentSignature);

  const executionRecord: ExecutedFunction = {
    functionName,
    callId,
    contentSignature,
    executedAt: Date.now(),
    params,
    status,
    errorMessage,
  };

  // Update canonical claim
  const claim: ExecutionClaim = {
    logicalCallKey,
    scopeKey,
    functionName,
    callId,
    contentSignature,
    status,
    timestamp: Date.now(),
    params,
    result,
    errorMessage,
  };
  await writeExecutionClaim(logicalCallKey, claim);

  // Update legacy URL-based storage
  const executionKey = generateExecutionKey(functionName, callId, contentSignature);
  const storage = getURLBasedStorage();
  if (!storage[url]) {
    storage[url] = {};
  }
  storage[url][executionKey] = executionRecord;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch (error) {
    logger.error('Failed to store executed function in legacy storage:', error);
  }

  return executionRecord;
};

const generateExecutionKey = (functionName: string, callId: string, contentSignature: string): string => {
  return `${functionName}:${callId}:${contentSignature}`;
};

const getURLBasedStorage = (): URLBasedFunctionHistory => {
  try {
    const storedData = localStorage.getItem(STORAGE_KEY);
    return storedData ? JSON.parse(storedData) : {};
  } catch (error) {
    logger.error('Failed to retrieve URL-based function history:', error);
    return {};
  }
};

export const getExecutedFunctions = (): (ExecutedFunction & { url: string })[] => {
  try {
    const storage = getURLBasedStorage();
    const result: (ExecutedFunction & { url: string })[] = [];
    Object.entries(storage).forEach(([url, functions]) => {
      Object.values(functions).forEach(func => {
        result.push({
          ...func,
          url,
        });
      });
    });
    return result;
  } catch (error) {
    logger.error('Failed to retrieve executed functions:', error);
    return [];
  }
};

export const getExecutedFunctionsForCurrentUrl = (): ExecutedFunction[] => {
  const currentUrl = window.location.href;
  const storage = getURLBasedStorage();
  if (!storage[currentUrl]) return [];
  return Object.values(storage[currentUrl]);
};

export const getExecutedFunctionsForUrl = (url: string): ExecutedFunction[] => {
  const storage = getURLBasedStorage();
  if (!storage[url]) return [];
  return Object.values(storage[url]);
};

/**
 * Checks if a function has been executed.
 * Queries canonical claims first, then falls back to legacy storage.
 */
export const getPreviousExecution = (
  functionName: string,
  callId: string,
  contentSignature: string,
): ExecutedFunction | null => {
  const scopeKey = getScopeKey();
  const logicalCallKey = buildLogicalCallKey(scopeKey, functionName, callId, contentSignature);
  const claim = getExecutionClaim(logicalCallKey);

  if (claim) {
    return {
      functionName: claim.functionName,
      callId: claim.callId,
      contentSignature: claim.contentSignature,
      executedAt: claim.timestamp,
      params: claim.params || {},
      status: claim.status,
      errorMessage: claim.errorMessage,
    };
  }

  // Fallback to URL-based storage
  const currentUrl = window.location.href;
  const storage = getURLBasedStorage();
  if (!storage[currentUrl]) return null;

  const executionKey = generateExecutionKey(functionName, callId, contentSignature);
  return storage[currentUrl][executionKey] || null;
};

export const getPreviousExecutionLegacy = (callId: string, contentSignature: string): ExecutedFunction | null => {
  const currentUrl = window.location.href;
  const storage = getURLBasedStorage();
  if (!storage[currentUrl]) return null;

  const functionEntry = Object.entries(storage[currentUrl]).find(
    ([_, func]) => func.callId === callId && func.contentSignature === contentSignature,
  );
  return functionEntry ? functionEntry[1] : null;
};

export const generateContentSignature = (functionName: string, params: Record<string, any>): string => {
  try {
    const sortedParams: Record<string, any> = {};
    Object.keys(params)
      .sort()
      .forEach(key => {
        sortedParams[key] = params[key];
      });

    const content = JSON.stringify({ name: functionName, params: sortedParams });
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  } catch (error) {
    logger.error('Failed to generate content signature:', error);
    return Date.now().toString(16);
  }
};

export const formatExecutionTime = (timestamp: number): string => {
  try {
    const date = new Date(timestamp);
    return date.toLocaleString();
  } catch {
    return 'Unknown date';
  }
};

// ---------------------------------------------------------------------------
// Execution-key persistence for post-refresh recovery
// ---------------------------------------------------------------------------

const EXECUTION_KEY_MAP_STORAGE = 'mcp_execution_key_map';

export const storeExecutionKeyMapping = (
  callId: string,
  contentSig: string,
  executionKey: string,
): void => {
  try {
    const raw = localStorage.getItem(EXECUTION_KEY_MAP_STORAGE);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};
    // Scoped. The old global `${callId}:${contentSig}` key meant the last
    // conversation to run a given callId+signature owned the mapping for every
    // conversation, so one could recover another's execution.
    map[`${getScopeKey()}::${callId}:${contentSig}`] = executionKey;
    localStorage.setItem(EXECUTION_KEY_MAP_STORAGE, JSON.stringify(map));
  } catch (error) {
    logger.error('Failed to store execution key mapping:', error);
  }
};

export const getExecutionKeyMapping = (
  callId: string,
  contentSig: string,
): string | null => {
  try {
    const raw = localStorage.getItem(EXECUTION_KEY_MAP_STORAGE);
    if (!raw) return null;
    const map: Record<string, string> = JSON.parse(raw);
    return map[`${getScopeKey()}::${callId}:${contentSig}`] ?? map[`${callId}:${contentSig}`] ?? null;
  } catch (error) {
    logger.error('Failed to retrieve execution key mapping:', error);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Claims and mappings are written forever and never reclaimed; a claim carries
 *  its `result` inline, so the blob grows until localStorage hits quota — and a
 *  quota failure is exactly what makes the claim layer fail. */
const CLAIM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_CLAIMS = 500;

/**
 * Reclaim storage from old/excess claims and their key-mapping entries.
 *
 * ASYNC + LOCKED, same `claims-blob-write` lock as `writeExecutionClaim` and
 * `updateExecutionClaim` — reused, not a new mechanism. This was the third
 * writer of CLAIMS_STORAGE_KEY and the only one that never acquired the lock:
 * a fully synchronous read-modify-write of the whole blob, exactly like the
 * other two before their fixes.
 *
 * Reproduced live in two real Chrome tabs: with a 300-entry claims payload to
 * give the race a realistic window, an update running concurrently with an
 * unlocked prune lost 2 of 10 rounds. With this lock applied, the loss rate
 * dropped to roughly 1 in 10–25 rounds under the same artificially adversarial
 * timing — not zero. Instrumented logging confirmed the lock DOES correctly
 * serialize callback execution order (update's callback fully completes and
 * releases before prune's acquires, every time observed); the residual loss
 * traces to a deeper characteristic of this storage backend: a write from one
 * tab is not always immediately visible to `localStorage.getItem` in another
 * tab's process, even after the writing tab's `setItem` call has returned and
 * the lock has changed hands (confirmed directly: 30/30 immediate cross-tab
 * reads were stale with no lock involved at all, i.e. plain propagation
 * latency, not a locking bug). Web Locks correctly orders WHO runs; it does
 * not guarantee THAT the previous holder's write has fully propagated to the
 * next holder's read. Closing that gap is a different, larger problem than
 * "this writer is missing the lock" and is out of scope here.
 */
export const pruneExecutionStorage = async (now: number = Date.now()): Promise<number> => {
  const doPrune = (): number => {
    let removed = 0;
    try {
      const claims = getAllClaims();
      const entries = Object.entries(claims);

      const survivors = entries.filter(([, claim]) => {
        // Never drop a non-terminal claim: it may be the only record that an
        // execution is in flight.
        if (!isTerminalStatus(claim.status)) return true;
        return now - claim.timestamp < CLAIM_RETENTION_MS;
      });

      survivors.sort((a, b) => b[1].timestamp - a[1].timestamp);
      const kept = survivors.slice(0, MAX_RETAINED_CLAIMS);
      removed = entries.length - kept.length;

      if (removed > 0) {
        localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
      }

      const rawMap = localStorage.getItem(EXECUTION_KEY_MAP_STORAGE);
      if (rawMap) {
        const map: Record<string, string> = JSON.parse(rawMap);
        const keptKeys = new Set(kept.map(([, c]) => `${c.scopeKey}::${c.callId}:${c.contentSignature}`));
        const prunedMap = Object.fromEntries(Object.entries(map).filter(([k]) => keptKeys.has(k)));
        localStorage.setItem(EXECUTION_KEY_MAP_STORAGE, JSON.stringify(prunedMap));
      }
    } catch (error) {
      logger.error('Failed to prune execution storage:', error);
    }
    return removed;
  };

  if (typeof navigator === 'undefined' || !('locks' in navigator) || typeof navigator.locks?.request !== 'function') {
    return doPrune();
  }

  return navigator.locks.request('claims-blob-write', { mode: 'exclusive' }, async () => doPrune());
};
