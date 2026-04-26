import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  MCP_SUPERASSISTANT_EXECUTOR_TOOL_NAME,
  DESCRIPTION,
  MCP_SUPERASSISTANT_EXECUTOR_PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['list_tools', 'execute_tool', 'get_server_status'])
      .describe('The action to perform: list_tools (get available MCP tools), execute_tool (run a specific tool), or get_server_status (check proxy connection)'),
    toolName: z
      .string()
      .optional()
      .describe('The name of the specific MCP tool to execute (e.g., "desktop-commander/read_file", "github/create_issue")'),
    parameters: z
      .record(z.any())
      .optional()
      .describe('Parameters for the tool execution, varies by tool'),
    proxyUrl: z
      .string()
      .optional()
      .default('http://localhost:3006')
      .describe('URL of the MCP-SuperAssistant proxy server (default: http://localhost:3006)'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    action: z.string().describe('The action that was performed'),
    data: z.any().describe('Result data from the MCP tool or server status'),
    error: z.string().optional().describe('Error message if operation failed'),
    toolsCount: z.number().optional().describe('Number of available tools (for list_tools action)'),
    serverStatus: z.string().optional().describe('Status of the proxy server'),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>

interface MCPToolResult {
  content: Array<{
    type: string
    text?: string
    [key: string]: any
  }>
  isError?: boolean
}

/**
 * Simple HTTP-based client for MCP-SuperAssistant proxy
 * Uses standard JSON-RPC pattern for requests/responses
 */
class MCPSuperAssistantClient {
  private proxyUrl: string
  private requestId: number = 0

  constructor(proxyUrl: string) {
    this.proxyUrl = proxyUrl
  }

  /**
   * Verify connection to proxy by attempting a simple request
   */
  async connect(): Promise<boolean> {
    try {
      const rpcUrl = this.getRpcUrl()
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `conn_${Date.now()}`,
          method: 'initialize',
          params: {},
        }),
      })

      return response.ok
    } catch {
      return false
    }
  }

  async listTools(): Promise<any[]> {
    return this.sendRequest({
      method: 'tools/list',
      params: {},
    })
  }

  async executeTool(toolName: string, parameters: Record<string, any>): Promise<any> {
    const [serverName, methodName] = toolName.split('/').length === 2
      ? toolName.split('/')
      : [toolName, '']

    return this.sendRequest({
      method: 'tools/call',
      params: {
        server: serverName,
        tool: methodName || toolName,
        arguments: parameters,
      },
    })
  }

  async getServerStatus(): Promise<any> {
    return this.sendRequest({
      method: 'initialize',
      params: {},
    })
  }

  private async sendRequest(request: { method: string; params: Record<string, any> }): Promise<any> {
    const id = `req_${++this.requestId}_${Date.now()}`
    const rpcUrl = this.getRpcUrl()

    const payload = {
      jsonrpc: '2.0',
      id,
      ...request,
    }

    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json() as any

      if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error))
      }

      return data.result || data
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error(`Request failed: ${String(error)}`)
    }
  }

  private getRpcUrl(): string {
    return this.proxyUrl.endsWith('/rpc')
      ? this.proxyUrl
      : this.proxyUrl.endsWith('/')
        ? `${this.proxyUrl}rpc`
        : `${this.proxyUrl}/rpc`
  }

  disconnect(): void {
    // HTTP client has nothing to disconnect
  }
}

async function executeMCPSuperAssistantTool(input: InputSchema): Promise<OutputSchema> {
  const { action, toolName, parameters = {}, proxyUrl = 'http://localhost:3006' } = input

  const client = new MCPSuperAssistantClient(proxyUrl)

  try {
    // Test connection to proxy
    const connected = await client.connect()
    if (!connected) {
      return {
        success: false,
        action,
        data: null,
        error: `Failed to connect to MCP-SuperAssistant proxy at ${proxyUrl}. Ensure the proxy is running on this port.`,
      }
    }

    let result: any

    switch (action) {
      case 'list_tools': {
        result = await client.listTools()
        const toolsList = Array.isArray(result) ? result : result?.tools || []
        return {
          success: true,
          action,
          data: toolsList,
          toolsCount: toolsList.length,
        }
      }

      case 'execute_tool': {
        if (!toolName) {
          return {
            success: false,
            action,
            data: null,
            error: 'toolName parameter is required for execute_tool action',
          }
        }

        result = await client.executeTool(toolName, parameters)
        return {
          success: true,
          action,
          data: result,
        }
      }

      case 'get_server_status': {
        result = await client.getServerStatus()
        return {
          success: true,
          action,
          data: result,
          serverStatus: 'connected',
        }
      }

      default:
        return {
          success: false,
          action,
          data: null,
          error: `Unknown action: ${action}`,
        }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      action,
      data: null,
      error: `Error executing MCP-SuperAssistant tool: ${errorMessage}`,
    }
  } finally {
    client.disconnect()
  }
}

export const MCPSuperAssistantExecutor: ToolDef<InputSchema, OutputSchema> = buildTool({
  name: MCP_SUPERASSISTANT_EXECUTOR_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  outputSchema,
  renderToolUseMessage,
  renderToolResultMessage,
  execute: executeMCPSuperAssistantTool,
})
