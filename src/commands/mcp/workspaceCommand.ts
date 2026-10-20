import { ensureWebUIStarted, stopWebUI } from '../../services/webUI/index.js'
import { getWebUIPort } from '../../services/webUI/WebUIServer.js'

export function workspaceCmd(args: string): string {
  if (args.includes('stop')) { stopWebUI(); return 'WebUI detenido' }
  if (args.includes('status')) { return `WebUI: http://localhost:${getWebUIPort()}` }
  ensureWebUIStarted()
  return `WebUI iniciado: http://localhost:${getWebUIPort()}`
} 
