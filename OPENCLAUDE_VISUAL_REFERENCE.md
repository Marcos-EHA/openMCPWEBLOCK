# OpenClaude Architecture - Quick Reference & Visual Diagrams

## Quick Reference: Key Files & Locations

### Core Architecture
- **Entry Point**: `bin/openclaude` → `dist/cli.mjs` (compiled from `src/main.tsx`)
- **Query Orchestrator**: `src/QueryEngine.ts` (turn management, token counting)
- **Turn Processing**: `src/query.ts` (single turn logic)
- **Tool Registry**: `src/tools.ts` (getAllBaseTools, getTools)
- **Tool Base Class**: `src/Tool.ts` (Tool<> interface, buildTool factory)

### Tool Execution Pipeline
- **Concurrency Manager**: `src/services/tools/StreamingToolExecutor.ts`
- **Tool Execution**: `src/services/tools/toolExecution.ts` (runToolUse)
- **Tool Hooks**: `src/services/tools/toolHooks.ts` (pre/post execution)
- **Permission System**: `src/utils/permissions/` (filesystem, bash, etc.)

### Example Tools
- **FileReadTool**: `src/tools/FileReadTool/FileReadTool.ts` (read-only, structured)
- **BashTool**: `src/tools/BashTool/BashTool.tsx` (unsafe, unstructured, complex)
- **MCPSuperAssistantExecutor**: `src/tools/MCPSuperAssistantExecutor/MCPSuperAssistantExecutor.ts` (proxy)

### Supporting Services
- **MCP Client**: `src/services/mcp/client.js`
- **API Client**: `src/services/api/claude.js` (Anthropic SDK wrapper)
- **Token Estimation**: `src/services/tokenEstimation.ts`
- **Result Storage**: `src/utils/toolResultStorage.ts` (disk persistence)

---

## Visual Diagram 1: Message Flow Through One Turn

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Input                                   │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    QueryEngine.runTurn()                            │
│                                                                     │
│  1. Assemble Messages (attachments, memory, context)               │
│  2. Render System Prompt (from all tools)                          │
│  3. Apply Token Limits (compaction if needed)                      │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│          Call Claude API (anthropic.messages.create)               │
│                                                                     │
│  Input:                                                             │
│  - messages: Message[]                                              │
│  - system: string (includes tool descriptions)                     │
│  - tools: Tool[] (serialized to JSON Schema)                       │
│  - model: 'claude-opus-4-1'                                         │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│                 LLM Generates Response                              │
│                                                                     │
│  Response blocks:                                                   │
│  - text: "I'll read the file..."                                   │
│  - tool_use: {id, name, input}                                     │
│  - tool_use: {id, name, input} (multiple calls OK)                 │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│             StreamingToolExecutor.addTool() per tool_use            │
│                                                                     │
│  For each tool_use block:                                           │
│  1. Find tool by name: findToolByName(tools, block.name)           │
│  2. Check concurrency: tool.isConcurrencySafe(input)              │
│  3. Add to queue                                                    │
│  4. Trigger processQueue()                                          │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│         StreamingToolExecutor.processQueue()                        │
│                                                                     │
│  For each queued tool:                                              │
│  - canExecuteTool(isConcurrencySafe)?                              │
│    ├─ No other tools running → START                              │
│    ├─ All running tools concurrent-safe & new tool safe → START   │
│    └─ Non-concurrent tool running → WAIT                          │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│      toolExecution.runToolUse(toolBlock, toolDef, context)         │
│                                                                     │
│  1. Parse input: toolDef.inputSchema.safeParse(toolBlock.input)   │
│  2. Run pre-execution hooks                                         │
│  3. Check permissions: toolDef.checkPermissions(input, context)    │
│  4. Execute: await toolDef.call(input, context, ...)             │
│  5. Map result: toolDef.mapToolResultToToolResultBlockParam(...)  │
│  6. Persist if large: (if data.length > maxResultSizeChars)       │
│  7. Run post-execution hooks                                        │
│  8. Return [ToolResultMessage]                                     │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│            Collect Results, Add to Message Stream                   │
│                                                                     │
│  Messages now: [                                                    │
│    {...previous messages},                                          │
│    {role: 'assistant', content: [{text}, {tool_use}, ...]},        │
│    {role: 'user', content: [{tool_result}, {tool_result}, ...]}    │
│  ]                                                                   │
└─────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────┐
│                  Loop or Stop?                                      │
│                                                                     │
│  If stop_reason === 'end_turn':                                    │
│    ├─ Return response to user                                       │
│    └─ Display in REPL                                               │
│                                                                     │
│  Else (more tools needed):                                          │
│    └─ Go back to "Call Claude API" with new messages               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Visual Diagram 2: Tool System Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        TOOL SYSTEM ARCHITECTURE                          │
└──────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  DISCOVERY PHASE (Build Time / Startup)                                 │
│                                                                         │
│  src/tools/FileReadTool/FileReadTool.ts                                │
│  src/tools/BashTool/BashTool.tsx                                       │
│  src/tools/MCPSuperAssistantExecutor/MCPSuperAssistantExecutor.ts      │
│  ... 57 other tools ...                                                 │
│                                                                         │
│  Each file exports a ToolDef                                            │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  REGISTRATION PHASE (in tools.ts)                                       │
│                                                                         │
│  export function getAllBaseTools(): Tools {                            │
│    return [                                                             │
│      FileReadTool,                                                      │
│      BashTool,                                                          │
│      MCPSuperAssistantExecutor,    ← Just another tool!               │
│      ...                                                                │
│    ]                                                                    │
│  }                                                                      │
│                                                                         │
│  Each tool wrapped via buildTool():                                    │
│    {                                                                    │
│      ...TOOL_DEFAULTS,  ← Sensible defaults for optional methods      │
│      ...toolDefinition  ← Tool's custom implementation                 │
│    }                                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  FILTERING PHASE (in getTools)                                          │
│                                                                         │
│  1. Check mode: CLAUDE_CODE_SIMPLE?                                    │
│     └─ Return limited set [BashTool, FileReadTool, FileEditTool]      │
│                                                                         │
│  2. Or full set:                                                        │
│     ├─ getAllBaseTools()                                               │
│     ├─ Filter by deny rules (permissions)                              │
│     ├─ Filter by feature flags                                         │
│     ├─ Filter by isEnabled() per tool                                  │
│     └─ Return final array                                              │
│                                                                         │
│  3. Optional: assembleToolPool(builtIn, mcpTools)                      │
│     ├─ Combine built-in + MCP tools                                    │
│     ├─ Deduplicate by name (built-in wins)                             │
│     └─ Sort for prompt cache stability                                 │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  SERIALIZATION PHASE (in claude.ts)                                     │
│                                                                         │
│  toolDefinitions = await Promise.all(tools.map(async tool => ({       │
│    name: tool.name,                                                     │
│    description: await tool.description(undefined, {...}),             │
│    input_schema: convertZodToJSONSchema(tool.inputSchema)             │
│  })))                                                                   │
│                                                                         │
│  Send to API:                                                           │
│  {                                                                      │
│    model: 'claude-opus-4-1',                                            │
│    messages: [...],                                                     │
│    tools: toolDefinitions                                              │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  SELECTION PHASE (LLM Decision)                                         │
│                                                                         │
│  Claude sees all tools, decides:                                        │
│  "I'll use file_read_tool to read the config"                         │
│  "Then I'll use bash_tool to run tests"                               │
│  "Finally execute_mcp_tool_via_superassistant to send Slack msg"     │
│                                                                         │
│  Returns:                                                               │
│  [                                                                      │
│    {type: 'tool_use', id: 'x1', name: 'file_read_tool', input: {...}},
│    {type: 'tool_use', id: 'x2', name: 'bash_tool', input: {...}},    │
│    {type: 'tool_use', id: 'x3', name: 'execute_mcp_tool_via...', ...}│
│  ]                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  EXECUTION PHASE (StreamingToolExecutor + toolExecution)                │
│                                                                         │
│  StreamingToolExecutor:                                                 │
│    ├─ addTool(toolBlock1) → queued                                    │
│    ├─ addTool(toolBlock2) → queued                                    │
│    ├─ addTool(toolBlock3) → queued                                    │
│    └─ processQueue()                                                    │
│       ├─ toolBlock1: isConcurrencySafe? → execute if ok               │
│       ├─ toolBlock2: canExecute? → wait or execute                    │
│       └─ toolBlock3: canExecute? → wait or execute                    │
│                                                                         │
│  For each tool:                                                         │
│    1. Validate input                                                    │
│    2. Check permissions                                                │
│    3. Execute tool.call()                                              │
│    4. Collect result                                                   │
│    5. Return [ToolResultMessage]                                       │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  RESPONSE PHASE (Back to LLM)                                           │
│                                                                         │
│  Add results to message stream:                                         │
│  [                                                                      │
│    {...previous},                                                       │
│    {role: 'assistant', content: [text, tool_use, tool_use, ...]},    │
│    {role: 'user', content: [tool_result, tool_result, ...]}           │
│  ]                                                                      │
│                                                                         │
│  Loop: Send back to Claude → More tools? → Execute → ...              │
│                                                                         │
│  Until: stop_reason === 'end_turn'                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Visual Diagram 3: MCPSuperAssistantExecutor Call Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MCPSuperAssistantExecutor Integration Point                            │
│                                                                         │
│  In tools.ts: getAllBaseTools() returns:                                │
│  [                                                                      │
│    FileReadTool,                                                        │
│    BashTool,                                                            │
│    MCPSuperAssistantExecutor,   ← Just another ToolDef                │
│    ...                                                                  │
│  ]                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Tool Definition (MCPSuperAssistantExecutor.ts)                         │
│                                                                         │
│  export const MCPSuperAssistantExecutor = buildTool({                  │
│    name: 'execute_mcp_tool_via_superassistant',                       │
│    description: DESCRIPTION,                                            │
│    inputSchema,                                                         │
│    outputSchema,                                                        │
│    execute: executeMCPSuperAssistantTool,  ← Main function            │
│    renderToolUseMessage,                                                │
│    renderToolResultMessage,                                             │
│  })                                                                     │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  LLM Calls Tool                                                         │
│                                                                         │
│  {                                                                      │
│    type: 'tool_use',                                                   │
│    id: 'tool_x',                                                        │
│    name: 'execute_mcp_tool_via_superassistant',                       │
│    input: {                                                             │
│      action: 'execute_tool',                                           │
│      toolName: 'desktop-commander/read_file',                         │
│      parameters: {path: '/home/user/config.json'},                    │
│      proxyUrl: 'http://localhost:3006'  (optional)                    │
│    }                                                                    │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  toolExecution.runToolUse() Invokes                                      │
│                                                                         │
│  1. Validate: inputSchema.safeParse({action, toolName, ...})          │
│  2. Permissions: checkPermissions(input, context)                      │
│  3. Execute: MCPSuperAssistantExecutor.call(input, context, ...)      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  executeMCPSuperAssistantTool(input) Main Function                      │
│                                                                         │
│  1. Normalize proxyUrl                                                  │
│  2. Create MCPSuperAssistantClient(normalizedUrl)                      │
│  3. await client.connect()  ← SSE handshake                            │
│     └─ Opens: GET http://localhost:3006/sse                           │
│     └─ Sets up message handlers                                        │
│  4. Switch on action:                                                   │
│     ├─ 'list_tools':        client.listTools()                        │
│     ├─ 'execute_tool':      client.executeTool(toolName, params)      │
│     └─ 'get_server_status': client.getServerStatus()                  │
│  5. Return ToolResult {success, action, data, error?, ...}            │
│  6. Finally: client.disconnect()                                       │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  MCPSuperAssistantClient Methods                                        │
│                                                                         │
│  connect():                                                             │
│    ├─ new EventSource('http://localhost:3006/sse')                    │
│    ├─ Set onmessage handler                                            │
│    ├─ Set onerror handler                                              │
│    └─ setTimeout 500ms for connection                                  │
│                                                                         │
│  sendRequest(request):                                                  │
│    ├─ Generate requestId: 'req_N'                                      │
│    ├─ Register messageHandler(id)                                      │
│    ├─ POST to 'http://localhost:3006/rpc':                            │
│    │  {                                                                 │
│    │    "id": "req_1",                                                 │
│    │    "method": "tools/list" | "tools/call" | "initialize",        │
│    │    "params": {...}                                                │
│    │  }                                                                 │
│    └─ Wait for SSE response with matching id                          │
│                                                                         │
│  listTools():                                                           │
│    └─ sendRequest({method: 'tools/list'})                             │
│                                                                         │
│  executeTool(toolName, parameters):                                    │
│    └─ sendRequest({                                                    │
│         method: 'tools/call',                                          │
│         params: {name: toolName, arguments: parameters}               │
│       })                                                                │
│                                                                         │
│  getServerStatus():                                                     │
│    └─ sendRequest({method: 'initialize', params: {}})                 │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Proxy Server (MCP-SuperAssistant, running on localhost:3006)           │
│                                                                         │
│  GET /sse → EventSource stream (for responses)                         │
│  POST /rpc → Receives {id, method, params}                            │
│                                                                         │
│  Routes to actual MCP servers:                                          │
│  ├─ Desktop Commander                                                   │
│  ├─ GitHub                                                              │
│  ├─ Slack                                                               │
│  └─ etc.                                                                │
│                                                                         │
│  Sends back via SSE:                                                    │
│  {                                                                      │
│    "id": "req_1",                                                       │
│    "result": {...} | null,                                             │
│    "error": "message" | null                                           │
│  }                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  Result Returns to LLM                                                  │
│                                                                         │
│  ToolResult {                                                           │
│    success: true,                                                       │
│    action: 'execute_tool',                                             │
│    data: {                                                              │
│      // Result from desktop-commander/read_file or other MCP tool     │
│    },                                                                   │
│    toolsCount: 15  (if list_tools),                                   │
│    serverStatus: 'connected'  (if get_server_status)                  │
│  }                                                                      │
│                                                                         │
│  Added to message stream:                                               │
│  {role: 'user', content: [{tool_result, content: JSON, id: 'tool_x'}]}│
│                                                                         │
│  LLM sees result, continues conversation                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Visual Diagram 4: Tool Interface Contract

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Tool<Input, Output, Progress>                       │
└──────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  REQUIRED (No Defaults)                                                 │
│                                                                         │
│  ✓ name: string                                                         │
│    └─ Unique identifier: 'file_read_tool', 'bash_tool', ...            │
│                                                                         │
│  ✓ call(input, context, canUseTool, parent, onProgress?):             │
│      Promise<ToolResult<Output>>                                        │
│    └─ Execute the tool                                                 │
│    └─ Catch exceptions, return as result                               │
│                                                                         │
│  ✓ description(input, options): Promise<string>                        │
│    └─ Generated from template for system prompt                        │
│                                                                         │
│  ✓ inputSchema: ZodType                                                 │
│    └─ Validates input before execution                                 │
│                                                                         │
│  ✓ isConcurrencySafe(input): boolean                                   │
│    └─ Can run parallel with other tools?                              │
│                                                                         │
│  ✓ checkPermissions(input, context): PermissionResult                  │
│    └─ Tool-specific permission logic                                   │
│                                                                         │
│  ✓ isReadOnly(input): boolean                                          │
│    └─ No side effects?                                                 │
│                                                                         │
│  ✓ renderToolUseMessage(input, options): React.ReactNode              │
│    └─ Render tool input for display                                    │
│                                                                         │
│  ✓ mapToolResultToToolResultBlockParam(output, id): Block             │
│    └─ Convert result to API format                                     │
│                                                                         │
│  ✓ maxResultSizeChars: number | Infinity                              │
│    └─ Persistence threshold                                            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  OPTIONAL (buildTool Provides Defaults)                                 │
│                                                                         │
│  ? isEnabled(): boolean                                                 │
│    └─ Default: true                                                    │
│    └─ Disable tool in certain contexts                                 │
│                                                                         │
│  ? isDestructive(input): boolean                                        │
│    └─ Default: false                                                   │
│    └─ Irreversible operations (delete, overwrite)                      │
│                                                                         │
│  ? isConcurrencySafe(input): boolean                                   │
│    └─ Default: false (assume NOT safe)                                 │
│                                                                         │
│  ? toAutoClassifierInput(input): unknown                               │
│    └─ Default: ''                                                      │
│    └─ Security classifier representation                               │
│                                                                         │
│  ? userFacingName(input): string                                        │
│    └─ Default: tool.name                                               │
│    └─ UI display name                                                  │
│                                                                         │
│  ? checkPermissions(input, context): PermissionResult                  │
│    └─ Default: {behavior: 'allow'}                                     │
│    └─ Defer to general permission system                               │
│                                                                         │
│  [Plus 20+ rendering and analysis methods]                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Tool Creation via buildTool Factory                                    │
│                                                                         │
│  const MyTool: ToolDef = {                                             │
│    name: 'my_tool',                                                     │
│    description: DESCRIPTION,                                            │
│    inputSchema: z.object({...}),                                       │
│    call: async (input, context, ...) => ({data: result}),             │
│    // ... implement REQUIRED methods ...                               │
│  }                                                                      │
│                                                                         │
│  export const MyTool = buildTool({                                     │
│    // buildTool fills in defaults for optional methods                │
│    ...MyTool,                                                           │
│  })                                                                     │
│                                                                         │
│  Result: Tool object with all 30+ methods (required + defaults)        │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Visual Diagram 5: Concurrency Control Rules

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Concurrency Control in StreamingToolExecutor          │
└──────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Scenario 1: Multiple Read Operations (All Concurrent-Safe)            │
│                                                                         │
│  Queue:                  Execution Timeline:                            │
│  ┌──────────────────┐   ┌─────────────────────────────────────────┐   │
│  │ Tool A (Read)    │   │ Time ──→                                │   │
│  │ Tool B (Grep)    │   │ A [====] → START (no others running)   │   │
│  │ Tool C (List)    │   │ B [====] → START (A is concurrent-safe)│   │
│  └──────────────────┘   │ C [====] → START (A,B concurrent-safe) │   │
│                         │                                          │   │
│  isConcurrencySafe:     │ Result order: A, B, C (emission order)  │   │
│  A() → true             │                                          │   │
│  B() → true             │ Actual execution: parallel              │   │
│  C() → true             │ Emission: ordered (A first, then B, C)  │   │
│                         └─────────────────────────────────────────┘   │
│  All execute in parallel, results emitted in order                     │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Scenario 2: Mixed Safe + Unsafe                                        │
│                                                                         │
│  Queue:                  Execution Timeline:                            │
│  ┌──────────────────┐   ┌─────────────────────────────────────────┐   │
│  │ Tool A (Bash)    │   │ Time ──→                                │   │
│  │ Tool B (Read)    │   │ A [==============] → START (exclusive) │   │
│  │ Tool C (Edit)    │   │ B           [===] → WAIT (A unsafe)    │   │
│  └──────────────────┘   │ C           [===] → WAIT (A unsafe)    │   │
│                         │                                          │   │
│  isConcurrencySafe:     │ Then: B,C start in parallel (both safe) │   │
│  A() → false            │       B [===]                            │   │
│  B() → true             │       C [===]                            │   │
│  C() → true             │                                          │   │
│                         │ Result order: A, B, C                   │   │
│  Unsafe tool blocks others, then safe tools run in parallel           │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Scenario 3: Multiple Unsafe Operations                                 │
│                                                                         │
│  Queue:                  Execution Timeline:                            │
│  ┌──────────────────┐   ┌─────────────────────────────────────────┐   │
│  │ Tool A (Bash)    │   │ Time ──→                                │   │
│  │ Tool B (Edit)    │   │ A [==============] → START (exclusive) │   │
│  │ Tool C (Edit)    │   │ B           [=======] → START (A done)│   │
│  └──────────────────┘   │ C                   [=] → START (B done) │   │
│                         │                                          │   │
│  isConcurrencySafe:     │ Sequential execution (no parallelism)   │   │
│  A() → false            │                                          │   │
│  B() → false            │ Result order: A, B, C (strict)          │   │
│  C() → false            │ Execution order: A, B, C (wait for each)│   │
│                         └─────────────────────────────────────────┘   │
│  All execute sequentially (exclusive access)                           │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Execution Logic (pseudocode)                                           │
│                                                                         │
│  canExecuteTool(isConcurrencySafe):                                    │
│    executingTools = [tools with status='executing']                   │
│    return executingTools.length === 0 ||                              │
│           (isConcurrencySafe && all executingTools are safe)          │
│                                                                         │
│  If canExecuteTool(safe):                                              │
│    → START immediately                                                 │
│  Else if safe && some unsafe running:                                 │
│    → WAIT (unsafe tool finishes first)                                │
│  Else if unsafe && any running:                                       │
│    → WAIT (exclusive access required)                                 │
│  Else:                                                                 │
│    → START immediately                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Table: Built-in Tools by Category

| Category | Tools | Count |
|----------|-------|-------|
| **File Operations** | FileRead, FileEdit, FileWrite, Glob, Grep, NotebookEdit | 6 |
| **Execution** | Bash, PowerShell, Task* (5 tasks), SkillTool, AgentTool | 10 |
| **Web** | WebFetch, WebSearch, WebBrowser | 3 |
| **Data** | TodoWrite, WebSearch, TaskOutputTool | 3 |
| **MCP Integration** | MCPSuperAssistantExecutor, ListMcpResources, ReadMcpResource | 3 |
| **UI** | AskUserQuestion, EnterPlanMode, ExitPlanMode, BriefTool | 4 |
| **Delegation** | AgentTool, ModelDelegateTool, LSPTool | 3 |
| **Utilities** | ToolSearch, VerifyPlanExecution, TerminalCapture, REPL | 4 |
| **Conditional (Features)** | SleepTool, CronTools (3), MonitorTool, SendUserFile, PushNotification, SubscribePR, Workflow, EnterWorktree, ExitWorktree, ConfigTool, TungstenTool, etc. | ~20+ |

**Total**: ~60+ tools (exact count varies by feature flags)

---

## Reference: Permission Decision Outcomes

```
┌──────────────────────────────────────────┐
│  Tool Execution Permission Outcomes      │
└──────────────────────────────────────────┘

ALLOW
├─ Tool executes immediately
└─ Result added to message stream

DENY
├─ Tool rejected before execution
├─ User shown rejection reason
└─ Tool not called

ASK
├─ Permission dialog shown to user
├─ User approves/denies in UI
├─ If approved: execute (goes to ALLOW)
└─ If denied: reject (goes to DENY)

DENY_ALL_RECURSIVELY (for non-concurrent)
├─ Future sibling tools auto-denied
├─ User shown accumulated denials
└─ Turn ends early
```

---

## File Size & Complexity Reference

| File | Lines | Purpose |
|------|-------|---------|
| `Tool.ts` | 1000+ | Tool interface, types, buildTool factory |
| `tools.ts` | 500+ | Tool registry, filtering, assembly |
| `QueryEngine.ts` | 1500+ | Turn orchestration, token management |
| `query.ts` | 500+ | Single turn processing |
| `StreamingToolExecutor.ts` | 300+ | Concurrency management |
| `toolExecution.ts` | 600+ | Tool execution, validation, permission |
| `BashTool.tsx` | 1000+ | Shell execution, security, formatting |
| `FileReadTool.ts` | 800+ | File reading, image/PDF handling |
| `MCPSuperAssistantExecutor.ts` | 250+ | Proxy client, RPC, SSE |

---

## Key Takeaways

1. **Tool System is Pluggable**: Just add to `getAllBaseTools()` array
2. **Contract is Simple**: ~9 required, ~20+ optional methods
3. **Defaults are Safe**: `buildTool()` provides sensible fallbacks
4. **Execution is Orchestrated**: `StreamingToolExecutor` manages concurrency
5. **Permissions are Layered**: General + tool-specific checks
6. **Errors are Structured**: All exceptions caught, returned as data
7. **Results are Persistent**: Large outputs saved to disk
8. **MCPSuperAssistantExecutor Fits Naturally**: Just another tool following the contract
