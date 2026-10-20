/**
 * useOrchestratorState — React hook connecting the TUI to the Orchestration AppState.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURAL CONTRACT & INVARIANTS:
 *
 *   WebInstanceRegistry / ChromeCDP
 *                 │
 *                 ▼
 *         MultiAgentRunner
 *                 │
 *                 ▼
 *              Sentinel
 *                 │
 *                 ▼
 *             RelayBus
 *                 │
 *                 ▼
 *      orchestration/AppState
 *                 │
 *                 ▼
 *       useOrchestratorState() (this hook)
 *                 │
 *                 ▼
 *              Ink TUI
 *
 * 1. PURE REACTIVE SUBSCRIPTION:
 *    Uses `useSyncExternalStore` to subscribe to `AppState.subscribe()`.
 *    Zero polling (no setInterval, no setTimeout, no periodic fetch).
 *
 * 2. REFERENCE STABILITY:
 *    `appState.getState()` returns the same immutable snapshot reference
 *    until a genuine state change occurs, preventing infinite render loops.
 *
 * 3. NO DIRECT INFRASTRUCTURE CALLS:
 *    This hook and consuming UI components NEVER call ChromeCDP, WebInstanceRegistry,
 *    MultiAgentRunner, Sentinel, or RelayBus directly.
 *    All commands delegate exclusively through `AppState`.
 *
 * 4. NO LIFECYCLE CONTAMINATION:
 *    This hook contains zero lifecycle progression logic or state mutation logic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  type AppState,
  type AppStateData,
  orchestrationAppState,
} from '../services/webRelay/orchestration/AppState.js'
import type { AgentSessionMode, AgentState } from '../services/webRelay/orchestration/types.js'
import type {
  SentinelActivitySnapshot,
  SentinelConversationSnapshot,
  SentinelScanResult,
} from '../services/webRelay/orchestration/types.js'

export interface OrchestratorActions {
  /** Launch an agent through RelayBus via AppState. */
  startAgent(
    agentId: string,
    platformId: string,
    role?: string,
    sessionMode?: AgentSessionMode,
    masterSessionSourceId?: string,
    chromeProfileDirectory?: string,
  ): Promise<AgentState>
  /** Stop an agent through RelayBus via AppState. */
  stopAgent(agentId: string): Promise<AgentState>
  /** Restart an agent through RelayBus via AppState. */
  restartAgent(agentId: string): Promise<AgentState>
  /** Run an explicit Sentinel health scan through AppState and RelayBus. */
  scanSentinel(): Promise<SentinelScanResult>
  /** Read recent technical execution diagnostics for one registered Relay. */
  readSentinelActivity(agentId: string): Promise<SentinelActivitySnapshot>
  /** Read a user-consented in-memory conversation snapshot for one Relay. */
  readSentinelConversation(agentId: string): Promise<SentinelConversationSnapshot>
  /** Remove an agent registration through RelayBus via AppState. */
  removeAgent(agentId: string): Promise<void>
  /** Select an agent in the UI presentation state. */
  selectAgent(agentId: string | null): void
  /** Acknowledge an unknown execution outcome. */
  acknowledgeUnknown(executionId: string, agentId: string): Promise<void>
  /** Clear the last recorded error. */
  clearLastError(): void
}

export interface UseOrchestratorStateResult {
  state: AppStateData
  actions: OrchestratorActions
}

/**
 * React hook to consume orchestration state in TUI components.
 *
 * @param customAppState Optional AppState instance for dependency injection in tests.
 */
export function useOrchestratorState(
  customAppState?: AppState,
): UseOrchestratorStateResult {
  const store = customAppState ?? orchestrationAppState

  const storeRef = useRef(store)
  storeRef.current = store

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return storeRef.current.subscribe(onStoreChange)
    },
    [],
  )

  const getSnapshot = useCallback(() => {
    return storeRef.current.getState()
  }, [])

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const actions = useMemo<OrchestratorActions>(
    () => ({
      startAgent: (
        agentId,
        platformId,
        role,
        sessionMode,
        masterSessionSourceId,
        chromeProfileDirectory,
      ) =>
        store.startAgent(
          agentId,
          platformId,
          role,
          sessionMode,
          masterSessionSourceId,
          chromeProfileDirectory,
        ),
      stopAgent: (agentId) => store.stopAgent(agentId),
      restartAgent: (agentId) => store.restartAgent(agentId),
      scanSentinel: () => store.scanSentinel(),
      readSentinelActivity: (agentId) => store.readSentinelActivity(agentId),
      readSentinelConversation: (agentId) => store.readSentinelConversation(agentId),
      removeAgent: (agentId) => store.removeAgent(agentId),
      selectAgent: (agentId) => store.selectAgent(agentId),
      acknowledgeUnknown: (executionId, agentId) =>
        store.acknowledgeUnknown(executionId, agentId),
      clearLastError: () => store.clearLastError(),
    }),
    [store],
  )

  return { state, actions }
}
