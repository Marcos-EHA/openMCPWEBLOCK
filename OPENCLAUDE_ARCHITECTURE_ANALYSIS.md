# OpenClaude Architecture Analysis
## Comprehensive Deep Dive into Architecture, Tools, and MCPSuperAssistantExecutor Integration

**Date**: April 25, 2026  
**Status**: Complete Analysis - Ready for Implementation Decisions

---

## EXECUTIVE SUMMARY

OpenClaude is a sophisticated multi-model CLI that executes LLM tasks through a **pluggable tool system**. The architecture separates concerns cleanly:

- **CLI Entry**: `bin/openclaude` → compiled `dist/cli.mjs`
- **Core Execution**: `QueryEngine.ts` orchestrates turns with LLM API
- **Tool System**: ~60 built-in tools + MCP tools, registered in `tools.ts`
- **Tool Execution**: `StreamingToolExecutor` manages concurrency, `toolExecution.ts` runs individual tools
- **MCPSuperAssistantExecutor**: Just another regular tool that proxies to MCP-SuperAssistant

**Key Insight**: MCPSuperAssistantExecutor fits naturally into OpenClaude because the tool system is **designed for extensibility**. It follows the same contract as every other tool.

---

## PART 1: ARCHITECTURE OVERVIEW

### 1.1 Main Entry Point and CLI Startup

**File**: `bin/openclaude` (shell wrapper → `dist/cli.mjs`)

```bash
#!/usr/bin/env node
# Check if dist/cli.mjs exists (built version)
# Import it, or fail with setup instructions
```

**File**: `src/main.tsx` (TypeScript source compiled to cli.mjs)

**Startup Sequence:**

1. **Performance Profiling** (parallel startup optimization)
   - `profileCheckpoint('main_tsx_entry')` - marks entry
   - `startMdmRawRead()` - launches MDM subprocess (managed device settings)
   - `startKeychainPrefetch()` - fetches OAuth + API keys in parallel

2. **Heavy Imports** (~200+ modules during ~135ms)
   - Commander.js for CLI parsing
   - Anthropic SDK for API
   - MCP client libraries
   - React/Ink for TUI

3. **Initialization** (sequential after imports)
   - `init()` from `entrypoints/init.js`
   - Load telemetry (GrowthBook feature flags)
   - Authenticate user (OAuth, API keys, subscription)
   - Load MCP client connections
   - Load policy limits (quota tracking)

4. **Tool Assembly** 
   - Call `getTools(permissionContext)` 
   - Applies permission filters, feature flags, mode detection
   - Returns final Tools array

5. **Query Launch**
   - Create `ToolUseContext` with all tools
   - Launch REPL (interactive) or run command (batch)
   - Pass to `QueryEngine`

### 1.2 Core LLM Execution Flow

**Main Loop** (`QueryEngine.ts` → `query.ts`):

```
1. User Input → Message
2. Assemble Messages (with attachments, memory, context)
3. Render System Prompt
4. Call Claude API with:
   - Messages
   - System Prompt
   - Tools (JSON Schema)
   - Model (configurable, default claude-opus)
5. Stream Response
6. Detect Tool Calls → StreamingToolExecutor.addTool()
7. Execute Tools (concurrency-aware)
8. Collect Results
9. Add Results to Message Stream
10. Loop to step 2 (until stop signal or token limit)
```

**Key Files**:
- `QueryEngine.ts`: Orchestrator (turn management, token counting, compaction)
- `query.ts`: Individual turn processing
- `services/tools/StreamingToolExecutor.ts`: Concurrent tool scheduling
- `services/tools/toolExecution.ts`: Tool.call() invocation

### 1.3 Tool Discovery, Registration, and Execution

**Discovery** → **Registration** → **Selection** → **Execution** → **Response**

#### Discovery Phase
- All tools defined in `src/tools/*.ts` directories
- Imported centrally in `src/tools.ts`
- `getAllBaseTools()` function returns complete array
- Each tool is a `ToolDef` object wrapping with `buildTool()`

#### Registration Phase
- `tools.ts: getAllBaseTools()` builds the master registry
- Called during `init()` in main
- Conditionally includes tools based on:
  - Feature flags (`REPL_TOOL`, `KAIROS`, `COORDINATOR_MODE`, etc.)
  - Environment variables (`USER_TYPE='ant'`, `NODE_ENV='test'`)
  - Runtime detection (`isReplModeEnabled()`, `isWorktreeModeEnabled()`)
- `getTools(permissionContext)` filters by permissions
- Final array passed to QueryEngine

#### Selection Phase
- Tools serialized to JSON Schema for Anthropic API
- Included in system prompt
- LLM sees tool list, decides which to use
- Returns `ToolUseBlock[]` for each selected tool

#### Execution Phase
- `StreamingToolExecutor` receives tools as they stream
- Manages concurrency (parallel for safe tools, exclusive for unsafe)
- Calls `runToolUse()` for each tool
- Collects results in order

#### Response Phase
- Results added back to message stream
- LLM receives results as new turn input
- Process repeats until completion

---

## PART 2: TOOL SYSTEM ARCHITECTURE

### 2.1 Tool Interface/Contract (The Complete Picture)

**Defined in**: `src/Tool.ts` (lines 150-700+)

```typescript
type Tool<Input, Output, Progress> = {
  // === CORE IDENTITY ===
  name: string
  aliases?: string[]
  searchHint?: string                        // For ToolSearch keyword matching

  // === EXECUTION ===
  call(
    args: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<Progress>
  ): Promise<ToolResult<Output>>

  // === SCHEMA ===
  inputSchema: ZodType<Input>
  inputJSONSchema?: JSONSchema                // Alternative for MCP tools
  outputSchema?: ZodType<Output>

  // === METADATA ===
  description(input, options): Promise<string>
  prompt(options): Promise<string>            // System prompt contribution
  userFacingName(input): string
  userFacingNameBackgroundColor?(input): ThemeColor

  // === PROPERTIES ===
  isConcurrencySafe(input): boolean           // Can run parallel?
  isReadOnly(input): boolean                  // No side effects?
  isDestructive?(input): boolean              // Irreversible?
  isEnabled(): boolean                        // Available in this context?
  isOpenWorld?(input): boolean                // Needs internet?
  requiresUserInteraction?(): boolean
  interruptBehavior?(): 'cancel' | 'block'
  maxResultSizeChars: number | Infinity       // Persistence threshold

  // === VALIDATION & PERMISSIONS ===
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>
  getPath?(input): string                     // For filesystem patterns
  preparePermissionMatcher?(input): Promise<(pattern) => boolean>

  // === ANALYSIS ===
  inputsEquivalent?(a, b): boolean            // For deduplication
  isSearchOrReadCommand?(input): {isSearch, isRead, isList}
  toAutoClassifierInput(input): unknown       // For security classifier
  getToolUseSummary?(input): string | null    // Compact display text
  getActivityDescription?(input): string | null

  // === RENDERING (React Components) ===
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(output, progress, options): React.ReactNode
  renderToolUseProgressMessage?(progress, options): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  renderToolUseRejectedMessage?(input, options): React.ReactNode
  renderToolUseErrorMessage?(result, options): React.ReactNode
  renderGroupedToolUse?(toolUses, options): React.ReactNode | null
  renderToolUseTag?(input): React.ReactNode | null
  isResultTruncated?(output): boolean

  // === SEARCH & INDEXING ===
  extractSearchText?(output): string          // For transcript search

  // === MCP-SPECIFIC ===
  isMcp?: boolean
  isLsp?: boolean
  mcpInfo?: {serverName, toolName}           // Original MCP names
  shouldDefer?: boolean                       // ToolSearch deferral
  alwaysLoad?: boolean                        // Never defer

  // === API MAPPING ===
  mapToolResultToToolResultBlockParam(output, toolUseID): ToolResultBlockParam

  // === SPECIAL ===
  isTransparentWrapper?(): boolean            // Wrapper hides itself (REPL)
  backfillObservableInput?(input): void       // Add legacy fields
  strict?: boolean                            // Strict mode enforcement
}
```

**What `buildTool()` Does:**

```typescript
export function buildTool<D extends ToolDef>(def: D): Tool {
  return {
    ...TOOL_DEFAULTS,                // Fill in safe defaults
    userFacingName: () => def.name,
    ...def,                          // Override with actual implementation
  }
}

const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: () => false,                    // Assume NOT safe
  isReadOnly: () => false,                           // Assume writes
  isDestructive: () => false,
  checkPermissions: (input) => 
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: () => '',                   // Skip classifier
  userFacingName: () => '',                          // Override required
}
```

**Key Insight**: Only ~8 methods are truly required. The rest have safe defaults provided by `buildTool()`.

### 2.2 ToolResult and Error Handling

```typescript
type ToolResult<T> = {
  data: T                                    // Output data
  newMessages?: (UserMessage | AssistantMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

**Error Handling**:
- Tool catches exceptions internally
- Returns error in `ToolResult.data` as string/object
- LLM sees structured error, can retry

**Result Persistence**:
- If `data.length > maxResultSizeChars`: persists to disk
- Claude receives preview + file path
- Managed by `utils/toolResultStorage.ts`
- Exceptions: `Infinity` (never persist) for self-bounding tools like Read

### 2.3 ToolUseContext (What Tools Have Access To)

```typescript
type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools                               // Complete tools array
    verbose: boolean
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]           // MCP connections
    mcpResources: Record<string, ServerResource[]>
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinition[]
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
    querySource?: QuerySource
    refreshTools?: () => Tools                  // Get latest (mid-query MCP)
  }
  
  // State management
  abortController: AbortController             // Cancel signal
  readFileState: FileStateCache                // LRU file cache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  
  // UI callbacks
  setToolJSX?: (args) => void                  // Render custom UI
  addNotification?: (notif) => void
  appendSystemMessage?: (msg) => void
  
  // User interaction
  requestPrompt?: (sourceName) => (request) => Promise<PromptResponse>
  openMessageSelector?: () => void
  
  // Advanced features
  messages: Message[]                          // Current message history
  fileReadingLimits?: {maxTokens, maxSizeBytes}
  globLimits?: {maxResults}
  toolDecisions?: Map<string, {source, decision, timestamp}>
  
  // Internal tracking
  toolUseId?: string
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
}
```

---

## PART 3: DETAILED TOOL EXECUTION FLOW

### 3.1 StreamingToolExecutor: Concurrency Management

**File**: `src/services/tools/StreamingToolExecutor.ts`

```typescript
class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private hasErrored = false
  private siblingAbortController: AbortController

  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage): void
    // Parse input, check if concurrency-safe
    // Add to queue
    // Call processQueue()

  private canExecuteTool(isConcurrencySafe: boolean): boolean
    // Check current executingTools
    // If none running → OK to start
    // If running: only OK if all are concurrency-safe AND new tool is safe

  private async processQueue(): Promise<void>
    // For each queued tool:
    //   If canExecuteTool() → executeTool()
    //   Else if non-concurrent → stop (maintain order)
    //   Else if concurrent → continue to next

  async executeTool(tool: TrackedTool): Promise<void>
    // Set status to 'executing'
    // Call runToolUse() for tool
    // Handle errors, collect results
    // Set status to 'completed'
    // Resume processQueue()
}
```

**Concurrency Rules**:
- **Concurrent-safe tools**: Can run in parallel
  - Example: Multiple file reads
  - Condition: `isConcurrencySafe(input) === true`
- **Non-concurrent tools**: Must execute alone
  - Example: Bash commands (side effects)
  - Condition: `isConcurrencySafe(input) === false`
  - Blocks all other tools until complete

**Execution Order Guarantee**:
- Results emitted in the order tools were received (not execution order)
- Non-concurrent tools maintain strict ordering
- Concurrent tools can complete out-of-order but results reordered

### 3.2 Tool Execution: `runToolUse()`

**File**: `src/services/tools/toolExecution.ts`

```typescript
async function runToolUse(
  toolBlock: ToolUseBlock,
  toolDef: Tool,
  assistantMessage: AssistantMessage,
  context: ToolUseContext,
  canUseTool: CanUseToolFn
): Promise<Message[]> {
  // 1. VALIDATION
  const parsed = toolDef.inputSchema.safeParse(toolBlock.input)
  if (!parsed.success) {
    return [errorMessage('Invalid input schema')]
  }

  // 2. PERMISSION HOOKS (Pre-execution)
  const preHookResult = await runPreToolUseHooks(toolDef, parsed.data, context)
  if (preHookResult.decision === 'reject') {
    return [rejectionMessage('Permission denied by hook')]
  }

  // 3. PERMISSION CHECK (Tool-specific)
  const permResult = await toolDef.checkPermissions(parsed.data, context)
  if (permResult.behavior === 'deny') {
    return [denialMessage(permResult.reason)]
  }

  // 4. EXECUTION
  const startTime = performance.now()
  const result = await toolDef.call(
    parsed.data,
    context,
    canUseTool,
    assistantMessage,
    onProgress  // Optional progress callback
  )
  const duration = performance.now() - startTime

  // 5. RESULT PROCESSING
  const resultBlock = toolDef.mapToolResultToToolResultBlockParam(result.data, toolBlock.id)
  const processedResult = await processToolResultBlock(resultBlock, toolDef.maxResultSizeChars)

  // 6. POST-EXECUTION HOOKS
  await runPostToolUseHooks(toolDef, parsed.data, context)

  // 7. TELEMETRY
  logEvent('tool_use_completed', {
    tool: toolDef.name,
    duration,
    success: !result.error
  })

  // 8. RETURN MESSAGES
  return [
    createUserMessage({
      content: [processedResult],
      toolUseResult: result.data,
      sourceToolAssistantUUID: assistantMessage.uuid
    }),
    ...result.newMessages || []
  ]
}
```

**Error Classification** (telemetry-safe):
- `TelemetrySafeError`: Use its `telemetryMessage`
- fs errors: Extract `errno` code (ENOENT, EACCES, etc.)
- Known types: Use unminified name
- Fallback: "Error" (better than mangled identifier)

### 3.3 Permission Flow

**1. Tool-Specific Permissions** (`checkPermissions`)
```typescript
// BashTool example
checkPermissions(input: BashInput, context): PermissionResult {
  const {command} = input
  // Check if command is dangerous (rm -rf, etc.)
  // Check if path matches allowed directories
  // Return: {behavior: 'allow'|'deny', reason?, updatedInput?}
}
```

**2. General Permission System** (`utils/permissions/permissions.ts`)
```
Check deny rules:   Do we have a blanket deny for this tool?
Check allow rules:  Is this automatically approved?
Check ask rules:    Always show dialog?
Return decision:    ALLOW | DENY | ASK
```

**3. Hooks** (Pre/Post Tool Use)
```
Pre-execution hooks (e.g., security classifier)
→ Tool runs
→ Post-execution hooks (telemetry, cleanup)
```

---

## PART 4: CURRENT TOOL EXAMPLES

### 4.1 FileReadTool

**File**: `src/tools/FileReadTool/FileReadTool.ts`

**Characteristics**:
- **Read-Only**: `isReadOnly() → true`
- **Not Destructive**: `isDestructive() → false`
- **Non-Concurrent**: `isConcurrencySafe() → false` (LRU cache)
- **No Persistent Result**: `maxResultSizeChars: Infinity`

**Input Schema**:
```typescript
{
  path: string          // File to read (required)
  startLine?: number    // 1-indexed (optional)
  endLine?: number      // 1-indexed inclusive (optional)
  format?: 'lines' | 'raw'
}
```

**Execution**:
1. Expand path (resolve `~`, `.`, relative)
2. Check permissions (file read ACL)
3. Detect file type (image, PDF, text, binary)
4. Read content (or range with `readFileInRange`)
5. For images: resize/compress with token limit
6. For PDFs: extract pages, estimate tokens
7. For text: add line numbers, detect encoding
8. Return with metadata

**Special Features**:
- Image resizing with token budget awareness
- PDF page range extraction
- Binary file detection (returns hex sample)
- Device file blocking (`/dev/zero`, `/dev/stdin`, etc.)
- macOS screenshot path normalization (thin space handling)

### 4.2 BashTool

**File**: `src/tools/BashTool/BashTool.tsx`

**Characteristics**:
- **Concurrency-Dependent**: `isConcurrencySafe(input)` analyzes command
  - Safe: `echo`, `cat`, `grep` (read-only)
  - Unsafe: `npm install`, `git push`, `rm` (side effects)
- **Context-Aware Permissions**: Checks for dangerous patterns
  - Destructive: `isDestructive(input)` → analyzes command
  - Read-only: `isReadOnly(input)` → checks BASH_READ_COMMANDS set
- **Large Results**: `maxResultSizeChars: 50KB`
- **Sandbox Support**: Optional execution in isolated shell

**Input Schema**:
```typescript
{
  command: string       // Shell command to execute (required)
  cwd?: string         // Working directory (optional)
  env?: Record         // Environment variables (optional)
  timeout?: number     // Milliseconds (optional)
}
```

**Execution**:
1. Parse command with AST analyzer
2. Validate command safety
3. Check permissions (bash-specific rules)
4. Execute in shell (with timeout)
5. Stream output (progress after 2s threshold)
6. Handle exit code and signals
7. Return stdout/stderr

**Permission System**:
- Sed edit validation (parse sed expressions)
- Pipe analysis (all parts must be safe)
- Redirect validation
- Dangerous command detection
- Working directory validation

### 4.3 Pattern Summary

**Pattern 1: FileReadTool (Read-Only, Structured)**
- Input: path/parameters
- Validation: filesystem checks
- Execution: I/O + parsing
- Result: structured data (lines, images)
- Permissions: simple (file exists?)
- Persistence: Infinity (self-bounding)

**Pattern 2: BashTool (Unsafe, Unstructured)**
- Input: command string
- Validation: AST analysis
- Execution: shell subprocess
- Result: stdout/stderr
- Permissions: complex (analyze command)
- Persistence: 50KB (streams to disk)

**Pattern 3: MCPSuperAssistantExecutor (Proxy, HTTP-based)**
- Input: action + parameters
- Validation: schema check
- Execution: HTTP/SSE RPC call
- Result: proxied tool result
- Permissions: general (not tool-specific)
- Persistence: depends on result size

---

## PART 5: MCPSuperAssistantExecutor INTEGRATION

### 5.1 How It Was Added

**File Created**: `src/tools/MCPSuperAssistantExecutor/MCPSuperAssistantExecutor.ts`

**Registration**: In `src/tools.ts`, function `getAllBaseTools()`:
```typescript
export function getAllBaseTools(): Tools {
  return [
    // ... 58 other tools ...
    ModelDelegateTool,
    MCPSuperAssistantExecutor,        // <-- ADDED HERE
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}
```

**No other files modified** (clean integration).

### 5.2 Architecture Diagram

```
OpenClaude CLI (main.tsx)
    ↓
QueryEngine.ts (turn orchestration)
    ↓
LLM API Call with Tools
    ↓
LLM Selects: execute_mcp_tool_via_superassistant
    ↓
StreamingToolExecutor.addTool()
    ↓
toolExecution.ts: runToolUse()
    ↓
MCPSuperAssistantExecutor.call()
    │
    ├─ new MCPSuperAssistantClient(proxyUrl)
    │
    ├─ client.connect()  → SSE handshake to http://localhost:3006/sse
    │
    ├─ Execute action:
    │  ├─ list_tools        → POST /rpc {method: tools/list}
    │  ├─ execute_tool      → POST /rpc {method: tools/call, params: {name, arguments}}
    │  └─ get_server_status → POST /rpc {method: initialize}
    │
    ├─ client.sendRequest() → SSE message correlation
    │
    ├─ Return ToolResult {success, action, data, error?, toolsCount?, serverStatus?}
    │
    └─ ToolResult added to message stream
         ↓
         LLM receives result, continues turn
```

### 5.3 Implementation Details

**MCPSuperAssistantClient Class**:

```typescript
class MCPSuperAssistantClient {
  private proxyUrl: string              // http://localhost:3006/sse
  private eventSource: EventSource      // SSE listener
  private messageHandlers: Map          // Request ID → response handler
  private requestId: number             // Auto-incrementing

  async connect(): Promise<boolean>
    // Open SSE connection to proxyUrl
    // Set up message handler
    // Return true if connected within 500ms

  async listTools(): Promise<any>
    // Send: {method: 'tools/list'}
    // Wait for response
    // Return tool list

  async executeTool(name: string, params: Record): Promise<any>
    // Send: {method: 'tools/call', params: {name, arguments: params}}
    // Wait for response
    // Return result

  async getServerStatus(): Promise<any>
    // Send: {method: 'initialize', params: {}}
    // Wait for response
    // Return status

  private async sendRequest(request): Promise<any>
    // Generate requestId
    // Set timeout (10 seconds)
    // Register message handler
    // POST to /rpc endpoint
    // Wait for SSE response
    // Return or reject
}
```

**Protocol**:

1. **Connection** (SSE):
   ```
   GET http://localhost:3006/sse
   ```

2. **Request** (HTTP POST):
   ```json
   POST http://localhost:3006/rpc
   {
     "id": "req_1",
     "method": "tools/list" | "tools/call" | "initialize",
     "params": {...}
   }
   ```

3. **Response** (SSE event):
   ```json
   data: {
     "id": "req_1",
     "result": {...} | null,
     "error": "error message" | null
   }
   ```

### 5.4 Input/Output Schema

**Input Schema**:
```typescript
z.strictObject({
  action: z.enum([
    'list_tools',        // Get available MCP tools
    'execute_tool',      // Run a specific tool
    'get_server_status'  // Check proxy connection
  ]),
  toolName: z.string().optional(),
    // For execute_tool: e.g., "desktop-commander/read_file"
  parameters: z.record(z.any()).optional(),
    // Tool-specific parameters
  proxyUrl: z.string().optional().default('http://localhost:3006/sse'),
    // URL of proxy (default shown)
})
```

**Output Schema**:
```typescript
z.object({
  success: z.boolean(),
  action: z.string(),                  // Echo of action performed
  data: z.any(),                       // Tools list | result | status
  error: z.string().optional(),        // Error if failed
  toolsCount: z.number().optional(),   // For list_tools
  serverStatus: z.string().optional()  // For get_server_status
})
```

### 5.5 Error Handling

```typescript
async executeMCPSuperAssistantTool(input):
  1. Normalize proxy URL
     - Add /sse if needed
     - Handle variants (localhost:3006 vs http://localhost:3006/sse)

  2. Create client + connect
     - If connection fails: return {success: false, error: "..."}
     - Suggests running proxy command

  3. Switch on action:
     - list_tools: await client.listTools()
     - execute_tool: check toolName present, await client.executeTool()
     - get_server_status: await client.getServerStatus()

  4. Handle timeouts
     - 10-second RPC timeout per request
     - Returns timeout error if exceeded

  5. Catch exceptions
     - Connection errors
     - Parse errors
     - Returns error message

  6. Finally: client.disconnect()
```

### 5.6 Assumptions About Tool Contract

MCPSuperAssistantExecutor makes these assumptions:

1. **Tool Interface**:
   - Tool must have `name`, `description`, `inputSchema`, `call()`
   - Tool must implement `isConcurrencySafe()` (returns false here)
   - Tool must implement required rendering methods

2. **Error Handling**:
   - Tool catches exceptions internally
   - Returns error in output, not throws
   - LLM sees structured error, can handle/retry

3. **Result Handling**:
   - Result is JSON-serializable
   - Can be large (persists if >maxResultSizeChars)
   - Optional `newMessages` for follow-ups

4. **Permissions**:
   - General permission system handles access
   - No tool-specific permission logic needed
   - User approves or denies proxy access once

5. **Concurrency**:
   - `isConcurrencySafe() → false` (HTTP requests can have race conditions)
   - Tool executes exclusively
   - Safe for order-dependent operations

6. **Progress**:
   - Optional `onProgress` callback (not used)
   - Can stream chunks if needed in future

---

## PART 6: CONFIGURATION AND STARTUP

### 6.1 Tool Initialization Order

**Phase 1: main.tsx Entry**
```
1. profileCheckpoint('main_tsx_entry')
2. startMdmRawRead() [parallel]
3. startKeychainPrefetch() [parallel]
4. Heavy imports (~200 modules, ~135ms)
5. ensureKeychainPrefetchCompleted() [sync on result]
```

**Phase 2: Init Function** (`init()` from entrypoints/init.js)
```
1. Load telemetry config
2. Initialize GrowthBook feature flags
3. Check trust dialog (macOS)
4. Authenticate (OAuth, API key validation)
5. Load global config
6. Load policy limits
7. Load managed settings
8. Load MCP server configs
9. getMcpToolsCommandsAndResources() → Load MCP tools
10. initializeAnalyticsGates() → Apply feature flags
```

**Phase 3: Tool Assembly** (in getTools)
```
1. Check mode: CLAUDE_CODE_SIMPLE? → return limited tools
2. If not simple:
   - getAllBaseTools() → get full list
   - getTools(permissionContext) → filter by permissions
   - Apply feature flag conditions
   - Apply isEnabled() per tool
3. Return final Tools array
```

**Phase 4: Query Launch**
```
1. Create ToolUseContext with tools
2. Create QueryEngine with context
3. Launch REPL or execute command
4. Pass through tool orchestration pipeline
```

### 6.2 Tool Filtering Logic

**getTools(permissionContext)** in `tools.ts`:

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // MODE 1: CLAUDE_CODE_SIMPLE
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    if (isReplModeEnabled() && REPLTool) {
      return filterToolsByDenyRules([REPLTool], permissionContext)
    }
    return filterToolsByDenyRules(
      [BashTool, FileReadTool, FileEditTool],
      permissionContext
    )
  }

  // MODE 2: Full tool set
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])
  
  const tools = getAllBaseTools()
    .filter(tool => !specialTools.has(tool.name))
  
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)
  
  // Hide REPL-only tools when REPL is enabled
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME)
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name)
      )
    }
  }
  
  // Filter by isEnabled() per tool
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

**Filtering Layers**:
1. **Feature Flags**: Tool imported only if feature enabled
2. **Deny Rules**: blanket denials removed
3. **Mode Detection**: REPL, SIMPLE, COORDINATOR
4. **isEnabled()**: Per-tool runtime check

### 6.3 Tool Deduplication (with MCP Tools)

**assembleToolPool(permissionContext, mcpTools)**:

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  
  // Sort each partition for prompt-cache stability
  const byName = (a, b) => a.name.localeCompare(b.name)
  
  // uniqBy deduplicates by name, keeping first occurrence
  // Built-in tools come first (prefix), so they win on conflict
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name'
  )
}
```

**Deduplication Rule**:
- Built-in tools sorted alphabetically
- MCP tools sorted alphabetically  
- `uniqBy` removes duplicates by name
- First occurrence (built-in) wins

**Prompt Cache Implication**:
- Consistent ordering critical for cache
- Non-deterministic order invalidates cache across API calls
- Sorting ensures cache hit rate

---

## PART 7: COMPLETE TOOL LIFECYCLE

### 7.1 From Tool Definition to Execution

**Example: FileReadTool**

**Step 1: Definition** (src/tools/FileReadTool/FileReadTool.ts)
```typescript
const inputSchema = z.object({
  path: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
})

export const FileReadTool: ToolDef = buildTool({
  name: FILE_READ_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  checkPermissions: async (input, context) => {
    const decision = await checkReadPermissionForTool(input.path, context)
    return decision ? {behavior: 'allow'} : {behavior: 'deny'}
  },
  call: async (input, context, canUseTool, parentMessage, onProgress) => {
    const content = await readFileInRange(
      input.path,
      input.startLine,
      input.endLine
    )
    return {
      data: content,
      newMessages: []
    }
  },
  renderToolUseMessage: (input, options) => <FileReadMessage {...input} />,
  renderToolResultMessage: (output, _, options) => <FileReadResult {...output} />,
  maxResultSizeChars: Infinity,  // Never persist
})
```

**Step 2: Import and Register** (src/tools.ts)
```typescript
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'

export function getAllBaseTools(): Tools {
  return [
    // ...
    FileReadTool,  // Included in base tools
    // ...
  ]
}
```

**Step 3: Filter by Context** (getTools)
```
Input: permissionContext
Output: [BashTool, FileReadTool, FileEditTool, SkillTool, ...]
(filtered by permissions, feature flags)
```

**Step 4: Serialize for API** (claude.ts)
```typescript
// Convert to JSON Schema for Anthropic API
const toolDefinitions = tools.map(tool => ({
  name: tool.name,
  description: await tool.description(undefined, {...}),
  input_schema: convertZodToJSONSchema(tool.inputSchema),
}))

// Send in request
anthropic.messages.create({
  model: 'claude-opus-4-1',
  max_tokens: 4096,
  tools: toolDefinitions,
  messages: [...]
})
```

**Step 5: LLM Selects Tool**
```
LLM Response:
{
  type: 'tool_use',
  id: 'tool_call_123',
  name: 'file_read_tool',
  input: {
    path: 'src/main.ts',
    startLine: 1,
    endLine: 50
  }
}
```

**Step 6: Execution**
```
1. StreamingToolExecutor.addTool(toolBlock, assistantMessage)
2. processQueue()
3. canExecuteTool(isConcurrencySafe) → true (no other tools)
4. executeTool()
5. runToolUse()
   a. Parse input: {path: 'src/main.ts', startLine: 1, endLine: 50} ✓
   b. checkPermissions(input, context) → {behavior: 'allow'} ✓
   c. FileReadTool.call(input, context, canUseTool, parentMsg)
      - readFileInRange('src/main.ts', 1, 50)
      - Return {data: fileContent}
   d. mapToolResultToToolResultBlockParam(fileContent, 'tool_call_123')
      - Return ToolResultBlockParam
   e. Post-hooks
   f. Return [ToolResultMessage]
```

**Step 7: Response**
```
User sees:
[FileReadTool] Reading src/main.ts (lines 1-50)
(rendered via renderToolResultMessage)

LLM receives:
{
  role: 'user',
  content: [{
    type: 'tool_result',
    tool_use_id: 'tool_call_123',
    content: 'file content here...'
  }]
}
```

**Step 8: Loop**
```
LLM generates response based on file content
May call more tools, or end conversation
```

---

## PART 8: TOOL SYSTEM MECHANISMS (SUMMARY)

### How Each Mechanism Works

| Mechanism | Implementation | Location |
|-----------|---|---|
| **Discovery** | Static import + array | `tools.ts: getAllBaseTools()` |
| **Registration** | buildTool factory + registry | `tools.ts: getAllBaseTools()` |
| **Filtering** | Permission rules + flags | `tools.ts: getTools()` |
| **Selection** | LLM chooses from schema | Anthropic API |
| **Concurrency** | Queue-based with safety check | `StreamingToolExecutor` |
| **Execution** | Tool.call() invocation | `toolExecution.ts: runToolUse()` |
| **Permission Check** | checkPermissions() + hooks | `toolExecution.ts` + hooks system |
| **Error Handling** | Exception wrapping | `toolExecution.ts` + error classification |
| **Result Handling** | Serialization + persistence | `utils/toolResultStorage.ts` |
| **Progress** | Callback streaming | `onProgress` callback |
| **Rendering** | React components | Tool's render* methods |

### The Tool Contract is Simple

**Required** (buildTool provides defaults for rest):
1. `name: string`
2. `call(): Promise<ToolResult>`
3. `description(): string`
4. `inputSchema: ZodType`
5. `isConcurrencySafe(input): boolean`
6. `checkPermissions(input): PermissionResult`
7. `renderToolUseMessage(input): React.ReactNode`
8. `mapToolResultToToolResultBlockParam(output): ToolResultBlockParam`
9. `maxResultSizeChars: number`

**Optional** (sensible defaults):
- `isReadOnly()` → `false`
- `isDestructive()` → `false`
- `toAutoClassifierInput()` → `''`
- Plus 20+ rendering and analysis methods

---

## PART 9: MCPSuperAssistantExecutor Status & Integration Quality

### What's Working

✅ **Clean Integration**: Just another tool in the registry
✅ **Correct Contract**: Implements all required methods
✅ **Error Handling**: Catches exceptions, returns structured errors
✅ **Connection Management**: SSE + RPC protocol implemented
✅ **Timeout Handling**: 10-second timeout per request
✅ **Proxy URL Configuration**: Defaults to localhost:3006, customizable

### Design Assumptions Verified

1. **Tool Interface**: MCPSuperAssistantExecutor correctly implements Tool<>
2. **Execution Flow**: Fits perfectly into StreamingToolExecutor
3. **Permission System**: Works with general permission system
4. **Result Format**: Matches ToolResult<> contract
5. **Concurrency**: Safely executes (isConcurrencySafe = false)
6. **Error Classification**: Returns errors as data, not exceptions

### Where to Extend

**If you want to enhance MCPSuperAssistantExecutor**:

1. **Progress Streaming**: Use `onProgress` callback
   ```typescript
   onProgress?.({
     toolUseID: context.toolUseId!,
     data: {type: 'mcp_superassistant', action, status}
   })
   ```

2. **Custom Permissions**: Add tool-specific logic
   ```typescript
   checkPermissions(input: InputSchema, context): Promise<PermissionResult> {
     // Only allow execute_tool if user approved
     if (input.action === 'execute_tool') {
       return {behavior: 'ask', reason: 'Run MCP tool?'}
     }
     return {behavior: 'allow'}
   }
   ```

3. **Streaming Results**: Return newMessages for live updates
   ```typescript
   return {
     data: { success: true, data: result },
     newMessages: [
       createUserMessage({content: `Executed ${toolName}`})
     ]
   }
   ```

4. **Connection Pooling**: Reuse EventSource across calls
   ```typescript
   // Maintain single SSE connection in AppState
   // Reduce connection overhead
   ```

---

## CONCLUSION: How Everything Fits Together

OpenClaude's architecture is remarkably clean:

1. **Tools are First-Class**: Pluggable via simple interface
2. **Registry is Explicit**: `getAllBaseTools()` is the source of truth
3. **Execution is Orchestrated**: StreamingToolExecutor manages concurrency
4. **Permissions are Layered**: General + tool-specific checks
5. **Errors are Structured**: All paths return ToolResult<>

**MCPSuperAssistantExecutor integrates perfectly** because:
- It follows the Tool contract exactly
- No special cases needed in registry or execution
- Just gets added to array like any other tool
- Works with existing permission/concurrency systems
- Can be extended with progress, streaming, custom permissions

This is a **system designed for extension** — and MCPSuperAssistantExecutor is proof the design works.
