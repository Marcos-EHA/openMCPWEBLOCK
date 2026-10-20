import { describe, expect, it } from 'bun:test'
import { ManagedMCPBridge } from './ApplicationMCPBridge.js'

function setup(external = false) {
  const calls = { created: 0, started: 0, stopped: 0 }
  const bridge = new ManagedMCPBridge({
    probe: async () => external,
    create: async () => {
      calls.created++
      return {
        start: async () => { calls.started++ },
        stop: async () => { calls.stopped++ },
      }
    },
  })
  return { bridge, calls }
}

describe('Application MCP bridge lifecycle', () => {
  it('starts without a browser dependency', async () => {
    const { bridge, calls } = setup()
    expect((await bridge.start()).state).toBe('owned')
    expect(calls.started).toBe(1)
  })
  it('coalesces concurrent starts into one server', async () => {
    const { bridge, calls } = setup()
    await Promise.all([bridge.start(), bridge.start(), bridge.start()])
    expect(calls.created).toBe(1)
    expect(calls.started).toBe(1)
  })
  it('closes an owned server once and permits starting again', async () => {
    const { bridge, calls } = setup()
    await bridge.start()
    await Promise.all([bridge.stop(), bridge.stop()])
    expect(calls.stopped).toBe(1)
    expect(bridge.status().state).toBe('stopped')
    await bridge.start()
    expect(calls.started).toBe(2)
  })
  it('restarts by stopping the owned server before replacing it', async () => {
    const { bridge, calls } = setup()
    await bridge.start()
    expect((await bridge.restart()).state).toBe('owned')
    expect(calls.stopped).toBe(1)
    expect(calls.started).toBe(2)
  })
  it('never closes or replaces an external server', async () => {
    const { bridge, calls } = setup(true)
    expect((await bridge.start()).state).toBe('external')
    expect((await bridge.stop()).state).toBe('external')
    await expect(bridge.restart()).rejects.toThrow('otro proceso')
    expect(calls.created).toBe(0)
    expect(calls.stopped).toBe(0)
  })
  it('recovers after an initial start failure', async () => {
    let attempts = 0
    const bridge = new ManagedMCPBridge({
      probe: async () => false,
      create: async () => ({
        start: async () => { if (++attempts === 1) throw new Error('occupied') },
        stop: async () => {},
      }),
    })
    await expect(bridge.start()).rejects.toThrow('occupied')
    expect(bridge.status().state).toBe('error')
    expect((await bridge.start()).state).toBe('owned')
    expect(bridge.status().error).toBeNull()
  })
  it('serializes shutdown behind an in-flight start', async () => {
    let release!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => { signalStarted = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const events: string[] = []
    const bridge = new ManagedMCPBridge({
      probe: async () => false,
      create: async () => ({
        start: async () => { events.push('start'); signalStarted(); await barrier },
        stop: async () => { events.push('stop') },
      }),
    })
    const starting = bridge.start()
    await started
    const stopping = bridge.stop()
    release()
    await Promise.all([starting, stopping])
    expect(events).toEqual(['start', 'stop'])
    expect(bridge.status().state).toBe('stopped')
  })
})
