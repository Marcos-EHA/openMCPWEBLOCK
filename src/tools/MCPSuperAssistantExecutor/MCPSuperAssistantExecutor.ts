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
      .default('http://localhost:3006/sse')
      .describe('URL of the MCP-SuperAssistant proxy server (default: http://localhost:3006/sse)'),
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

interface MCPToolCall {
  tool: string
  input: Record<string, any>
}

interface MCPToolResult {
  content: Array<{
    type: string
    text?: string
    [key: string]: any
  }>
  isError?: boolean
}

class MCPSuperAssistantClient {
  private proxyUrl: string
  private eventSource: EventSource | null = null
  private messageHandlers: Map<string, (data: any) => void> = new Map()
  private requestId: number = 0

  constructor(proxyUrl: string) {
    this.proxyUrl = proxyUrl
  }

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.eventSource = new EventSource(this.proxyUrl)

        this.eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            const handler = this.messageHandlers.get(data.id)
            if (handler) {
              handler(data)
              this.messageHandlers.delete(data.id)
            }
          } catch (error) {
            console.error('Error parsing SSE message:', error)
          }
        }

        this.eventSource.onerror = () => {
          console.error('SSE connection error')
          if (this.eventSource) {
            this.eventSource.close()
            this.eventSource = null
          }
          resolve(false)
        }

        // Give it a moment to connect
        setTimeout(() => resolve(this.eventSource !== null), 500)
      } catch (error) {
        console.error('Failed to create SSE connection:', error)
        resolve(false)
      }
    })
  }

  async listTools(): Promise<any> {
    return this.sendRequest({
      method: 'tools/list',
    })
  }

  async executeTool(toolName: string, parameters: Record<string, any>): Promise<any> {
    return this.sendRequest({
      method: 'tools/call',
      params: {
        name: toolName,
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

  private async sendRequest(request: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `req_${++this.requestId}`
      const timeout = setTimeout(() => {
        this.messageHandlers.delete(id)
        reject(new Error('Request timeout'))
      }, 10000)

      this.messageHandlers.set(id, (response) => {
        clearTimeout(timeout)
        if (response.error) {
          reject(new Error(response.error))
        } else {
          resolve(response.result)
        }
      })

      // Send request via HTTP POST to the proxy
      const requestPayload = { ...request, id }
      fetch(`${this.proxyUrl.replace('/sse', '/rpc')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestPayload),
      }).catch((error) => {
        this.messageHandlers.delete(id)
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
  }
}

async function executeMCPSuperAssistantTool(input: InputSchema): Promise<OutputSchema> {
  const { action, toolName, parameters = {}, proxyUrl = 'http://localhost:3006' } = input

  // Normalize proxy URL
  const normalizedUrl = proxyUrl.endsWith('/sse')
    ? proxyUrl
    : proxyUrl.endsWith('/')
      ? `${proxyUrl}sse`
      : `${proxyUrl}/sse`

  const client = new MCPSuperAssistantClient(normalizedUrl)

  try {
    // Test connection to proxy
    const connected = await client.connect()
    if (!connected) {
      return {
        success: false,
        action,
        data: null,
        error: `Failed to connect to MCP-SuperAssistant proxy at ${normalizedUrl}. Ensure the proxy is running: npx @srbhptl39/mcp-superassistant-proxy@latest --config ./config.json --outputTransport sse`,
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
