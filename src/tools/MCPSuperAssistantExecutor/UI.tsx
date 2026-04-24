import type { ToolResult } from '../../Tool.js'
import type { InputSchema, OutputSchema } from './MCPSuperAssistantExecutor.js'

export function renderToolUseMessage(input: InputSchema): string {
  const { action, toolName, proxyUrl } = input

  switch (action) {
    case 'list_tools':
      return `🔌 Listing MCP tools available through MCP-SuperAssistant proxy at ${proxyUrl}`
    case 'execute_tool':
      return `⚙️ Executing MCP tool: ${toolName} via MCP-SuperAssistant proxy at ${proxyUrl}`
    case 'get_server_status':
      return `📊 Checking MCP-SuperAssistant proxy status at ${proxyUrl}`
    default:
      return `🔌 MCP-SuperAssistant action: ${action}`
  }
}

export function renderToolResultMessage(
  input: InputSchema,
  result: ToolResult<OutputSchema>,
): string {
  if (result.type === 'error') {
    return `❌ Error: ${result.error}`
  }

  const output = result.output
  const { action, toolsCount, serverStatus } = output

  if (!output.success) {
    return `❌ MCP-SuperAssistant Error:\n${output.error}`
  }

  switch (action) {
    case 'list_tools': {
      if (!output.data || output.data.length === 0) {
        return `✅ No MCP tools currently available through proxy`
      }
      const toolsText = Array.isArray(output.data)
        ? output.data
            .slice(0, 10)
            .map(
              (tool: any, i: number) =>
                `${i + 1}. ${tool.name || JSON.stringify(tool).substring(0, 50)}`,
            )
            .join('\n')
        : JSON.stringify(output.data).substring(0, 500)

      return `✅ MCP Tools Available (${toolsCount} total):\n${toolsText}${toolsCount! > 10 ? '\n... and more' : ''}`
    }

    case 'execute_tool': {
      const resultText =
        typeof output.data === 'string'
          ? output.data
          : JSON.stringify(output.data, null, 2).substring(0, 1000)

      return `✅ Tool Execution Result:\n${resultText}`
    }

    case 'get_server_status': {
      return `✅ MCP-SuperAssistant Proxy Status: ${serverStatus}\nServer Info: ${typeof output.data === 'string' ? output.data : JSON.stringify(output.data, null, 2).substring(0, 500)}`
    }

    default:
      return `✅ Action completed: ${action}`
  }
}
