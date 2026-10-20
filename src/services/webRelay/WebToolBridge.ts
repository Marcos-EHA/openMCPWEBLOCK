/**
 * WebToolBridge â€” Enables web AI platforms to use openclaude's tools.
 *
 * How it works:
 *   1. Augments user prompts with tool definitions (XML format)
 *   2. Sends prompt to web AI via CDP (PlatformAdapters)
 *   3. Parses AI response for <tool_use> blocks
 *   4. Executes tool calls using openclaude's tool runner
 *   5. Sends tool results back as follow-up messages
 *   6. Loops until AI responds without tool calls
 *
 * This replaces the need for MCP-SuperAssistant browser extension.
 * All logic runs server-side in openMCPWEBLOCK via CDP injection.
 */

import { randomUUID } from 'crypto'
import type { Tool } from '../../Tool.js'

// â”€â”€â”€ Side-effect taxonomy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Retry safety is a property of the TOOL, not of the scheduler.
 *
 * A delivery timeout is not evidence that a side effect did not land. Without
 * this taxonomy a lost websocket frame can re-run `Bash` or `Write`, which is
 * how an automation system destroys a user's work. Unknown tools default to
 * `effectful` so we fail safe.
 */
export type EffectClass = 'pure' | 'idempotent-keyed' | 'effectful'

const EFFECT_CLASSES: Record<string, EffectClass> = {
  Read: 'pure',
  ListDir: 'pure',
  Grep: 'pure',
  Glob: 'pure',
  Write: 'idempotent-keyed',
  Edit: 'idempotent-keyed',
  Bash: 'effectful',
}

export function getEffectClass(toolName: string): EffectClass {
  const direct = EFFECT_CLASSES[toolName]
  if (direct) return direct
  const suffix = toolName.split('.').pop() ?? toolName
  const normalized = Object.keys(EFFECT_CLASSES).find(
    k => k.toLowerCase() === suffix.toLowerCase(),
  )
  return normalized ? EFFECT_CLASSES[normalized]! : 'effectful'
}

/** Only `pure` and `idempotent-keyed` may be retried without a decision. */
export function isAutoRetryable(toolName: string): boolean {
  return getEffectClass(toolName) !== 'effectful'
}

// â”€â”€â”€ Execution de-duplication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const recentEffects = new Map<string, { at: number; output: string; isError: boolean }>()
const DEDUP_WINDOW_MS = 15_000

function effectFingerprint(scope: string, name: string, input: unknown): string {
  let canonical: string
  try {
    canonical = JSON.stringify(input, Object.keys((input as object) ?? {}).sort())
  } catch {
    canonical = String(input)
  }
  return `${scope}::${name}::${canonical}`
}

// â”€â”€â”€ Tool Definition Formatter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Format openclaude tools into XML definitions that any AI model understands.
 * This gets prepended to the user's first message in web mode.
 */
export function formatToolDefinitions(tools: Tool[]): string {
  if (!tools || tools.length === 0) return ''

  const toolDefs = tools.map(tool => {
    const params = tool.inputSchema?.properties
      ? Object.entries(tool.inputSchema.properties as Record<string, any>)
          .map(([name, schema]: [string, any]) => {
            const required = (tool.inputSchema?.required as string[] || []).includes(name)
            return `    <parameter name="${name}" type="${schema.type || 'string'}" required="${required}">${schema.description || ''}</parameter>`
          })
          .join('\n')
      : ''

    return `  <tool name="${tool.name}">
    <description>${tool.description || ''}</description>
    <parameters>
${params}
    </parameters>
  </tool>`
  }).join('\n')

  return `<available_tools>
${toolDefs}
</available_tools>

<tool_use_instructions>
When you need to use a tool, output it in this EXACT format:
<tool_use>
<tool_name>TOOL_NAME</tool_name>
<tool_input>
{"param1": "value1", "param2": "value2"}
</tool_input>
</tool_use>

You may use multiple tools in one response. After outputting tool_use blocks, STOP and wait for results.
I will provide results in <tool_result> blocks, then you continue.
</tool_use_instructions>`
}

/**
 * Format SuperAssistant extension prompt for ChatGPT / web AI.
 * SuperAssistant requires attaching its operational instructions and tool definitions
 * so the web LLM understands how to act as SuperAssistant and emit tool calls.
 */
export function formatSuperAssistantPrompt(
  userPrompt: string,
  tools?: Array<{
    name: string
    description?: string
    inputSchema?: {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    input_schema?: {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
  }>,
): string {
  if (
    userPrompt.includes('[SuperAssistant Operational Instructions]') ||
    userPrompt.includes('<system>\nYou are SuperAssistant')
  ) {
    return userPrompt
  }

  const toolDefs =
    tools && tools.length > 0
      ? tools
          .map(tool => {
            const inputSchema = tool.inputSchema ?? tool.input_schema
            const params = inputSchema?.properties
              ? Object.entries(inputSchema.properties)
                  .map(([name, schema]) => {
                    const required = (inputSchema.required || []).includes(name)
                    return `    <parameter name="${name}" type="${schema.type || 'string'}" required="${required}">${schema.description || ''}</parameter>`
                  })
                  .join('\n')
              : ''
            return `  <tool name="${tool.name}">
    <description>${tool.description || ''}</description>
    <parameters>
${params}
    </parameters>
  </tool>`
          })
          .join('\n')
      : ''

  const instructions = `[SuperAssistant Operational Instructions][IMPORTANT]

<system>
You are SuperAssistant whose capabilities are to invoke functions by the help of the user and make the best use of it during your assistance.
The listed tools are provided by the SuperAssistant extension connected to openMCPWEBLOCK's MCP server. When used, they operate on the user's local machine with the exact scope and permissions represented by each tool schema; do not claim they are unavailable or that the browser profile is a filesystem sandbox.
For a code or folder analysis, use the listed filesystem tools to inspect only the path the user asked about. Read and analyze first; do not modify files or run commands unless the user requests those actions. Do not read secrets such as .env or credential files unless the user specifically asks and it is necessary.

Function-call protocol (JSONL only):
- Emit each event as one standalone JSON object on its own line.
- The start event has type "function_call_start", the exact name of one listed tool, and a newly generated call_id.
- Emit one parameter event per argument, using the exact schema key and a valid JSON value.
- The end event has type "function_call_end" and repeats the same call_id.
- Never emit protocol labels, angle-bracketed instructions, or placeholder words as tool names, call IDs, parameter keys, or values.
- The observer executes a valid call and returns its matching function_result. Stop after a call and wait for that result.
- Do not invent executionId or executionKey fields, fabricate results, or ask the user to copy/paste calls the extension can observe.

${toolDefs ? `<available_tools>\n${toolDefs}\n</available_tools>\n` : ''}</system>

${userPrompt}`

  return instructions
}

// â”€â”€â”€ Tool Call Parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ParsedToolCall {
  id: string
  name: string
  input: Record<string, any>
}

/**
 * Parse AI response text for tool_use blocks.
 * Supports both XML format and JSON-like format.
 */
export function parseToolCalls(responseText: string, callScope?: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  
  // Pattern 1: XML tool_use blocks
  const xmlPattern = /<tool_use>\s*<tool_name>(.*?)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/tool_use>/g
  let match: RegExpExecArray | null
  let idx = 0

  // `web-tool-${Date.now()}-${idx}` collided across agents: two instances
  // parsing in the same millisecond at the same index produced identical IDs,
  // and those IDs were used downstream as execution identity. Mint a UUID and
  // carry the caller's scope so identity can never be guessed from a clock.
  const scope = callScope ?? 'unscoped'
  const mintId = () => `web-tool-${scope}-${randomUUID()}-${idx++}`

  while ((match = xmlPattern.exec(responseText)) !== null) {
    const name = match[1]!.trim()
    const inputStr = match[2]!.trim()
    
    try {
      const input = JSON.parse(inputStr)
      calls.push({
        id: mintId(),
        name,
        input,
      })
    } catch {
      // Try to extract key-value pairs from non-JSON format
      const input: Record<string, string> = {}
      const kvPattern = /"(\w+)":\s*"([^"]*?)"/g
      let kv: RegExpExecArray | null
      while ((kv = kvPattern.exec(inputStr)) !== null) {
        input[kv[1]!] = kv[2]!
      }
      if (Object.keys(input).length > 0) {
        calls.push({ id: mintId(), name, input })
      }
    }
  }

  // Pattern 2: Claude-style function_calls (some models use this)
  const fnPattern = /```tool_code\s*\n([\s\S]*?)```/g
  while ((match = fnPattern.exec(responseText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!.trim())
      if (parsed.name && parsed.arguments) {
        calls.push({
          id: mintId(),
          name: parsed.name,
          input: parsed.arguments,
        })
      }
    } catch { /* not valid JSON */ }
  }

  return calls
}

// â”€â”€â”€ Tool Result Formatter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ToolResult {
  id: string
  name: string
  output: string
  isError: boolean
}

/**
 * Format tool results as a message to send back to the web AI.
 */
export function formatToolResults(results: ToolResult[]): string {
  return results.map(r => {
    if (r.isError) {
      return `<tool_result tool_name="${r.name}" status="error">
${r.output}
</tool_result>`
    }
    return `<tool_result tool_name="${r.name}" status="success">
${r.output}
</tool_result>`
  }).join('\n\n') + '\n\nPlease continue based on the tool results above.'
}

// â”€â”€â”€ Tool Executor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Execute a parsed tool call using openclaude's tool infrastructure.
 * Returns the result as a ToolResult.
 */
/**
 * Directories the web model may be told it can reach.
 *
 * This used to be a hardcoded array ending in `C:\`, i.e. the whole drive. That
 * had two problems: it advertised full-disk access to a third-party web model,
 * and it bypassed any real policy because it was a canned string rather than a
 * reflection of what the tools actually enforce. Now it is configuration, it
 * excludes drive roots, and it defaults to the project directory only.
 */
function resolveAllowedDirectories(): string[] {
  const configured = (process.env.OPENMCPWEBLOCK_ALLOWED_DIRS ?? '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)

  const candidates = configured.length > 0 ? configured : [process.cwd()]

  // Refuse drive roots and filesystem roots outright.
  return candidates.filter(dir => {
    const normalized = dir.replace(/[\\/]+$/, '')
    if (normalized.length === 0) return false
    if (/^[a-zA-Z]:$/.test(normalized)) return false
    return true
  })
}

export async function executeToolCall(
  toolCall: ParsedToolCall,
  tools: Tool[],
  /** Agent/instance scope. Required for dedup to be per-agent rather than global. */
  callScope?: string,
): Promise<ToolResult> {
  // Handle special SA aliases directly if needed
  if (toolCall.name === 'filesystem.list_allowed_directories') {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: JSON.stringify({ allowed_directories: resolveAllowedDirectories() }),
      isError: false,
    }
  }

  // â”€â”€â”€ Duplicate-effect guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The tool loop re-reads pending calls from the PAGE every iteration. The
  // page is untrusted, unowned state: it can and does report the same pending
  // call twice. Without this guard a single `Bash` block runs twice.
  const scope = callScope ?? 'unscoped'
  const fingerprint = effectFingerprint(scope, toolCall.name, toolCall.input)
  const now = Date.now()

  for (const [key, entry] of recentEffects) {
    if (now - entry.at > DEDUP_WINDOW_MS) recentEffects.delete(key)
  }

  const seen = recentEffects.get(fingerprint)
  if (seen && getEffectClass(toolCall.name) === 'effectful') {
    console.warn(
      `[WebToolBridge] Suppressed duplicate effectful call "${toolCall.name}" within ` +
        `${DEDUP_WINDOW_MS}ms for scope ${scope}. Returning the first result instead of re-running.`,
    )
    return { id: toolCall.id, name: toolCall.name, output: seen.output, isError: seen.isError }
  }

  let tool = tools.find(t => t.name === toolCall.name)

  // Fallback: match by suffix or common aliases
  if (!tool) {
    const rawName = toolCall.name.toLowerCase()
    const suffix = toolCall.name.split('.').pop()?.toLowerCase() || ''
    tool = tools.find(t => {
      const tn = t.name.toLowerCase()
      return tn === suffix ||
             (suffix === 'read_file' && tn === 'read') ||
             (suffix === 'write_file' && tn === 'write') ||
             (suffix === 'edit_file' && tn === 'edit') ||
             (suffix === 'list_directory' && (tn === 'listdir' || tn === 'ls')) ||
             (suffix === 'execute_command' && tn === 'bash')
    })
  }

  // Normalize parameters (e.g., path -> file_path)
  if (toolCall.input && toolCall.input.path && !toolCall.input.file_path) {
    toolCall.input.file_path = toolCall.input.path
  }

  if (!tool) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: `Error: Tool "${toolCall.name}" not found. Available tools: ${tools.map(t => t.name).join(', ')}`,
      isError: true,
    }
  }

  try {
    // Use the tool's call method if available
    if (typeof (tool as any).call === 'function') {
      const result = await (tool as any).call(toolCall.input)
      const output = typeof result === 'string' 
        ? result 
        : JSON.stringify(result, null, 2)

      // Truncation used to be silent: the model received 10 000 characters with
      // no indication that anything was cut, and acted as if it had the whole
      // file. Mark it explicitly so the model knows to narrow its request.
      const truncated = output.length > MAX_TOOL_OUTPUT_CHARS
      const projected = truncated
        ? `${output.substring(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[TRUNCATED] Showed ${MAX_TOOL_OUTPUT_CHARS} of ` +
          `${output.length} characters. Re-run with a narrower range, offset or filter to see the rest.`
        : output

      const toolResult: ToolResult = {
        id: toolCall.id,
        name: toolCall.name,
        output: projected,
        isError: false,
      }

      recentEffects.set(fingerprint, { at: Date.now(), output: projected, isError: false })
      return toolResult
    }

    return {
      id: toolCall.id,
      name: toolCall.name,
      output: `Tool "${toolCall.name}" does not have a callable implementation in web mode.`,
      isError: true,
    }
  } catch (err: any) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: `Error executing "${toolCall.name}": ${err?.message || String(err)}`,
      isError: true,
    }
  }
}

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Maximum number of tool-use loops to prevent infinite loops */
export const MAX_TOOL_LOOPS = 10

/** Maximum characters of tool output injected into the page.
 *  The page is a thin view over results, not the store. Large payloads choke
 *  the DOM and blow the model's context window. */
export const MAX_TOOL_OUTPUT_CHARS = 10000

/** Minimum tools to include in web mode (core tools only for prompt size) */
export const WEB_MODE_CORE_TOOLS = [
  'Read',         // Read files
  'Write',        // Write files
  'Edit',         // Edit files  
  'Bash',         // Run commands
  'ListDir',      // List directory
  'Grep',         // Search files
  'Glob',         // Find files by pattern
  'report_finding', // Report finding to lienzo
  'request_info',   // Request info from another worker
  'flag_issue',     // Flag a problem
]

/**
 * Filter tools to only include core tools suitable for web mode.
 * Web mode has prompt size limits since tool defs go in the message.
 */
export function filterToolsForWebMode(tools: Tool[]): Tool[] {
  return tools.filter(t => WEB_MODE_CORE_TOOLS.includes(t.name))
}

