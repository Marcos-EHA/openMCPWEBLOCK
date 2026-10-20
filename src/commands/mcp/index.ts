import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage SuperAssistant connection, MCP servers and Sentinel',
  immediate: true,
  argumentHint: '[status|ask <tarea>|sentinel|recover|set-mode api|web|local|bridge [start|stop|restart|status]|master-session [add|open|status|ask <id> <prompt>]|lienzo|workspace [start|stop|status]|enable|disable [server-name]]',
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
