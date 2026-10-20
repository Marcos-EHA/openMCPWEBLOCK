export const EXECUTION_DIAGNOSTIC_BUILD_MARKER =
  'openmcpweblock-source-dist-background-visibility-20261008-01';

export const EXECUTION_DIAGNOSTICS_ENABLED = true;

const TRACE_STORAGE_PREFIX = 'mcp:execution-diagnostic:v1:';
const TRACE_SLOT_COUNT = 256;
const TRACE_MAX_BYTES = 4096;
const TRACE_RESERVED_BYTES = 2 * 1024 * 1024;
let nextTraceSlot = Math.floor(Math.random() * TRACE_SLOT_COUNT);

/** Best-effort diagnostic samples, never the authoritative execution journal.
 * Slots are shared across extension contexts: concurrent writers may replace
 * samples, but cannot create an unbounded number of new storage keys.
 * Legacy timestamp keys are left intact for explicit archival and migration.
 */
export async function persistExecutionDiagnostic(record: Record<string, unknown>): Promise<boolean> {
  const serialized = JSON.stringify(record);
  if (new TextEncoder().encode(serialized).byteLength > TRACE_MAX_BYTES) return false;
  const storage = chrome.storage.local;
  const used = await storage.getBytesInUse(null);
  const quota = storage.QUOTA_BYTES ?? 10 * 1024 * 1024;
  if (used + TRACE_MAX_BYTES > quota - TRACE_RESERVED_BYTES) return false;
  const slot = nextTraceSlot;
  nextTraceSlot = (nextTraceSlot + 1) % TRACE_SLOT_COUNT;
  await storage.set({ [`${TRACE_STORAGE_PREFIX}slot-${slot}`]: record });
  return true;
}
const COLLECTOR_URL = 'http://127.0.0.1:3011/v1/execution-diagnostic';

type DiagnosticValue = string | number | boolean | string[] | null | undefined;
const ALLOWED_FIELDS = new Set([
  'callId',
  'executionId',
  'executionKey',
  'handle',
  'scopeKey',
  'instanceId',
  'toolName',
  'adapterName',
  'success',
  'responseType',
  'responseKeys',
  'responseCallId',
  'byAddress',
  'executionIdPresent',
  'executionKeyPresent',
  'commandPresent',
  'argumentKeys',
  'resultStatus',
  'deliveryType',
  'barrierState',
  'delayName',
  'delayMs',
  'activeStreamIntervals',
  'nodeId',
  'removalReason',
  'intervalId',
  'dispatcherId',
  'coalesced',
  'blockedByUnknownOutcome',
  'newExecution',
  'reason',
  'attempt',
  'autoExecuteEnabled',
  'contentSignaturePresent',
  'alreadyExecuted',
  'claimStatus',
  'executionStatus',
  'pageVisibility',
  'pageHasFocus',
  'targetSelectors',
  'streamingContainerSelectors',
  'monitoringEnabled',
]);

function forwardDiagnostic(record: Record<string, unknown>): void {
  const payload = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      ['timestamp', 'event', 'extensionId', 'manifestVersion', 'buildMarker'].includes(key) ||
      ALLOWED_FIELDS.has(key),
    ),
  );

  if (typeof document !== 'undefined') {
    try {
      chrome.runtime.sendMessage({ type: 'mcp:execution-diagnostic', payload }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[ExecutionDiagnostic] Background relay unavailable:', chrome.runtime.lastError.message);
        } else if (response?.success === false) {
          console.warn('[ExecutionDiagnostic] Background relay rejected the event');
        }
      });
    } catch (error) {
      console.warn('[ExecutionDiagnostic] Background relay failed:', error);
    }
    return;
  }

  void fetch(COLLECTOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(payload),
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(1500),
  }).then(response => {
    if (!response.ok) {
      console.warn(`[ExecutionDiagnostic] Collector returned HTTP ${response.status}`);
    }
  }).catch(error => {
    console.warn('[ExecutionDiagnostic] Collector unavailable:', error);
  });
}

export function recordExecutionDiagnostic(
  operation: string,
  fields: Record<string, DiagnosticValue> = {},
): void {
  if (!EXECUTION_DIAGNOSTICS_ENABLED) return;
  if (typeof chrome === 'undefined') return;

  try {
    if (!chrome.storage?.local) {
      throw new Error('chrome.storage.local is unavailable');
    }

    const runtime = chrome.runtime;
    const pageState = typeof document === 'undefined'
      ? {}
      : {
          pageVisibility: document.visibilityState,
          pageHasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        };
    const record = {
      timestamp: new Date().toISOString(),
      event: operation,
      ...fields,
      ...pageState,
      extensionId: runtime?.id ?? 'unavailable',
      manifestVersion: runtime?.getManifest?.().version ?? 'unavailable',
      buildMarker: EXECUTION_DIAGNOSTIC_BUILD_MARKER,
    };
    const sanitized = Object.fromEntries(
      Object.entries(record).filter(([key]) =>
        ['timestamp', 'event', 'extensionId', 'manifestVersion', 'buildMarker'].includes(key) ||
        ALLOWED_FIELDS.has(key),
      ),
    );
    void persistExecutionDiagnostic(sanitized).catch(error => {
      console.warn('[ExecutionDiagnostic] Trace write failed:', error);
    });
    forwardDiagnostic(sanitized);
  } catch (error) {
    console.warn('[ExecutionDiagnostic] Trace write failed:', error);
  }
}
