import { describe, expect, it } from 'bun:test'
import { ManagedMCPBridge } from './ApplicationMCPBridge.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig, subscribeToMcpExecutionModeChange } from '../../utils/config.js'

function setup() {
  const events: string[] = []
  const bridge = new ManagedMCPBridge({
    probe: async () => false,
    create: async () => ({
      start: async () => { events.push('start') },
      stop: async () => { events.push('stop') },
    }),
  })
  return { bridge, events }
}

describe('MCP bridge mode policy', () => {
  it('does not start on API or Local startup', async () => {
    const { bridge, events } = setup()
    await bridge.syncMode('api')
    await bridge.syncMode('local')
    expect(events).toEqual([])
    expect(bridge.status().state).toBe('stopped')
  })
  it('rejects a queued manual start after the mode changes to API', async () => {
    const { bridge, events } = setup()
    let mode: string = 'web'
    const starting = bridge.start(() => mode === 'web')
    mode = 'api'
    await expect(starting).rejects.toThrow('modo Web')
    expect(events).toEqual([])
    expect(bridge.status().state).toBe('stopped')
  })
  it('starts in Web without a browser', async () => {
    const { bridge, events } = setup()
    await bridge.syncMode('web')
    expect(events).toEqual(['start'])
    expect(bridge.status().state).toBe('owned')
  })
  for (const mode of ['api', 'local']) {
    it(`closes the owned server when changing Web to ${mode}`, async () => {
      const { bridge, events } = setup()
      await bridge.syncMode('web')
      await bridge.syncMode(mode)
      expect(events).toEqual(['start', 'stop'])
      expect(bridge.status().state).toBe('stopped')
    })
  }
  it('serializes rapid mode transitions and finishes stopped in Local', async () => {
    const { bridge, events } = setup()
    await Promise.all(['api', 'web', 'api', 'web', 'local'].map(mode => bridge.syncMode(mode)))
    expect(events).toEqual(['start', 'stop', 'start', 'stop'])
    expect(bridge.status().state).toBe('stopped')
  })
  it('notifies only effective mode changes from the shared config writer', () => {
    const original = { ...getCurrentProjectConfig() }
    saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'api' }))
    const events: string[] = []
    const unsubscribe = subscribeToMcpExecutionModeChange(mode => events.push(mode))
    try {
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'web' }))
      saveCurrentProjectConfig(config => ({ ...config, selectedWebPlatform: 'chatgpt' }))
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'web' }))
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'local' }))
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'api' }))
      expect(events).toEqual(['web', 'local', 'api'])
    } finally {
      unsubscribe()
      saveCurrentProjectConfig(() => original)
    }
  })
  it('connects shared mode changes to the bridge lifecycle', async () => {
    const original = { ...getCurrentProjectConfig() }
    const { bridge, events } = setup()
    const pending: Promise<unknown>[] = []
    saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'api' }))
    const unsubscribe = subscribeToMcpExecutionModeChange(mode => { pending.push(bridge.syncMode(mode)) })
    try {
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'web' }))
      saveCurrentProjectConfig(config => ({ ...config, mcpExecutionMode: 'local' }))
      await Promise.all(pending)
      expect(events).toEqual(['start', 'stop'])
      expect(bridge.status().state).toBe('stopped')
    } finally {
      unsubscribe()
      saveCurrentProjectConfig(() => original)
      await bridge.stop()
    }
  })
})
