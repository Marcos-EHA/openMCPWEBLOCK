/**
 * Orchestration type contracts for OpenMCPWEBLOCK.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN PRINCIPLES (from architectural review)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. No new identity systems. Reuses:
 *      agentId    — logical agent (user/orchestrator-defined)
 *      instanceId — concrete Chrome instance (from WebInstanceRegistry)
 *      platformId — web platform (chatgpt, gemini, etc.)
 *      executionId — execution identity (from ExecutionRegistry)
 *
 * 2. executionKey (address) is NOT exposed at this level. The distinction
 *    between identity (executionId) and address (executionKey) was established
 *    in Opus 3's forensic sessions and must be reinforced, not eroded.
 *
 * 3. Agent lifecycle has granular states that reflect the real startup
 *    sequence: Chrome process → extension → Service Worker → MCP readiness.
 *    This was identified as critical because the gap between "Chrome started"
 *    and "extension actually available" is where real failures occur.
 *
 * 4. Commands, Events, and Queries are separate discriminated unions.
 *    Agent commands go to MultiAgentRunner.
 *    Execution commands go through an ExecutionQueryAdapter.
 *    Queries are async (CDP reads, port checks are inherently async).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { WebInstance } from '../WebInstanceRegistry.js'
import type { ExecutionDiagnosticEvent } from '../ExecutionDiagnostics.js'
import type { ConversationFlowSummary } from '../ConversationFlowDiagnostics.js'

// ─── Agent Lifecycle State Machine ───────────────────────────────────────────
//
//   CREATED ─→ STARTING ─→ CHROME_READY ─→ EXTENSION_LOADING
//                                               ↓
//                                    SERVICE_WORKER_READY
//                                               ↓
//                                          MCP_READY
//                                               ↓
//                                            READY ─→ STOPPING ─→ STOPPED
//                                              ↓
//                                            LOST ─→ RESTARTING ─→ STARTING
//
//   Any state ─→ ERROR
//   ERROR ─→ STARTING | STOPPED
//   STOPPED ─→ STARTING
//
// The granularity between STARTING and READY is what lets Sentinel report
// exactly WHERE a launch stalled, and what lets the UI show meaningful
// progress instead of a spinner followed by a sudden error.
// ─────────────────────────────────────────────────────────────────────────────

export type AgentLifecycleStatus =
  | 'created'
  | 'starting'
  | 'chrome_ready'
  | 'session_ready'
  | 'extension_loading'
  | 'service_worker_ready'
  | 'mcp_ready'
  | 'ready'
  | 'sa_preparing'
  | 'startup_verifying'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'lost'
  | 'restarting'

export const AGENT_LIFECYCLE_TRANSITIONS: Record<AgentLifecycleStatus, AgentLifecycleStatus[]> = {
  created:              ['starting', 'error', 'stopped'],
  starting:             ['chrome_ready', 'error', 'stopped'],
  chrome_ready:         ['session_ready', 'error', 'stopped'],
  session_ready:        ['extension_loading', 'error', 'stopped'],
  extension_loading:    ['service_worker_ready', 'error', 'stopped'],
  service_worker_ready: ['mcp_ready', 'error', 'stopped'],
  mcp_ready:            ['ready', 'error', 'stopped'],
  ready:                ['sa_preparing', 'stopping', 'error', 'lost'],
  sa_preparing:         ['startup_verifying', 'ready', 'stopping', 'error', 'lost'],
  startup_verifying:    ['ready', 'stopping', 'error', 'lost'],
  stopping:             ['stopped', 'error'],
  stopped:              ['starting'],
  error:                ['starting', 'stopped'],
  lost:                 ['restarting', 'stopped'],
  restarting:           ['starting', 'error', 'stopped'],
}

export function isTerminalStatus(status: AgentLifecycleStatus): boolean {
  return status === 'stopped'
}

export function isOperationalStatus(status: AgentLifecycleStatus): boolean {
  return status === 'ready'
}

export function isTransitionValid(from: AgentLifecycleStatus, to: AgentLifecycleStatus): boolean {
  return AGENT_LIFECYCLE_TRANSITIONS[from].includes(to)
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export type AgentSessionMode = 'authenticated' | 'clean' | 'chrome-profile'
export type AgentRecoveryPurpose = 'agent' | 'user' | 'infer'

export interface AgentConfig {
  agentId: string
  platformId: string
  role?: string
  autoStart?: boolean
  /** Starts minimized by default; set false only when this relay must be inspected interactively. */
  startMinimized?: boolean
  sessionMode?: AgentSessionMode
  masterSessionSourceId?: string
  chromeProfileDirectory?: string
}

export interface AgentState {
  agentId: string
  platformId: string
  role?: string
  sessionMode?: AgentSessionMode
  masterSessionSourceId?: string
  chromeProfileDirectory?: string
  instanceId?: string
  saExtensionId?: string
  status: AgentLifecycleStatus
  /** Debug port of the Chrome instance, if any. */
  debugPort?: number
  /** Count of executions currently in non-terminal state. */
  activeExecutions: number
  /** Count of executions with unknownOutcome not yet acknowledged. */
  unknownExecutions: number
  /** Last time Sentinel confirmed the instance was alive. */
  lastHeartbeat?: number
  /** Human-readable error, set when status === 'error'. */
  error?: string
  createdAt: number
}

export interface AgentRecoveryResult {
  adopted: AgentState[]
  skipped: string[]
  cdpPortsScanned: number
  cdpPortsFound: number
  matchingIdentitiesFound: number
}

// ─── Execution Snapshot ──────────────────────────────────────────────────────
//
// NOTE: executionKey is intentionally absent. executionId is the identity.
// The address (executionKey) lives below this layer, inside ExecutionRegistry
// and its adapters. See docs/EXECUTION_FORENSIC_STATE.md §17.1.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionStatus = 'running' | 'success' | 'error' | 'cancelled' | 'unknown'

export interface ExecutionSnapshot {
  executionId: string
  status: ExecutionStatus
  unknownOutcome?: boolean
  unknownReason?: string
  unknownAcknowledgedAt?: number
  agentId?: string
  instanceId?: string
  startedAt?: number
  completedAt?: number
}

// ─── Orchestrator State ──────────────────────────────────────────────────────

export interface EventEntry {
  id: string
  timestamp: number
  name: string
  severity?: SentinelLogSeverity
  code?: string
  agentId?: string
  instanceId?: string
  executionId?: string
  detail?: string
}

export interface OrchestratorState {
  agents: Record<string, AgentState>
  events: EventEntry[]
  /** Maximum events retained in memory. Older ones are evicted. */
  maxEvents: number
}

export function createEmptyOrchestratorState(): OrchestratorState {
  return { agents: {}, events: [], maxEvents: 200 }
}

export interface SentinelScanResult {
  healthy?: boolean
  agentsChecked: number
  issuesFound: number
  scannedAt?: number
  details: SentinelCheckResult[]
  logs?: SentinelLogEntry[]
}

export interface SentinelActivitySnapshot {
  agentId: string
  available: boolean
  unavailableReason?: 'agent-not-ready' | 'missing-extension-id' | 'extension-service-worker-unavailable'
  events: ExecutionDiagnosticEvent[]
}

export interface SentinelConversationSnapshot {
  agentId: string
  available: boolean
  unavailableReason?:
    | 'agent-not-ready'
    | 'unsupported-platform'
    | 'no-platform-tab'
    | 'multiple-platform-tabs'
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  truncated: boolean
  capturedAt?: string
  pageVisibility?: 'visible' | 'hidden' | 'unknown'
  pageHasFocus?: boolean | null
}

export interface SentinelDiagnostic {
  severity: SentinelLogSeverity
  code: string
  message: string
}

export type SentinelLogSeverity = 'error' | 'warning' | 'info'

export interface SentinelLogEntry {
  id: string
  timestamp: number
  severity: SentinelLogSeverity
  code: string
  agentId?: string
  message: string
}

export interface SentinelCheckResult {
  agentId: string
  debugPort: number
  portAlive: boolean
  swActive: boolean | null
  mcpAlive: boolean | null
  sessionMode?: AgentSessionMode
  masterSessionSourceId?: string
  masterSessionSourceName?: string
  saConfiguration?: {
    inspected: boolean
    mcpEnabled: boolean | null
    pushContentMode: boolean | null
    autoInsert: boolean | null
    autoSubmit: boolean | null
    autoExecute: boolean | null
    sidebarVisible: boolean | null
    compactButtonVisible: boolean | null
    compactButtonInComposer: boolean | null
    compactButtonWidth: number | null
    compactButtonHeight: number | null
    compactButtonLabelVisible: boolean | null
    sidebarCollapsed: boolean | null
    sidebarWidth: number | null
    pluginRegistry: {
      initialized: boolean
      activePlugin: string | null
      plugins: string[]
      factories: string[]
    } | null
    /** Current platform-tab visibility from the page's document, not OS foreground state. */
    pageVisibility?: 'visible' | 'hidden' | 'unknown'
    /** Current document.hasFocus() value; this does not prove the Chrome window is foreground. */
    pageHasFocus?: boolean | null
  } | null
  conversationFlow?: ConversationFlowSummary | null
  diagnostics: SentinelDiagnostic[]
}

// ─── Commands ────────────────────────────────────────────────────────────────
//
// Commands are imperative, one handler. They are separated by domain:
//   - Agent commands → MultiAgentRunner
//   - Execution commands → ExecutionQueryAdapter
// ─────────────────────────────────────────────────────────────────────────────

export type AgentCommand =
  | { type: 'command'; name: 'agent:start'; payload: { agentId: string; platformId: string; role?: string; sessionMode?: AgentSessionMode; masterSessionSourceId?: string; chromeProfileDirectory?: string } }
  | { type: 'command'; name: 'agent:sa-preparation-status'; payload: { agentId: string; preparing: boolean } }
  | { type: 'command'; name: 'agent:recover-existing'; payload: { platformId: string; sessionMode: AgentSessionMode; purpose: AgentRecoveryPurpose } }
  | { type: 'command'; name: 'agent:stop'; payload: { agentId: string } }
  | { type: 'command'; name: 'agent:restart'; payload: { agentId: string } }
  | { type: 'command'; name: 'agent:remove'; payload: { agentId: string } }

export type ExecutionCommand =
  | { type: 'command'; name: 'execution:acknowledge-unknown'; payload: { executionId: string; agentId: string } }

export type Command = AgentCommand | ExecutionCommand

export function isAgentCommand(cmd: Command): cmd is AgentCommand {
  return cmd.name.startsWith('agent:')
}

export function isExecutionCommand(cmd: Command): cmd is ExecutionCommand {
  return cmd.name.startsWith('execution:')
}

// ─── Events ──────────────────────────────────────────────────────────────────
//
// Events are declarative, many listeners. They are the ONLY mechanism by which
// RelayBus pushes state changes to the AppState store. No polling from the UI.
//
// Event emission comes from two sources:
//   1. MultiAgentRunner — after mutating WebInstanceRegistry
//   2. Sentinel — after detecting a condition (dead instance, unknown outcome)
// ─────────────────────────────────────────────────────────────────────────────

export type OrchestratorEvent =
  | { type: 'event'; name: 'agent:created'; payload: { agentId: string; platformId: string; role?: string; sessionMode?: AgentSessionMode; masterSessionSourceId?: string; chromeProfileDirectory?: string } }
  | { type: 'event'; name: 'agent:lifecycle'; payload: { agentId: string; from: AgentLifecycleStatus; to: AgentLifecycleStatus; error?: string } }
  | { type: 'event'; name: 'agent:stopped'; payload: { agentId: string } }
  | { type: 'event'; name: 'agent:error'; payload: { agentId: string; error: string; phase?: AgentLifecycleStatus } }
  | { type: 'event'; name: 'instance:bound'; payload: { agentId: string; instanceId: string; debugPort: number } }
  | { type: 'event'; name: 'instance:lost'; payload: { instanceId: string; agentId?: string } }
  | { type: 'event'; name: 'execution:update'; payload: { agentId: string; executionId: string; status: ExecutionStatus } }
  | { type: 'event'; name: 'execution:unknown'; payload: { agentId: string; executionId: string; reason: string } }
  | { type: 'event'; name: 'sentinel:heartbeat'; payload: { agentId: string; alive: boolean } }
  | { type: 'event'; name: 'sentinel:log'; payload: SentinelLogEntry }
  | {
      type: 'event'
      name: 'sentinel:scan'
      payload: {
        agentsChecked: number
        issuesFound: number
        healthy?: boolean
        scannedAt?: number
        details?: SentinelCheckResult[]
        logs?: SentinelLogEntry[]
      }
    }

// ─── Queries ─────────────────────────────────────────────────────────────────
//
// Queries are request-response and ALWAYS async. Many operations (port checks,
// CDP reads, health checks) are inherently asynchronous. We don't pretend
// otherwise. See architectural review correction #2.
// ─────────────────────────────────────────────────────────────────────────────

export type OrchestratorQuery =
  | { type: 'query'; name: 'agent:list'; payload?: undefined }
  | { type: 'query'; name: 'agent:status'; payload: { agentId: string } }
  | { type: 'query'; name: 'sentinel:status'; payload?: undefined }
  | { type: 'query'; name: 'sentinel:scan'; payload?: undefined }
  | { type: 'query'; name: 'sentinel:activity'; payload: { agentId: string } }
  | { type: 'query'; name: 'sentinel:conversation'; payload: { agentId: string } }
  | { type: 'query'; name: 'execution:list'; payload: { agentId: string } }
  | { type: 'query'; name: 'execution:inspect'; payload: { executionId: string; agentId: string } }
  | { type: 'query'; name: 'system:health'; payload?: undefined }

export type QueryResult<Q extends OrchestratorQuery> =
  Q extends { name: 'agent:list' } ? AgentState[] :
  Q extends { name: 'agent:status' } ? AgentState | null :
  Q extends { name: 'sentinel:status' } ? SentinelScanResult :
  Q extends { name: 'sentinel:scan' } ? SentinelScanResult :
  Q extends { name: 'sentinel:activity' } ? SentinelActivitySnapshot :
  Q extends { name: 'sentinel:conversation' } ? SentinelConversationSnapshot :
  Q extends { name: 'execution:list' } ? ExecutionSnapshot[] :
  Q extends { name: 'execution:inspect' } ? ExecutionSnapshot | null :
  Q extends { name: 'system:health' } ? SystemHealth :
  never

export interface SystemHealth {
  mcpServerRunning: boolean
  totalAgents: number
  runningAgents: number
  deadInstances: number
  unknownOutcomes: number
  timestamp: number
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export type { WebInstance } from '../WebInstanceRegistry.js'
