export const MCP_SUPERASSISTANT_EXECUTOR_TOOL_NAME = 'execute_mcp_tool_via_superassistant'

export const DESCRIPTION = `Execute MCP tools through the MCP-SuperAssistant proxy server. This allows you to access tools from the browser-based MCP-SuperAssistant system, enabling integration with various MCP servers (Desktop Commander, GitHub, Slack, etc.) without leaving OpenClaude. The proxy must be running locally on port 3006 (configurable via MCP_SUPERASSISTANT_PROXY_URL).`

export const MCP_SUPERASSISTANT_EXECUTOR_PROMPT = `You have access to the MCP SuperAssistant proxy which provides access to various MCP tools through a browser bridge. 

The MCP-SuperAssistant system connects to a local proxy server (default: http://localhost:3006) which handles SSE (Server-Sent Events) communication with MCP servers.

Available MCP servers accessible through this system:
- Desktop Commander: File system operations, desktop control
- GitHub: Repository operations, issue management
- Slack: Message sending, workspace operations
- And any other MCP servers configured in the proxy

Use this tool to:
1. List available MCP tools from all connected servers
2. Execute specific MCP tools by name and parameters
3. Access tools from the browser-based MCP-SuperAssistant ecosystem
4. Bridge between OpenClaude CLI and browser-based MCP tools

The tool handles:
- SSE connection management to the proxy
- Tool discovery and metadata retrieval
- Tool execution with proper parameter validation
- Error handling and connection recovery`
