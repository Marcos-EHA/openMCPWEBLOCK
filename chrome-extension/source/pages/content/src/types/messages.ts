/**
 * Message type definitions for MCP communication
 * 
 * These types ensure consistency between the context bridge, MCP client, and background script
 */

import type { ServerConfig, ConnectionStatus, Tool } from './stores';

// Base message structure for all communication
export interface BaseMessage {
  type: string;
  payload?: any;
  origin: 'content' | 'background' | 'popup' | 'options';
  timestamp: number;
  id?: string;
}

// Request message structure
export interface RequestMessage<T = any> extends BaseMessage {
  payload: T;
  expectResponse?: boolean;
}

// Response message structure
export interface ResponseMessage<T = any> extends BaseMessage {
  payload?: T;
  error?: string;
  success?: boolean;
  processingTime?: number;
}

// MCP-specific message types and payloads

// Tool execution
/**
 * Stable logical identity for one tool call, minted in the content script
 * BEFORE the message crosses the bridge.
 *
 * The bridge retries a lost message up to four times with a fresh `message.id`
 * each attempt. When the background derived identity from `message.id`, every
 * retry became a brand-new execution and the tool ran again for real. The
 * caller now owns identity and it survives all transport retries.
 */
export interface CallToolRequest {
  toolName: string;
  args: Record<string, unknown>;
  /** REQUIRED for dedup. Stable across every transport retry of this call. */
  callId: string;
  instanceId?: string;
  agentId?: string;
  platformId?: string;
  contentSignature?: string;
}

export interface CallToolResponse {
  result: any;
}

export type WorkspaceContextCaptureRequest =
  | { action: 'status' }
  | {
      action: 'capture';
      role: 'user' | 'assistant';
      text: string;
      platformId: string;
      conversationId: string;
    }
  | {
      action: 'sentinel-review';
      role: 'user' | 'assistant';
      text: string;
      platformId: string;
      conversationId: string;
    };

export interface WorkspaceContextCaptureResponse {
  enabled?: boolean;
  captureEnabled?: boolean;
  sentinelReviewEnabled?: boolean;
  stored?: boolean;
  omitted?: boolean;
  reason?: string;
  eventId?: string;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}


// Persistent MCP execution state
export type ExecutionStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export interface WebExecution {
  executionKey: string;
  callId: string;
  instanceId?: string;
  agentId?: string;
  platformId?: string;
  tabId?: number;
  functionName: string;
  params: Record<string, unknown>;
  contentSignature?: string;
  status: ExecutionStatus;
  result?: unknown;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;

  // ─── Identity / lifecycle hardening (added by architecture review) ──────────
  // `executionKey` is an ADDRESS (scope + model-supplied callId). It is not
  // identity: the model reuses callIds freely, so an address may be re-pointed
  // over time. `executionId` is minted by the runtime and is the sole identity.
  executionId?: string;

  /** Boot epoch that owns this record. Lets us tell "running" from "running in a
   *  previous life of the service worker", which MV3 kills every ~30s. */
  bootId?: string;

  /** Physical attempt counter. 1:N with executionId. Never part of identity. */
  attempt?: number;

  /** Monotonic per-execution revision. settle() only accepts revision > current,
   *  which is what stops a late reconciliation from clobbering a fresh push. */
  revision?: number;

  /** Scope + tool + canonical args. Used ONLY for the dedup window, never for
   *  identity. Two legitimately distinct runs of `git status` must not collide. */
  idempotencyKey?: string;

  /** Declared side-effect class of the tool. `effectful` is never auto-retried. */
  effectClass?: 'pure' | 'idempotent-keyed' | 'effectful';

  /** Liveness is an ANNOTATION, not a status. An execution whose heartbeat was
   *  lost can still return a result, so `orphaned` must not be terminal. */
  livenessUnknown?: boolean;

  /** An effectful execution that timed out. We do NOT know whether the side
   *  effect landed. Requires escalation, never an automatic retry. */
  unknownOutcome?: boolean;

  /** Why the outcome is unknown. Shown to the human making the retry decision. */
  unknownReason?: string;

  /** Set when a human explicitly accepted the unknown outcome, unblocking the
   *  address for a new execution. Absence of this field is what makes
   *  `unknownOutcome` an interlock rather than a label. */
  unknownAcknowledgedAt?: number;

  /** Large results live outside the record; `result` holds a bounded projection.
   *  chrome.storage.local has a hard quota and inline results will exhaust it. */
  resultRef?: string;
  resultBytes?: number;
  resultTruncated?: boolean;
}

export interface StartExecutionRequest {
  toolName: string;
  args: Record<string, unknown>;
  callId: string;
  instanceId?: string;
  agentId?: string;
  platformId?: string;
  tabId?: number;
  contentSignature?: string;
  adapterName?: string;
}

export interface StartExecutionResponse {
  /**
   * IDENTITY. Stable for the life of this execution. Persist THIS, not the
   * address: an address can be re-pointed at a different execution, so a
   * content script holding only `executionKey` can be handed someone else's
   * result after a callId reuse or a service-worker restart.
   */
  executionId: string;
  /** ADDRESS. Kept for discovery and backward compatibility only. */
  executionKey: string;
  status: ExecutionStatus;
  /** True when the request matched an in-flight execution instead of creating one. */
  coalesced?: boolean;
  /** Set when the address is interlocked by an unacknowledged unknown outcome. */
  blockedByUnknownOutcome?: boolean;
  unknownReason?: string;
}

export interface GetExecutionRequest {
  /** Preferred. Resolves unambiguously and survives SW restarts. */
  executionId?: string;
  /** Fallback for records created before executionId was persisted. */
  executionKey?: string;
}

export interface ResumeExecutionRequest {
  executionId?: string;
  executionKey?: string;
}

export interface ReadFullResultRequest {
  executionId?: string;
  executionKey?: string;
}

export interface ReadFullResultResponse {
  result: string | null;
}

export interface AcknowledgeUnknownRequest {
  executionId: string;
}

export interface ResumeExecutionResponse {
  execution: WebExecution | null;
}

export interface GetExecutionResponse {
  execution: WebExecution | null;
}

export interface ExecutionUpdatedBroadcast {
  execution: WebExecution;
}

export interface GetConnectionStatusRequest {}

export interface GetConnectionStatusResponse {
  status: ConnectionStatus;
  isConnected: boolean;
  timestamp: number;
}

// Tools listing
export interface GetToolsRequest {
  forceRefresh?: boolean;
}

export interface GetToolsResponse {
  tools: Tool[];
}

// Force reconnect
export interface ForceReconnectRequest {}

export interface ForceReconnectResponse {
  isConnected: boolean;
  message?: string;
  error?: string;
}

// Server configuration
export interface GetServerConfigRequest {}

export interface GetServerConfigResponse {
  config: ServerConfig;
}

export interface UpdateServerConfigRequest {
  config: Partial<ServerConfig>;
}

export interface UpdateServerConfigResponse {
  success: boolean;
}

// Heartbeat
export interface HeartbeatRequest {
  timestamp: number;
}

export interface HeartbeatResponse {
  timestamp: number;
  isConnected: boolean;
  receivedTimestamp: number;
}

// Broadcast message types (one-way messages from background to content)

export interface ConnectionStatusChangedBroadcast {
  status: ConnectionStatus;
  error?: string;
  isConnected: boolean;
  timestamp: number;
}

export interface ToolUpdateBroadcast {
  tools: Tool[];
}

export interface ServerConfigUpdatedBroadcast {
  config: ServerConfig;
}

export interface HeartbeatResponseBroadcast {
  timestamp: number;
  isConnected: boolean;
}

// Message type union for better type safety
export type McpMessageType = 
  | 'mcp:call-tool'
  | 'mcp:workspace-context'
  | 'mcp:start-execution'
  | 'mcp:get-execution'
  | 'mcp:resume-execution'
  | 'mcp:read-full-result'
  | 'mcp:acknowledge-unknown'
  | 'mcp:execution-updated'
  | 'mcp:get-connection-status'
  | 'mcp:get-tools'
  | 'mcp:force-reconnect'
  | 'mcp:get-server-config'
  | 'mcp:update-server-config'
  | 'mcp:heartbeat'
  | 'connection:status-changed'
  | 'mcp:tool-update'
  | 'mcp:server-config-updated'
  | 'mcp:heartbeat-response';

// Utility type for request/response mapping
export interface McpMessageMap {
  'mcp:workspace-context': {
    request: WorkspaceContextCaptureRequest;
    response: WorkspaceContextCaptureResponse;
  };
  'mcp:call-tool': {
    request: CallToolRequest;
    response: CallToolResponse;
  };
  'mcp:start-execution': {
    request: StartExecutionRequest;
    response: StartExecutionResponse;
  };
  'mcp:get-execution': {
    request: GetExecutionRequest;
    response: GetExecutionResponse;
  };
  'mcp:resume-execution': {
    request: ResumeExecutionRequest;
    response: ResumeExecutionResponse;
  };
  'mcp:get-connection-status': {
    request: GetConnectionStatusRequest;
    response: GetConnectionStatusResponse;
  };
  'mcp:get-tools': {
    request: GetToolsRequest;
    response: GetToolsResponse;
  };
  'mcp:force-reconnect': {
    request: ForceReconnectRequest;
    response: ForceReconnectResponse;
  };
  'mcp:get-server-config': {
    request: GetServerConfigRequest;
    response: GetServerConfigResponse;
  };
  'mcp:update-server-config': {
    request: UpdateServerConfigRequest;
    response: UpdateServerConfigResponse;
  };
  'mcp:heartbeat': {
    request: HeartbeatRequest;
    response: HeartbeatResponse;
  };
}

// Error categories for better error handling
export enum ErrorCategory {
  CONNECTION_ERROR = 'connection_error',
  TOOL_ERROR = 'tool_error',
  VALIDATION_ERROR = 'validation_error',
  TIMEOUT_ERROR = 'timeout_error',
  UNKNOWN_ERROR = 'unknown_error'
}

// Enhanced error structure
export interface McpError {
  category: ErrorCategory;
  message: string;
  code?: string | number;
  context?: Record<string, any>;
  timestamp: number;
}

// Message validation helpers
export function isValidMessageType(type: string): type is McpMessageType {
  const validTypes: McpMessageType[] = [
    'mcp:call-tool', 'mcp:start-execution', 'mcp:get-execution', 'mcp:resume-execution', 'mcp:execution-updated',
    'mcp:get-connection-status',
    'mcp:get-tools',
    'mcp:force-reconnect',
    'mcp:get-server-config',
    'mcp:update-server-config',
    'mcp:heartbeat',
    'connection:status-changed',
    'mcp:tool-update',
    'mcp:server-config-updated',
    'mcp:heartbeat-response'
  ];
  
  return validTypes.includes(type as McpMessageType);
}

export function createRequestMessage<T extends keyof McpMessageMap>(
  type: T,
  payload: McpMessageMap[T]['request'],
  id?: string
): RequestMessage<McpMessageMap[T]['request']> {
  return {
    type,
    payload,
    origin: 'content',
    timestamp: Date.now(),
    id: id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
    expectResponse: true
  };
}

export function createResponseMessage<T extends keyof McpMessageMap>(
  type: T,
  payload: McpMessageMap[T]['response'],
  originalMessage: RequestMessage,
  success: boolean = true,
  processingTime?: number
): ResponseMessage<McpMessageMap[T]['response']> {
  return {
    type,
    payload,
    origin: 'background',
    timestamp: Date.now(),
    id: originalMessage.id,
    success,
    processingTime
  };
}

export function createErrorResponse(
  originalMessage: RequestMessage,
  error: string | McpError,
  processingTime?: number
): ResponseMessage {
  return {
    type: originalMessage.type,
    origin: 'background',
    timestamp: Date.now(),
    id: originalMessage.id,
    error: typeof error === 'string' ? error : error.message,
    success: false,
    processingTime
  };
}

export function createBroadcastMessage<T>(
  type: McpMessageType,
  payload: T
): BaseMessage {
  return {
    type,
    payload,
    origin: 'background',
    timestamp: Date.now()
  };
}
