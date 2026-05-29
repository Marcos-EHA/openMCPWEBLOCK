/**
 * WebToolBridge — Enables web AI platforms to use openclaude's tools.
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

import type { Tool } from '../../Tool.js'

// ─── Tool Definition Formatter ──────────────────────────────────────

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

// ─── Tool Call Parser ───────────────────────────────────────────────

export interface ParsedToolCall {
  id: string
  name: string
  input: Record<string, any>
}

/**
 * Parse AI response text for tool_use blocks.
 * Supports both XML format and JSON-like format.
 */
export function parseToolCalls(responseText: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  
  // Pattern 1: XML tool_use blocks
  const xmlPattern = /<tool_use>\s*<tool_name>(.*?)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/tool_use>/g
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = xmlPattern.exec(responseText)) !== null) {
    const name = match[1]!.trim()
    const inputStr = match[2]!.trim()
    
    try {
      const input = JSON.parse(inputStr)
      calls.push({
        id: `web-tool-${Date.now()}-${idx++}`,
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
        calls.push({ id: `web-tool-${Date.now()}-${idx++}`, name, input })
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
          id: `web-tool-${Date.now()}-${idx++}`,
          name: parsed.name,
          input: parsed.arguments,
        })
      }
    } catch { /* not valid JSON */ }
  }

  return calls
}

// ─── Tool Result Formatter ──────────────────────────────────────────

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

// ─── Tool Executor ──────────────────────────────────────────────────

/**
 * Execute a parsed tool call using openclaude's tool infrastructure.
 * Returns the result as a ToolResult.
 */
export async function executeToolCall(
  toolCall: ParsedToolCall,
  tools: Tool[],
): Promise<ToolResult> {
  const tool = tools.find(t => t.name === toolCall.name)
  
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
      
      return {
        id: toolCall.id,
        name: toolCall.name,
        output: output.substring(0, 10000), // Limit output size
        isError: false,
      }
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

// ─── Constants ──────────────────────────────────────────────────────

/** Maximum number of tool-use loops to prevent infinite loops */
export const MAX_TOOL_LOOPS = 10

/** Minimum tools to include in web mode (core tools only for prompt size) */
export const WEB_MODE_CORE_TOOLS = [
  'Read',         // Read files
  'Write',        // Write files
  'Edit',         // Edit files  
  'Bash',         // Run commands
  'ListDir',      // List directory
  'Grep',         // Search files
  'Glob',         // Find files by pattern
]

/**
 * Filter tools to only include core tools suitable for web mode.
 * Web mode has prompt size limits since tool defs go in the message.
 */
export function filterToolsForWebMode(tools: Tool[]): Tool[] {
  return tools.filter(t => WEB_MODE_CORE_TOOLS.includes(t.name))
}
