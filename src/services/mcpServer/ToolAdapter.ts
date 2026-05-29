/**
 * ToolAdapter — Converts openMCPWEBLOCK's Tool[] to MCP-compatible tool definitions.
 *
 * Exposes ALL enabled tools from the framework to MCP clients (SA, etc.).
 * Tools that can execute without UI context get direct Node.js implementations.
 * Tools that require UI/React context get a descriptive fallback.
 *
 * SA should NOT limit openMCPWEBLOCK's capabilities — every tool the
 * framework offers is exposed to the AI platform.
 */

import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import type { Tool, Tools } from '../../Tool.js'

export interface SimpleTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

/**
 * Tools that genuinely cannot work headless (need React UI, user interaction, etc.)
 * These are still exposed to MCP but return a descriptive message when called.
 */
const UI_ONLY_TOOLS = new Set([
  'AskUserQuestionTool',    // needs TUI input
  'EnterPlanModeTool',      // TUI state change
  'ExitPlanModeTool',       // TUI state change
  'EnterWorktreeTool',      // TUI state change
  'ExitWorktreeTool',       // TUI state change
  'SyntheticOutputTool',    // internal
  'BriefTool',              // TUI display mode
  'ConfigTool',             // TUI config
])

/**
 * Convert openMCPWEBLOCK tools to simple MCP-compatible tools.
 * ALL enabled tools are exposed — no arbitrary filtering.
 */
export function adaptToolsForMCP(tools: Tools): SimpleTool[] {
  const result: SimpleTool[] = []

  for (const tool of tools) {
    // Skip only tools that are disabled
    if (!tool.isEnabled()) continue

    try {
      const adapted = adaptSingleTool(tool)
      if (adapted) result.push(adapted)
    } catch (err) {
      console.error(`[ToolAdapter] Failed to adapt tool "${tool.name}":`, err)
    }
  }

  return result
}

function adaptSingleTool(tool: Tool): SimpleTool | null {
  // Get JSON Schema for the input
  let inputSchema: Record<string, unknown>

  if (tool.inputJSONSchema) {
    inputSchema = tool.inputJSONSchema as Record<string, unknown>
  } else if (tool.inputSchema) {
    try {
      const jsonSchema = zodToJsonSchema(tool.inputSchema as any)
      inputSchema = jsonSchema as Record<string, unknown>
    } catch {
      inputSchema = { type: 'object', properties: {} }
    }
  } else {
    inputSchema = { type: 'object', properties: {} }
  }

  return {
    name: tool.name,
    description: getToolDescription(tool),
    inputSchema,
    execute: createExecutor(tool),
  }
}

/**
 * Get description for tools. Uses static descriptions for known tools,
 * falls back to tool.name for unknown ones.
 */
function getToolDescription(tool: Tool): string {
  const descriptions: Record<string, string> = {
    // File operations
    Read: 'Read file contents from the filesystem. Supports line ranges with offset/limit.',
    Write: 'Write content to a file. Creates directories if needed.',
    Edit: 'Edit a file by searching for exact text and replacing it.',
    MultiEdit: 'Make multiple edits to a file in one operation.',
    // Shell & system
    Bash: 'Execute a shell command and return its output.',
    PowerShellTool: 'Execute a PowerShell command.',
    // Search & navigation
    Glob: 'Find files matching a glob pattern.',
    Grep: 'Search for text patterns in files using regex.',
    LS: 'List directory contents with file sizes and types.',
    ToolSearchTool: 'Search for available tools by name or description.',
    // Web
    WebSearch: 'Search the web and return results.',
    WebFetch: 'Fetch content from a URL and return it.',
    // Notebooks & todos
    TodoRead: 'Read the current todo/task list.',
    TodoWrite: 'Update the todo/task list.',
    NotebookRead: 'Read a Jupyter notebook.',
    NotebookEdit: 'Edit cells in a Jupyter notebook.',
    // Task management
    TaskCreateTool: 'Create a background task.',
    TaskListTool: 'List all background tasks.',
    TaskGetTool: 'Get details of a specific background task.',
    TaskStopTool: 'Stop a running background task.',
    TaskUpdateTool: 'Update a background task.',
    TaskOutputTool: 'Get the output of a background task.',
    // Agent & team
    AgentTool: 'Create and run a sub-agent for a specific task.',
    TeamCreateTool: 'Create a team of agents.',
    TeamDeleteTool: 'Delete a team of agents.',
    SendMessageTool: 'Send a message to another agent.',
    // MCP
    MCPTool: 'Call an MCP server tool.',
    ListMcpResourcesTool: 'List available MCP resources.',
    ReadMcpResourceTool: 'Read a specific MCP resource.',
    McpAuthTool: 'Authenticate with an MCP server.',
    // Monitoring & scheduling
    MonitorTool: 'Monitor a process or file for changes.',
    ScheduleCronTool: 'Schedule a recurring task with cron.',
    SleepTool: 'Wait for a specified duration.',
    // Code analysis
    LSPTool: 'Use Language Server Protocol for code intelligence.',
    REPLTool: 'Execute code in a REPL environment.',
    // Workflow
    WorkflowTool: 'Execute a predefined workflow.',
    SkillTool: 'Execute a predefined skill/recipe.',
    RemoteTriggerTool: 'Trigger a remote action.',
    VerifyPlanExecutionTool: 'Verify that a plan was executed correctly.',
    SuggestBackgroundPRTool: 'Suggest creating a background pull request.',
    TungstenTool: 'Tungsten integration tool.',
    // UI-only (still exposed but with context message)
    AskUserQuestionTool: 'Ask the user a question (requires TUI).',
    EnterPlanModeTool: 'Enter plan mode (requires TUI).',
    ExitPlanModeTool: 'Exit plan mode (requires TUI).',
    EnterWorktreeTool: 'Enter worktree mode (requires TUI).',
    ExitWorktreeTool: 'Exit worktree mode (requires TUI).',
    BriefTool: 'Toggle brief output mode (requires TUI).',
    ConfigTool: 'View/edit configuration (requires TUI).',
    SyntheticOutputTool: 'Internal synthetic output.',
  }

  return descriptions[tool.name] || `${tool.name}: openMCPWEBLOCK tool`
}

/**
 * Create an executor for a tool.
 * Core tools (Read, Write, Bash, etc.) get direct Node.js implementations.
 * Other tools get a descriptive fallback or delegate to the tool's call method.
 */
function createExecutor(tool: Tool): (args: Record<string, unknown>) => Promise<string> {
  return async (args: Record<string, unknown>): Promise<string> => {
    try {
      // ─── File Read ──────────────────────────────────────────
      if (tool.name === 'Read') {
        const { readFileSync } = await import('fs')
        const filePath = String(args.file_path || args.path || '')
        if (!filePath) return 'Error: No file path provided'
        try {
          const content = readFileSync(filePath, 'utf-8')
          if (args.offset || args.limit) {
            const lines = content.split('\n')
            const offset = Number(args.offset) || 0
            const limit = Number(args.limit) || lines.length
            return lines.slice(offset, offset + limit).join('\n')
          }
          return content
        } catch (err: any) {
          return `Error reading file: ${err.message}`
        }
      }

      // ─── File Write ─────────────────────────────────────────
      if (tool.name === 'Write') {
        const { writeFileSync, mkdirSync } = await import('fs')
        const { dirname } = await import('path')
        const filePath = String(args.file_path || args.path || '')
        const content = String(args.content || '')
        if (!filePath) return 'Error: No file path provided'
        try {
          mkdirSync(dirname(filePath), { recursive: true })
          writeFileSync(filePath, content, 'utf-8')
          return `File written: ${filePath} (${content.length} bytes)`
        } catch (err: any) {
          return `Error writing file: ${err.message}`
        }
      }

      // ─── File Edit ──────────────────────────────────────────
      if (tool.name === 'Edit') {
        const { readFileSync, writeFileSync } = await import('fs')
        const filePath = String(args.file_path || args.path || '')
        const oldText = String(args.old_text || args.search || '')
        const newText = String(args.new_text || args.replace || '')
        if (!filePath) return 'Error: No file path provided'
        if (!oldText) return 'Error: No old_text/search provided'
        try {
          const content = readFileSync(filePath, 'utf-8')
          if (!content.includes(oldText)) {
            return `Error: old_text not found in ${filePath}`
          }
          const updated = content.replace(oldText, newText)
          writeFileSync(filePath, updated, 'utf-8')
          return `File edited: ${filePath} (replaced ${oldText.length} → ${newText.length} chars)`
        } catch (err: any) {
          return `Error editing file: ${err.message}`
        }
      }

      // ─── Multi Edit ─────────────────────────────────────────
      if (tool.name === 'MultiEdit') {
        const { readFileSync, writeFileSync } = await import('fs')
        const filePath = String(args.file_path || args.path || '')
        const edits = args.edits as any[] || []
        if (!filePath) return 'Error: No file path provided'
        if (!edits.length) return 'Error: No edits provided'
        try {
          let content = readFileSync(filePath, 'utf-8')
          let applied = 0
          for (const edit of edits) {
            const old = String(edit.old_text || edit.search || '')
            const rep = String(edit.new_text || edit.replace || '')
            if (old && content.includes(old)) {
              content = content.replace(old, rep)
              applied++
            }
          }
          writeFileSync(filePath, content, 'utf-8')
          return `MultiEdit: ${applied}/${edits.length} edits applied to ${filePath}`
        } catch (err: any) {
          return `Error: ${err.message}`
        }
      }

      // ─── Bash / PowerShell ──────────────────────────────────
      if (tool.name === 'Bash' || tool.name === 'PowerShellTool') {
        const { execSync } = await import('child_process')
        const cmd = String(args.command || '')
        if (!cmd) return 'Error: No command provided'
        try {
          const output = execSync(cmd, {
            timeout: 60000,
            encoding: 'utf-8',
            cwd: process.cwd(),
            maxBuffer: 2 * 1024 * 1024,
            shell: tool.name === 'PowerShellTool' ? 'powershell.exe' : undefined,
          })
          return output || '(no output)'
        } catch (err: any) {
          return `Exit code ${err.status || 1}\n${err.stderr || err.message}`
        }
      }

      // ─── Glob ───────────────────────────────────────────────
      if (tool.name === 'Glob') {
        const { execSync } = await import('child_process')
        const pattern = String(args.pattern || args.glob || '')
        if (!pattern) return 'Error: No pattern provided'
        try {
          const output = execSync(
            `powershell -Command "Get-ChildItem -Path '${pattern}' -Recurse -Name -ErrorAction SilentlyContinue | Select-Object -First 200"`,
            { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 }
          )
          return output || '(no matches)'
        } catch {
          return '(no matches)'
        }
      }

      // ─── Grep ───────────────────────────────────────────────
      if (tool.name === 'Grep') {
        const { execSync } = await import('child_process')
        const pattern = String(args.pattern || '')
        const path = String(args.path || '.')
        if (!pattern) return 'Error: No pattern provided'
        try {
          const output = execSync(
            `findstr /s /n /r "${pattern}" "${path}"`,
            { encoding: 'utf-8', timeout: 15000, maxBuffer: 1024 * 1024 }
          )
          return output || '(no matches)'
        } catch {
          return '(no matches)'
        }
      }

      // ─── LS ─────────────────────────────────────────────────
      if (tool.name === 'LS') {
        const { readdirSync, statSync } = await import('fs')
        const { join } = await import('path')
        const dirPath = String(args.path || '.')
        try {
          const entries = readdirSync(dirPath)
          const result = entries.map(e => {
            try {
              const s = statSync(join(dirPath, e))
              return `${s.isDirectory() ? '[DIR]' : `[${s.size}b]`} ${e}`
            } catch {
              return `[?] ${e}`
            }
          })
          return result.join('\n') || '(empty directory)'
        } catch (err: any) {
          return `Error listing directory: ${err.message}`
        }
      }

      // ─── WebFetch ───────────────────────────────────────────
      if (tool.name === 'WebFetch') {
        const url = String(args.url || '')
        if (!url) return 'Error: No URL provided'
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
          const text = await resp.text()
          return text.substring(0, 50000) // limit output
        } catch (err: any) {
          return `Error fetching URL: ${err.message}`
        }
      }

      // ─── WebSearch ──────────────────────────────────────────
      if (tool.name === 'WebSearch') {
        const query = String(args.query || '')
        if (!query) return 'Error: No query provided'
        try {
          const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; openMCPWEBLOCK/1.0)' }
          })
          const html = await resp.text()
          // Extract result snippets
          const results = html.match(/class="result__snippet"[^>]*>(.*?)<\//g) || []
          return results.slice(0, 10).map(r => r.replace(/<[^>]*>/g, '').trim()).join('\n\n') || '(no results)'
        } catch (err: any) {
          return `Error searching: ${err.message}`
        }
      }

      // ─── Todo Read/Write ────────────────────────────────────
      if (tool.name === 'TodoRead') {
        const { readFileSync, existsSync } = await import('fs')
        const todoPath = String(args.path || args.file_path || './TODO.md')
        if (!existsSync(todoPath)) return '(no todo file found)'
        return readFileSync(todoPath, 'utf-8')
      }

      if (tool.name === 'TodoWrite') {
        const { writeFileSync, mkdirSync } = await import('fs')
        const { dirname } = await import('path')
        const todoPath = String(args.path || args.file_path || './TODO.md')
        const content = String(args.content || args.todos || '')
        mkdirSync(dirname(todoPath), { recursive: true })
        writeFileSync(todoPath, content, 'utf-8')
        return `Todo list updated: ${todoPath}`
      }

      // ─── Notebook Read/Edit ─────────────────────────────────
      if (tool.name === 'NotebookRead') {
        const { readFileSync } = await import('fs')
        const nbPath = String(args.path || args.file_path || '')
        if (!nbPath) return 'Error: No path provided'
        try {
          const content = JSON.parse(readFileSync(nbPath, 'utf-8'))
          const cells = content.cells || []
          return cells.map((c: any, i: number) =>
            `[Cell ${i} (${c.cell_type})]\n${(c.source || []).join('')}`
          ).join('\n\n')
        } catch (err: any) {
          return `Error: ${err.message}`
        }
      }

      if (tool.name === 'NotebookEdit') {
        return `NotebookEdit: Use Read to view the notebook, then Write to update it.`
      }

      // ─── REPL ───────────────────────────────────────────────
      if (tool.name === 'REPLTool') {
        const { execSync } = await import('child_process')
        const code = String(args.code || args.command || '')
        const lang = String(args.language || 'node')
        if (!code) return 'Error: No code provided'
        try {
          if (lang === 'python' || lang === 'python3') {
            return execSync(`python -c "${code.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: 30000 })
          }
          return execSync(`node -e "${code.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', timeout: 30000 })
        } catch (err: any) {
          return `REPL error: ${err.stderr || err.message}`
        }
      }

      // ─── Sleep ──────────────────────────────────────────────
      if (tool.name === 'SleepTool') {
        const ms = Number(args.duration || args.ms || 1000)
        await new Promise(r => setTimeout(r, ms))
        return `Slept for ${ms}ms`
      }

      // ─── UI-only tools ──────────────────────────────────────
      if (UI_ONLY_TOOLS.has(tool.name)) {
        return `Tool "${tool.name}" requires the openMCPWEBLOCK TUI to execute. It is not available in web relay mode.`
      }

      // ─── Fallback: try tool.call if available ───────────────
      if (typeof (tool as any).call === 'function') {
        try {
          const result = await (tool as any).call(args)
          return typeof result === 'string' ? result : JSON.stringify(result)
        } catch (err: any) {
          return `Tool "${tool.name}" execution error: ${err.message}`
        }
      }

      return `Tool "${tool.name}" is registered. Execution requires additional context not available in web relay mode.`
    } catch (err: any) {
      return `Error executing ${tool.name}: ${err.message}`
    }
  }
}
