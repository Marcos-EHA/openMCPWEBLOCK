/**
 * RelayBus — Pure transport bus for Orchestrator Commands, Events, and Queries.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURAL ROLE & INVARIANTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. PURE TRANSPORT ONLY:
 *    RelayBus does NOT:
 *      - spawn or kill Chrome processes
 *      - inspect Chrome DevTools Protocol or targets
 *      - detect Service Workers or extension files
 *      - access chrome.storage or filesystem locks
 *      - query ExecutionRegistry directly
 *      - run Sentinel background checks
 *      - duplicate WebInstanceRegistry
 *      - create an alternate lifecycle state machine
 *
 * 2. ROUTING RESPONSIBILITIES:
 *      Command (imperative) ───► MultiAgentRunner (agent commands)
 *                               ExecutionAdapter (execution commands)
 *      Event   (declarative) ◄── MultiAgentRunner (onLifecycleEvent)
 *                            ◄── Sentinel (onSentinelEvent)
 *                                  │
 *                                  ▼ forwarded to RelayBus subscribers
 *      Query   (request/resp)──► MultiAgentRunner (agent state/list)
 *                               Sentinel (sentinel:status scan)
 *                               System check (system:health)
 *                               ExecutionAdapter (execution queries)
 *
 * 3. NO SYNTHETIC EVENTS:
 *    RelayBus never manufactures success or error events on its own.
 *    Events flow strictly from the authoritative layer where real mutation occurred.
 *
 * 4. ERROR FIDELITY:
 *    Errors from underlying operations are propagated verbatim without being
 *    swallowed or obscured by generic wrapper messages.
 *
 * 5. CONCURRENCY:
 *    RelayBus preserves the per-agent mutex serialization already enforced by
 *    MultiAgentRunner (no second queue, no interleaving races).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  Command,
  AgentCommand,
  ExecutionCommand,
  OrchestratorEvent,
  OrchestratorQuery,
  QueryResult,
  SystemHealth,
  AgentState,
  AgentRecoveryResult,
  SentinelActivitySnapshot,
  SentinelScanResult,
} from './types.js'

import {
  createAgent,
  startAgent,
  stopAgent,
  restartAgent,
  recoverExistingAgents,
  removeAgent,
  getAgentStatus,
  setAgentSAConfigurationStatus,
  listAgents,
  getSystemHealth,
  onLifecycleEvent,
} from './MultiAgentRunner.js'

import {
  getLastScanResult,
  readAgentExecutionActivity,
  readAgentConversation,
  scan as scanSentinel,
  onSentinelEvent,
} from './Sentinel.js'
import { isWebCoordinatorRole } from '../launchPolicy.js'

export type EventSubscriber = (event: OrchestratorEvent) => void

/**
 * Adapter interface for execution-domain commands and queries.
 * Separated cleanly from agent lifecycle management.
 */
export interface ExecutionAdapter {
  executeCommand(cmd: ExecutionCommand): Promise<void>
  query(q: OrchestratorQuery & { name: 'execution:list' | 'execution:inspect' }): Promise<any>
}

export type CommandResult<C extends Command> =
  C extends AgentCommand
    ? C extends { name: 'agent:remove' } ? void
      : C extends { name: 'agent:recover-existing' } ? AgentRecoveryResult
        : AgentState
    :
  C extends ExecutionCommand ? void :
  unknown

export class RelayBus {
  private subscribers = new Set<EventSubscriber>()
  private unsubRunner: (() => void) | null = null
  private unsubSentinel: (() => void) | null = null
  private executionAdapter: ExecutionAdapter | null = null

  constructor(options?: {
    executionAdapter?: ExecutionAdapter
    autoConnect?: boolean
  }) {
    if (options?.executionAdapter) {
      this.executionAdapter = options.executionAdapter
    }
    if (options?.autoConnect !== false) {
      this.connect()
    }
  }

  /**
   * Connect to event producers (MultiAgentRunner and Sentinel).
   */
  public connect(): void {
    if (!this.unsubRunner) {
      this.unsubRunner = onLifecycleEvent(event => this.publish(event))
    }
    if (!this.unsubSentinel) {
      this.unsubSentinel = onSentinelEvent(event => this.publish(event))
    }
  }

  /**
   * Disconnect from event producers.
   */
  public disconnect(): void {
    if (this.unsubRunner) {
      this.unsubRunner()
      this.unsubRunner = null
    }
    if (this.unsubSentinel) {
      this.unsubSentinel()
      this.unsubSentinel = null
    }
  }

  /**
   * Set or replace the execution domain adapter.
   */
  public setExecutionAdapter(adapter: ExecutionAdapter | null): void {
    this.executionAdapter = adapter
  }

  /**
   * Subscribe to events flowing through RelayBus.
   * Returns an unsubscribe callback.
   */
  public subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  /**
   * Alias for subscribe().
   */
  public on(subscriber: EventSubscriber): () => void {
    return this.subscribe(subscriber)
  }

  /**
   * Forward an event to all subscribers.
   * Internal/forwarding method: RelayBus does not synthesize events.
   */
  private publish(event: OrchestratorEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event)
      } catch (err) {
        // Individual subscriber errors must never break event distribution
        console.error('[RelayBus] Subscriber error:', err)
      }
    }
  }

  /**
   * Dispatch an imperative Command to the authoritative domain handler.
   */
  public async send<C extends Command>(command: C): Promise<CommandResult<C>> {
    switch (command.name) {
      case 'agent:start': {
        const { agentId, platformId, role, sessionMode, masterSessionSourceId, chromeProfileDirectory } = command.payload
        if (isWebCoordinatorRole(role)) {
          const existingCoordinator = listAgents().find(agent =>
            agent.role === role &&
            agent.agentId !== agentId &&
            agent.status !== 'stopped' &&
            agent.status !== 'error',
          )
          if (existingCoordinator) {
            throw new Error(
              `[RelayBus] Web coordinator "${existingCoordinator.agentId}" is already ` +
              `registered with status "${existingCoordinator.status}". Stop or remove it ` +
              'before starting another coordinator with that role.',
            )
          }
        }
        createAgent({ agentId, platformId, role, sessionMode, masterSessionSourceId, chromeProfileDirectory })
        const state = await startAgent(agentId)
        return state as CommandResult<C>
      }

      case 'agent:sa-preparation-status': {
        const state = await setAgentSAConfigurationStatus(
          command.payload.agentId,
          command.payload.preparing,
        )
        return state as CommandResult<C>
      }

      case 'agent:recover-existing': {
        const { platformId, sessionMode, purpose } = command.payload
        const result = await recoverExistingAgents(platformId, sessionMode, purpose)
        return result as CommandResult<C>
      }

      case 'agent:stop': {
        const { agentId } = command.payload
        const state = await stopAgent(agentId)
        return state as CommandResult<C>
      }

      case 'agent:restart': {
        const { agentId } = command.payload
        const state = await restartAgent(agentId)
        return state as CommandResult<C>
      }

      case 'agent:remove': {
        const { agentId } = command.payload
        removeAgent(agentId)
        return undefined as CommandResult<C>
      }

      case 'execution:acknowledge-unknown': {
        if (!this.executionAdapter) {
          throw new Error(
            `[RelayBus] No ExecutionAdapter registered to handle command: ${command.name}`,
          )
        }
        await this.executionAdapter.executeCommand(command)
        return undefined as CommandResult<C>
      }

      default: {
        const unhandled = command as { name: string }
        throw new Error(`[RelayBus] Unrecognized command name: ${unhandled.name}`)
      }
    }
  }

  /**
   * Execute a typed, asynchronous Query against the appropriate system.
   */
  public async query<Q extends OrchestratorQuery>(query: Q): Promise<QueryResult<Q>> {
    switch (query.name) {
      case 'agent:list': {
        const list = listAgents()
        return list as QueryResult<Q>
      }

      case 'agent:status': {
        const status = getAgentStatus(query.payload.agentId)
        return status as QueryResult<Q>
      }

      case 'sentinel:status': {
        const scanResult = getLastScanResult()
        return scanResult as QueryResult<Q>
      }

      case 'sentinel:scan': {
        const scanResult = await scanSentinel()
        return scanResult as QueryResult<Q>
      }

      case 'sentinel:activity': {
        const activity = await readAgentExecutionActivity(query.payload.agentId)
        return activity as QueryResult<Q>
      }

      case 'sentinel:conversation': {
        const snapshot = await readAgentConversation(query.payload.agentId)
        return snapshot as QueryResult<Q>
      }

      case 'system:health': {
        const health = await getSystemHealth()
        return health as QueryResult<Q>
      }

      case 'execution:list':
      case 'execution:inspect': {
        if (!this.executionAdapter) {
          throw new Error(
            `[RelayBus] No ExecutionAdapter registered to handle query: ${query.name}`,
          )
        }
        const res = await this.executionAdapter.query(query)
        return res as QueryResult<Q>
      }

      default: {
        const unhandled = query as { name: string }
        throw new Error(`[RelayBus] Unrecognized query name: ${unhandled.name}`)
      }
    }
  }

  /**
   * Reset subscribers, disconnect producers, and clear adapters (for testing).
   */
  public reset(): void {
    this.disconnect()
    this.subscribers.clear()
    this.executionAdapter = null
    this.connect()
  }

  /**
   * Tear down completely.
   */
  public destroy(): void {
    this.disconnect()
    this.subscribers.clear()
    this.executionAdapter = null
  }
}

// ─── Default Singleton & Functional Exports ──────────────────────────────────

export const relayBus = new RelayBus()

export function send<C extends Command>(command: C): Promise<CommandResult<C>> {
  return relayBus.send(command)
}

export function query<Q extends OrchestratorQuery>(q: Q): Promise<QueryResult<Q>> {
  return relayBus.query(q)
}

export function subscribe(subscriber: EventSubscriber): () => void {
  return relayBus.subscribe(subscriber)
}

export function on(subscriber: EventSubscriber): () => void {
  return relayBus.on(subscriber)
}

export function resetRelayBus(): void {
  relayBus.reset()
}
