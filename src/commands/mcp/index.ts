import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  immediate: true,
  argumentHint: '[enable|disable [server-name]] | [set-mode api|web|auto] | [status]',
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
