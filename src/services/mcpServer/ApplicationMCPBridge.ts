import type { MCPSSEServer } from './MCPSSEServer.js'
import { MCP_PORT } from './mcpPort.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'

type BridgeServer = Pick<MCPSSEServer, 'start' | 'stop'>
export type BridgeState = 'stopped' | 'owned' | 'external' | 'error'
interface BridgeDependencies<T extends BridgeServer> {
  create: () => Promise<T>
  probe: () => Promise<boolean>
  changed?: (server: T | null) => void
}

/** Owns only servers created by this application; never terminates an external process. */
export class ManagedMCPBridge<T extends BridgeServer> {
  private server: T | null = null
  private state: BridgeState = 'stopped'
  private error: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly dependencies: BridgeDependencies<T>) {}

  status() { return { state: this.state, error: this.error } }

  private serialize<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async startInternal() {
    if (this.server) return this.status()
    this.error = null
    try {
      if (await this.dependencies.probe()) {
        this.state = 'external'
        return this.status()
      }
      const server = await this.dependencies.create()
      await server.start()
      this.server = server
      this.dependencies.changed?.(server)
      this.state = 'owned'
      return this.status()
    } catch (error) {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async stopInternal() {
    if (this.server) {
      await this.server.stop()
      this.server = null
      this.dependencies.changed?.(null)
      this.state = 'stopped'
      this.error = null
    } else if (this.state !== 'external') {
      this.state = 'stopped'
      this.error = null
    }
    return this.status()
  }

  syncMode(mode: string) {
    return this.serialize(() => mode === 'web' ? this.startInternal() : this.stopInternal())
  }

  start(allowed: () => boolean = () => true) {
    return this.serialize(() => {
      if (!allowed()) throw new Error('La conexión con SuperAssistant solo está disponible en modo Web. Selecciona Web en /mode.')
      return this.startInternal()
    })
  }
  stop() { return this.serialize(() => this.stopInternal()) }
  restart(allowed: () => boolean = () => true) {
    return this.serialize(async () => {
      if (!allowed()) throw new Error('La conexión con SuperAssistant solo está disponible en modo Web. Selecciona Web en /mode.')
      if (!this.server && await this.dependencies.probe()) {
        this.state = 'external'
        throw new Error('La conexión pertenece a otro proceso de OpenWebLock. Reiníciala desde la aplicación que la inició.')
      }
      await this.stopInternal()
      return this.startInternal()
    })
  }
}

export let applicationMCPServer: MCPSSEServer | null = null
export const applicationMCPBridge = new ManagedMCPBridge<MCPSSEServer>({
  create: async () => {
    const { MCPSSEServer } = await import('./MCPSSEServer.js')
    return new MCPSSEServer({ port: MCP_PORT })
  },
  probe: async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/relay/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) return false
      const status = await response.json() as { available?: unknown }
      return status.available === true
    } catch { return false }
  },
  changed: server => { applicationMCPServer = server },
})

let cleanupRegistered = false
let unsubscribeMode: (() => void) | null = null
async function registerApplicationBridgeLifecycle() {
  const config = await import('../../utils/config.js')
  if (!cleanupRegistered) {
    unsubscribeMode = config.subscribeToMcpExecutionModeChange(mode => {
      void applicationMCPBridge.syncMode(mode).catch(error => {
        console.error('[Conexión]', error instanceof Error ? error.message : String(error))
      })
    })
    registerCleanup(async () => {
      unsubscribeMode?.()
      unsubscribeMode = null
      cleanupRegistered = false
      await applicationMCPBridge.stop()
    })
    cleanupRegistered = true
  }
  return config
}

export async function initializeApplicationMCPBridge() {
  const config = await registerApplicationBridgeLifecycle()
  return applicationMCPBridge.syncMode(config.getCurrentProjectConfig().mcpExecutionMode ?? 'api')
}

async function requireWebMode() {
  const config = await registerApplicationBridgeLifecycle()
  if (config.getCurrentProjectConfig().mcpExecutionMode !== 'web') {
    throw new Error('La conexión con SuperAssistant solo está disponible en modo Web. Selecciona Web en /mode.')
  }
  return config
}

export async function startApplicationMCPBridge() {
  const config = await requireWebMode()
  return applicationMCPBridge.start(() => config.getCurrentProjectConfig().mcpExecutionMode === 'web')
}

export async function restartApplicationMCPBridge() {
  const config = await requireWebMode()
  return applicationMCPBridge.restart(() => config.getCurrentProjectConfig().mcpExecutionMode === 'web')
}
