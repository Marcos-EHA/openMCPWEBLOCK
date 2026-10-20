import { expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ManagedMCPBridge } from './ApplicationMCPBridge.js'
import { MCPSSEServer } from './MCPSSEServer.js'

it('starts MCP in Web without a browser and releases its port when switching to API', async () => {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  const bridge = new ManagedMCPBridge({
    create: async () => new MCPSSEServer({ port }),
    probe: async () => false,
  })
  const client = new Client({ name: 'mode-switch-test', version: '1.0.0' })
  try {
    expect((await bridge.syncMode('web')).state).toBe('owned')
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })
    expect(response.ok).toBe(true)
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await bridge.syncMode('api')
    expect(bridge.status().state).toBe('stopped')
    const replacement = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject)
        replacement.listen(port, '127.0.0.1', resolve)
      })
      expect(replacement.listening).toBe(true)
    } finally {
      if (replacement.listening) await new Promise<void>((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()))
    }
  } finally {
    await client.close()
    await bridge.stop()
  }
}, 10000)
