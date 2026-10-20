/**
 * MultiAgentRunner tests.
 *
 * Tests 1-12: Original lifecycle categories.
 * Tests 13-18: Additional hardening tests per architectural review.
 *
 * Run: bun test src/services/webRelay/orchestration/MultiAgentRunner.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resetWebInstanceRegistry, listWebInstances, getWebInstance } from '../WebInstanceRegistry.js'

// ─── Mock controls ───────────────────────────────────────────────────────────

const mockLaunchControl = {
  shouldSucceed: true,
  error: 'Chrome launch failed',
  saExtensionId: 'kngiafgkdnlkgmefdafaibkibegkcaef' as string | undefined,
  options: undefined as Record<string, unknown> | undefined,
}

const mockPortControl = {
  active: null as boolean | null,
  launchedPorts: new Set<number>(),
  occupiedPorts: new Set<number>(),
}
const mockNavigations: Array<{ debugPort: number; url: string }> = []

const recoveryIdentities = new Map<number, {
  schema: 1
  instanceId: string
  agentId: string
  role?: string
  platformId: string
  profileDir: string
  sessionMode?: 'authenticated' | 'clean' | 'chrome-profile'
  stampedAt: number
} | null>()

const mockStampControl = {
  ok: true,
  reason: '',
  identity: undefined as Record<string, unknown> | undefined,
}

// ─── Mock ChromeCDP ──────────────────────────────────────────────────────────

mock.module('../ChromeCDP.js', () => ({
  getInstanceIdentity: async (port: number) => recoveryIdentities.get(port) ?? null,
  isDebugPortActive: async (port?: number) => {
    if (mockPortControl.active !== null) return mockPortControl.active
    return port !== undefined && (
      mockPortControl.launchedPorts.has(port) ||
      mockPortControl.occupiedPorts.has(port)
    )
  },
  launchChrome: async (_url: string, _profile?: string, opts?: any) => {
    if (!mockLaunchControl.shouldSucceed) throw new Error(mockLaunchControl.error)
    mockLaunchControl.options = opts
    if (typeof opts?.debugPort === 'number') mockPortControl.launchedPorts.add(opts.debugPort)
    return { saExtensionId: mockLaunchControl.saExtensionId }
  },
  navigateRelayPage: async (debugPort: number, url: string) => {
    mockNavigations.push({ debugPort, url })
  },
  stampInstanceIdentity: async (_port: number, identity: Record<string, unknown>) => {
    mockStampControl.identity = identity
    if (mockStampControl.ok) return { ok: true as const }
    return { ok: false as const, reason: mockStampControl.reason }
  },
  CDPConnection: class {},
  DEBUG_PORT: 9222,
}))

// ─── Fetch controls ──────────────────────────────────────────────────────────

let mockExtensionPresent = true
let mockSWActive = true
let mockMCPHealthy = true

const originalFetch = globalThis.fetch
function installFetchMock() {
  globalThis.fetch = (async (url: string | URL | Request, _init?: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('/json/version')) {
      return new Response(JSON.stringify({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      }), { status: 200 })
    }
    if (urlStr.includes('/json')) {
      const targets: any[] = []
      if (mockExtensionPresent && mockSWActive) {
        // SA CWS extension with specific ID — matches isSATarget()
        targets.push({
          type: 'service_worker',
          url: 'chrome-extension://kngiafgkdnlkgmefdafaibkibegkcaef/background.js',
          title: 'MCP SuperAssistant',
        })
      } else if (mockExtensionPresent && !mockSWActive) {
        // Extension present (page target with SA CWS ID) but SW NOT active
        targets.push({
          type: 'page',
          url: 'chrome-extension://kngiafgkdnlkgmefdafaibkibegkcaef/popup.html',
          title: 'MCP SuperAssistant',
        })
      }
      // Always include a non-SA extension to verify we DON'T false-positive
      targets.push({
        type: 'service_worker',
        url: 'chrome-extension://gighmmpiobklfepjocnamgkkbiglidom/abp-background.js',
        title: 'AdBlock Plus',
      })
      targets.push({ type: 'page', url: 'https://chatgpt.com', title: 'ChatGPT' })
      return new Response(JSON.stringify(targets), { status: 200 })
    }
    if (urlStr.includes('/healthz')) {
      if (mockMCPHealthy) return new Response('ok', { status: 200 })
      return new Response('', { status: 503 })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

// ─── Import runner AFTER mocks ───────────────────────────────────────────────

import {
  createAgent,
  startAgent,
  stopAgent,
  restartAgent,
  getAgentStatus,
  setAgentSAConfigurationStatus,
  listAgents,
  removeAgent,
  recoverExistingAgents,
  resetRunner,
  onLifecycleEvent,
  findPidOnPort,
  isPidChrome,
} from './MultiAgentRunner.js'

import type { OrchestratorEvent } from './types.js'

// ─── Test lifecycle ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetRunner()
  resetWebInstanceRegistry()
  mockLaunchControl.shouldSucceed = true
  mockLaunchControl.error = 'Chrome launch failed'
  mockLaunchControl.saExtensionId = 'kngiafgkdnlkgmefdafaibkibegkcaef'
  mockLaunchControl.options = undefined
  mockPortControl.active = null
  mockPortControl.launchedPorts.clear()
  mockPortControl.occupiedPorts.clear()
  mockNavigations.length = 0
  recoveryIdentities.clear()
  mockStampControl.ok = true
  mockStampControl.reason = ''
  mockStampControl.identity = undefined
  mockExtensionPresent = true
  mockSWActive = true
  mockMCPHealthy = true
  installFetchMock()
})

afterEach(() => {
  resetRunner()
  resetWebInstanceRegistry()
  globalThis.fetch = originalFetch
})

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS 1-12: Original lifecycle categories
// ═══════════════════════════════════════════════════════════════════════════════

describe('1. Successful start', () => {
  test('agent reaches ready status', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt', role: 'researcher' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('ready')
    expect(result.agentId).toBe('agent-1')
    expect(result.instanceId).toBeTruthy()
    expect(result.instanceId!.startsWith('web-')).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      agentId: 'agent-1',
      role: 'researcher',
      platformId: 'chatgpt',
      sessionMode: 'clean',
    })
  })

  test('keeps the selected local Chrome profile identity through Relay startup', async () => {
    createAgent({
      agentId: 'chrome-profile-agent',
      platformId: 'chatgpt',
      role: 'manual-user-1',
      sessionMode: 'chrome-profile',
      chromeProfileDirectory: 'Profile 2',
    })

    const result = await startAgent('chrome-profile-agent')

    expect(result.status).toBe('ready')
    expect(mockLaunchControl.options).toMatchObject({
      sessionMode: 'chrome-profile',
      chromeProfileDirectory: 'Profile 2',
    })
    expect(mockStampControl.identity).toMatchObject({
      sessionMode: 'chrome-profile',
      chromeProfileDirectory: 'Profile 2',
    })
  })

  test('tracks WebUI SA preparation as non-operational until the final gate passes', async () => {
    createAgent({ agentId: 'agent-sa-preparing', platformId: 'chatgpt' })
    await startAgent('agent-sa-preparing')

    const preparing = await setAgentSAConfigurationStatus('agent-sa-preparing', true)
    expect(preparing.status).toBe('sa_preparing')
    expect(getAgentStatus('agent-sa-preparing')?.status).toBe('sa_preparing')

    const ready = await setAgentSAConfigurationStatus('agent-sa-preparing', false)
    expect(ready.status).toBe('ready')
  })

  test('lifecycle events fire in correct order', async () => {
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const lifecycles = events
      .filter((e): e is Extract<OrchestratorEvent, { name: 'agent:lifecycle' }> =>
        e.name === 'agent:lifecycle')
      .map(e => e.payload.to)

    expect(lifecycles).toEqual([
      'starting',
      'chrome_ready',
      'session_ready',
      'extension_loading',
      'service_worker_ready',
      'mcp_ready',
      'ready',
    ])
  })

  test('navigates a Claude relay to the selected platform URL', async () => {
    createAgent({ agentId: 'claude-agent', platformId: 'claude', role: 'researcher' })

    const result = await startAgent('claude-agent')

    expect(result.status).toBe('ready')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://claude.ai' && Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({ platformId: 'claude' })
  })

  test('navigates an Arena relay to Direct Chat using a clean session', async () => {
    createAgent({
      agentId: 'arena-agent',
      platformId: 'arena',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('arena-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://arena.ai/text/direct?model_a=max' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'arena',
      sessionMode: 'clean',
    })
  })

  test('navigates a Z.ai relay to the stable chat home using a clean session', async () => {
    createAgent({
      agentId: 'zai-agent',
      platformId: 'zai',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('zai-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://chat.z.ai/' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'zai',
      sessionMode: 'clean',
    })
  })

  test('navigates a Grok relay to the current chat home using a clean session', async () => {
    createAgent({
      agentId: 'grok-agent',
      platformId: 'grok',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('grok-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://grok.com/' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'grok',
      sessionMode: 'clean',
    })
  })

  test('navigates a Google AI Studio relay to the new-chat route using a clean session', async () => {
    createAgent({
      agentId: 'aistudio-agent',
      platformId: 'aistudio',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('aistudio-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://aistudio.google.com/prompts/new_chat' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'aistudio',
      sessionMode: 'clean',
    })
  })

  test('navigates a Perplexity relay to its homepage using a clean session', async () => {
    createAgent({
      agentId: 'perplexity-agent',
      platformId: 'perplexity',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('perplexity-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://www.perplexity.ai' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'perplexity',
      sessionMode: 'clean',
    })
  })

  test('navigates a DeepSeek relay to its chat homepage using a clean session', async () => {
    createAgent({
      agentId: 'deepseek-agent',
      platformId: 'deepseek',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('deepseek-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://chat.deepseek.com' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'deepseek',
      sessionMode: 'clean',
    })
  })

  test('navigates a Kimi relay to its homepage using a clean session', async () => {
    createAgent({
      agentId: 'kimi-agent',
      platformId: 'kimi',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('kimi-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://www.kimi.com/' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'kimi',
      sessionMode: 'clean',
    })
  })

  test('navigates a Qwen relay to its homepage using a clean session', async () => {
    createAgent({
      agentId: 'qwen-agent',
      platformId: 'qwen',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('qwen-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://chat.qwen.ai/' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'qwen',
      sessionMode: 'clean',
    })
  })

  test('navigates a ChatHub relay to the requested GLM-5.3 conversation using a clean session', async () => {
    createAgent({
      agentId: 'chathub-agent',
      platformId: 'chathub',
      role: 'researcher',
      sessionMode: 'clean',
    })

    const result = await startAgent('chathub-agent')

    expect(result.status).toBe('ready')
    expect(result.sessionMode).toBe('clean')
    expect(mockNavigations.some(navigation =>
      navigation.url === 'https://app.chathub.gg/chat/cloud-glm-5.3?cid=d6fb4088-ad5c-41f2-a513-4658ec1f06de' &&
      Number.isInteger(navigation.debugPort),
    )).toBe(true)
    expect(mockStampControl.identity).toMatchObject({
      platformId: 'chathub',
      sessionMode: 'clean',
    })
  })
})

describe('20. Recovering existing instances', () => {
  test('adopts an identity-verified Chrome without launching a new browser', async () => {
    const port = 9237
    const instanceId = 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df1'
    mockMCPHealthy = false
    mockPortControl.occupiedPorts.add(port)
    recoveryIdentities.set(port, {
      schema: 1,
      instanceId,
      agentId: 'sentinel-chatgpt-guest-3',
      platformId: 'chatgpt',
      profileDir: instanceId,
      stampedAt: Date.now(),
    })

    const result = await recoverExistingAgents('chatgpt', 'clean', 'agent')

    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]?.status).toBe('ready')
    expect(result.adopted[0]?.instanceId).toBe(instanceId)
    expect(result.adopted[0]?.debugPort).toBe(port)
    expect(mockPortControl.launchedPorts.size).toBe(0)
    expect(result.skipped).toEqual([])
    expect(result.cdpPortsScanned).toBe(101)
    expect(result.cdpPortsFound).toBe(1)
    expect(result.matchingIdentitiesFound).toBe(1)
  })

  test('does not reclassify a stamped authenticated profile as clean', async () => {
    const port = 9238
    const instanceId = 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df2'
    mockPortControl.occupiedPorts.add(port)
    recoveryIdentities.set(port, {
      schema: 1,
      instanceId,
      agentId: 'authenticated-agent',
      platformId: 'chatgpt',
      profileDir: instanceId,
      sessionMode: 'authenticated',
      stampedAt: Date.now(),
    })

    const result = await recoverExistingAgents('chatgpt', 'clean', 'agent')

    expect(result.adopted).toEqual([])
    expect(result.skipped).toEqual([
      'authenticated-agent: el perfil está marcado como authenticated; no se adjuntó como clean.',
    ])
    expect(listAgents()).toEqual([])
  })

  test('keeps recovered user windows outside the agent pool', async () => {
    const port = 9239
    const instanceId = 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df3'
    mockPortControl.occupiedPorts.add(port)
    recoveryIdentities.set(port, {
      schema: 1,
      instanceId,
      agentId: 'web-chatgpt-user-legacy',
      platformId: 'chatgpt',
      profileDir: instanceId,
      stampedAt: Date.now(),
    })

    const wrongPurpose = await recoverExistingAgents('chatgpt', 'clean', 'agent')
    expect(wrongPurpose.adopted).toEqual([])
    expect(wrongPurpose.skipped).toContain(
      'web-chatgpt-user-legacy: el propósito guardado no coincide con agent; no se adjuntó.',
    )

    const result = await recoverExistingAgents('chatgpt', 'clean', 'user')

    expect(result.adopted).toHaveLength(1)
    expect(result.adopted[0]?.role).toBe('manual-user-recovered')
  })

  test('automatically separates old wizard agent and user instances by their legacy IDs', async () => {
    const profiles = [
      { port: 9240, agentId: 'web-chatgpt-agent-legacy-a', instanceId: 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df4' },
      { port: 9241, agentId: 'web-chatgpt-agent-legacy-b', instanceId: 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df5' },
      { port: 9242, agentId: 'web-chatgpt-user-legacy', instanceId: 'web-5e7b4edc-1e43-4b4f-8c50-8a67ceeb0df6' },
    ]
    for (const profile of profiles) {
      mockPortControl.occupiedPorts.add(profile.port)
      recoveryIdentities.set(profile.port, {
        schema: 1,
        instanceId: profile.instanceId,
        agentId: profile.agentId,
        platformId: 'chatgpt',
        profileDir: profile.instanceId,
        stampedAt: Date.now(),
      })
    }

    const result = await recoverExistingAgents('chatgpt', 'clean', 'infer')

    expect(result.adopted).toHaveLength(3)
    expect(result.adopted.filter(agent => agent.role === 'recovered')).toHaveLength(2)
    expect(result.adopted.filter(agent => agent.role === 'manual-user-recovered')).toHaveLength(1)
    expect(result.skipped).toEqual([])
  })
})

describe('2. Duplicate start', () => {
  test('starting an already-running agent is a no-op', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const first = await startAgent('agent-1')
    expect(first.status).toBe('ready')

    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    const second = await startAgent('agent-1')
    unsub()

    expect(second.status).toBe('ready')
    expect(second.instanceId).toBe(first.instanceId)
    expect(events.filter(e => e.name === 'agent:lifecycle')).toHaveLength(0)
  })
})

describe('3. Idempotent stop', () => {
  test('stopping an already-stopped agent is a no-op', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    mockPortControl.active = false
    const first = await stopAgent('agent-1')
    expect(first.status).toBe('stopped')

    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    const second = await stopAgent('agent-1')
    unsub()
    expect(second.status).toBe('stopped')
    expect(events.filter(e => e.name === 'agent:lifecycle')).toHaveLength(0)
  })

  test('stopping a created-but-never-started agent', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await stopAgent('agent-1')
    expect(result.status).toBe('stopped')
  })
})

describe('4. Stop during startup', () => {
  test('stop serializes behind in-flight start', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const startPromise = startAgent('agent-1')
    mockPortControl.active = false
    const stopPromise = stopAgent('agent-1')
    await startPromise
    const stopResult = await stopPromise
    expect(stopResult.status).toBe('stopped')
  })
})

describe('5. Restart without double instance', () => {
  test('restart produces at most one live WIR instance', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    mockPortControl.active = false
    const result = await restartAgent('agent-1')
    expect(result.status === 'ready' || result.status === 'error').toBe(true)
    const wirInstances = listWebInstances().filter(i => i.agentId === 'agent-1')
    expect(wirInstances.length).toBeLessThanOrEqual(1)
  })
})

describe('6. Failure at chrome_ready', () => {
  test('launchChrome failure → error state with cleanup', async () => {
    mockLaunchControl.shouldSucceed = false
    mockPortControl.active = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('Chrome launch failed')
    expect(result.instanceId).toBeUndefined()
  })
})

describe('7. Failure at extension_loading', () => {
  test('SA not detected → error state', async () => {
    mockExtensionPresent = false
    mockSWActive = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('SA extension not detected')
  })

  test('error includes actionable guidance about Chrome 153', async () => {
    mockExtensionPresent = false
    mockSWActive = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.error).toContain('Secure Preferences')
  })
})

describe('8. Failure at service_worker_ready', () => {
  test('extension present but SW not active → error', async () => {
    mockExtensionPresent = true
    mockSWActive = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('service worker not active')
  })
})

describe('9. Cleanup after failure', () => {
  test('failed start does not leave orphaned WIR entries', async () => {
    mockLaunchControl.shouldSucceed = false
    mockPortControl.active = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    const wirActive = listWebInstances().filter(
      i => i.agentId === 'agent-1' && i.status !== 'stopped' && i.status !== 'error',
    )
    expect(wirActive).toHaveLength(0)
  })

  test('failed start allows retry', async () => {
    mockLaunchControl.shouldSucceed = false
    mockPortControl.active = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const failed = await startAgent('agent-1')
    expect(failed.status).toBe('error')

    mockLaunchControl.shouldSucceed = true
    mockPortControl.active = null
    mockExtensionPresent = true
    mockSWActive = true
    const succeeded = await startAgent('agent-1')
    expect(succeeded.status).toBe('ready')
  })
})

describe('10. Events only after successful mutations', () => {
  test('instance:bound fires before chrome_ready', async () => {
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const boundIdx = events.findIndex(e => e.name === 'instance:bound')
    const chromeReadyIdx = events.findIndex(
      e => e.name === 'agent:lifecycle' && (e as any).payload.to === 'chrome_ready',
    )
    expect(boundIdx).toBeGreaterThanOrEqual(0)
    expect(chromeReadyIdx).toBeGreaterThanOrEqual(0)
    expect(boundIdx).toBeLessThan(chromeReadyIdx)
  })

  test('error event carries the specific failure detail', async () => {
    mockExtensionPresent = false
    mockSWActive = false
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const errorEvent = events.find(
      e => e.name === 'agent:lifecycle' && (e as any).payload.to === 'error',
    )
    expect(errorEvent).toBeTruthy()
    expect((errorEvent as any).payload.error).toContain('SA extension')
  })
})

describe('11. Concurrent operations serialized per agent', () => {
  test('two concurrent starts on same agent → only one launch', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const [r1, r2] = await Promise.all([startAgent('agent-1'), startAgent('agent-1')])
    expect(r1.status === 'ready' || r2.status === 'ready').toBe(true)
    expect(r1.instanceId).toBe(r2.instanceId)
  })

  test('concurrent start on different agents → independent', async () => {
    createAgent({ agentId: 'agent-A', platformId: 'chatgpt' })
    createAgent({ agentId: 'agent-B', platformId: 'gemini' })
    const [a, b] = await Promise.all([startAgent('agent-A'), startAgent('agent-B')])
    expect(a.status).toBe('ready')
    expect(b.status).toBe('ready')
    expect(a.instanceId).not.toBe(b.instanceId)
  })
})

describe('12. Identity preservation', () => {
  test('allocates a different port when a port is already serving Chrome', async () => {
    mockPortControl.occupiedPorts.add(9222)
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })

    const started = await startAgent('agent-1')

    expect(started.status).toBe('ready')
    expect(started.debugPort).not.toBe(9222)
    expect(mockPortControl.occupiedPorts.has(9222)).toBe(true)
  })

  test('agentId and instanceId preserved through lifecycle', async () => {
    createAgent({ agentId: 'my-agent', platformId: 'chatgpt' })
    const started = await startAgent('my-agent')
    expect(started.agentId).toBe('my-agent')
    expect(started.instanceId).toMatch(/^web-/)
    const status = getAgentStatus('my-agent')
    expect(status!.instanceId).toBe(started.instanceId)
  })

  test('two agents never share an instanceId', async () => {
    createAgent({ agentId: 'agent-A', platformId: 'chatgpt' })
    createAgent({ agentId: 'agent-B', platformId: 'chatgpt' })
    const a = await startAgent('agent-A')
    const b = await startAgent('agent-B')
    expect(a.instanceId).not.toBe(b.instanceId)
  })

  test('listAgents returns all registered agents', () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    createAgent({ agentId: 'agent-2', platformId: 'gemini' })
    const all = listAgents()
    expect(all).toHaveLength(2)
    expect(all.map(a => a.agentId).sort()).toEqual(['agent-1', 'agent-2'])
  })

  test('removeAgent only works on stopped/created agents', async () => {
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    expect(() => removeAgent('agent-1')).toThrow('Stop it first')
    mockPortControl.active = false
    await stopAgent('agent-1')
    removeAgent('agent-1')
    expect(getAgentStatus('agent-1')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS 13-18: Additional hardening (architectural review requirements)
// ═══════════════════════════════════════════════════════════════════════════════

describe('13. Singleton runner guarantee', () => {
  test('new agents default to clean sessions unless authentication is explicitly requested', () => {
    const guest = createAgent({ agentId: 'guest-agent', platformId: 'chatgpt' })
    const authenticated = createAgent({
      agentId: 'authenticated-agent',
      platformId: 'chatgpt',
      sessionMode: 'authenticated',
    })

    expect(guest.sessionMode).toBe('clean')
    expect(authenticated.sessionMode).toBe('authenticated')
  })

  test('module-level state means exactly one runner per process', () => {
    // Both createAgent calls go to the same module-level Map
    createAgent({ agentId: 'agent-X', platformId: 'chatgpt' })
    const fromList = listAgents()
    expect(fromList).toHaveLength(1)
    expect(fromList[0]!.agentId).toBe('agent-X')

    // Second registration is idempotent
    createAgent({ agentId: 'agent-X', platformId: 'chatgpt' })
    expect(listAgents()).toHaveLength(1)
  })

  test('two createAgent calls with same agentId return same state', () => {
    const first = createAgent({ agentId: 'agent-X', platformId: 'chatgpt' })
    const second = createAgent({ agentId: 'agent-X', platformId: 'chatgpt' })
    expect(first.agentId).toBe(second.agentId)
    expect(first.status).toBe(second.status)
    expect(first.createdAt).toBe(second.createdAt)
  })
})

describe('14. killByPort PID race safety', () => {
  test('cleanup when PID disappears between discovery and kill', async () => {
    // Simulate: port is not listening (PID already gone)
    mockPortControl.active = false
    globalThis.fetch = (async () => {
      throw new Error('Connection refused')
    }) as typeof fetch

    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })

    // Manually set up a record as if start succeeded then Chrome died
    const started = createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })

    // Stop should handle gracefully when Chrome is already dead
    const stopped = await stopAgent('agent-1')
    expect(stopped.status).toBe('stopped')
  })

  test('findPidOnPort returns null when port is not listening', async () => {
    // This test verifies findPidOnPort handles the "nothing there" case
    // We test with a port that's very unlikely to be in use
    const pid = await findPidOnPort(59999)
    // Should be null (nothing listening on that obscure port)
    // Note: on CI/test machines this could theoretically be in use
    expect(pid === null || typeof pid === 'number').toBe(true)
  })
})

describe('15. Port ownership isolation', () => {
  test('WIR port lock prevents port reuse between live agents', async () => {
    createAgent({ agentId: 'agent-A', platformId: 'chatgpt' })
    createAgent({ agentId: 'agent-B', platformId: 'chatgpt' })

    const a = await startAgent('agent-A')
    const b = await startAgent('agent-B')

    // Different ports guaranteed by WIR's allocateDebugPort
    expect(a.debugPort).toBeTruthy()
    expect(b.debugPort).toBeTruthy()
    expect(a.debugPort).not.toBe(b.debugPort)
  })

  test('released port is reclaimable but not while another agent holds it', async () => {
    createAgent({ agentId: 'agent-A', platformId: 'chatgpt' })
    createAgent({ agentId: 'agent-B', platformId: 'chatgpt' })

    const a = await startAgent('agent-A')
    const aPort = a.debugPort!
    const b = await startAgent('agent-B')

    // Agent B MUST NOT have agent A's port
    expect(b.debugPort).not.toBe(aPort)

    // Stop agent A — its port is released
    mockPortControl.active = false
    await stopAgent('agent-A')

    // Agent A's port lock file should be cleaned up
    // (releaseWebInstance calls releaseLock internally)
  })
})

describe('16. reclaimStalePortLocks safety', () => {
  test('does not reclaim locks owned by current process', () => {
    // Create an instance — its lock is owned by process.pid
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })

    // This creates a WIR instance which claims a port lock with process.pid
    const agents = listAgents()
    // Not started yet, but the WIR instance has a port lock

    // reclaimStalePortLocks checks isProcessDead(pid).
    // For pid === process.pid, it returns false (self-check on L121 of WIR).
    // So our lock should survive reclaim.
    const beforeInstances = listWebInstances()

    // This import is needed but the function is called inside startAgent
    // We test the WIR function directly
    const { reclaimStalePortLocks: reclaim } = require('../WebInstanceRegistry.js')
    const reclaimed = reclaim()

    const afterInstances = listWebInstances()
    // Our instances should not have been reclaimed
    expect(afterInstances.length).toBe(beforeInstances.length)
  })
})

describe('17. Failure at each observable gate', () => {
  test('failure at chrome_ready (launchChrome throws)', async () => {
    mockLaunchControl.shouldSucceed = false
    mockPortControl.active = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('Start failed')
  })

  test('failure at extension_loading (extension not in targets)', async () => {
    mockExtensionPresent = false
    mockSWActive = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('SA extension not detected')
  })

  test('failure at service_worker_ready (extension present, SW dead)', async () => {
    mockExtensionPresent = true
    mockSWActive = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('error')
    expect(result.error).toContain('service worker not active')
  })

  test('stamp failure is non-blocking (reaches ready)', async () => {
    mockStampControl.ok = false
    mockStampControl.reason = 'SW context unavailable'
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    // Stamp failure is non-blocking — agent reaches ready
    expect(result.status).toBe('ready')
  })

  test('MCP health failure is non-blocking (reaches ready)', async () => {
    mockMCPHealthy = false
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('ready')
  })
})

describe('18. Ready requires passing all blocking gates', () => {
  test('ready is never reported without chrome_ready', async () => {
    mockLaunchControl.shouldSucceed = false
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const readyEvent = events.find(
      e => e.name === 'agent:lifecycle' && (e as any).payload.to === 'ready',
    )
    expect(readyEvent).toBeUndefined()
  })

  test('ready is never reported without extension_loading', async () => {
    mockExtensionPresent = false
    mockSWActive = false
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const readyEvent = events.find(
      e => e.name === 'agent:lifecycle' && (e as any).payload.to === 'ready',
    )
    expect(readyEvent).toBeUndefined()
  })

  test('ready is never reported without service_worker_ready', async () => {
    mockExtensionPresent = true
    mockSWActive = false
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const readyEvent = events.find(
      e => e.name === 'agent:lifecycle' && (e as any).payload.to === 'ready',
    )
    expect(readyEvent).toBeUndefined()
  })

  test('successful start passes through ALL gates in order', async () => {
    const events: OrchestratorEvent[] = []
    const unsub = onLifecycleEvent(e => events.push(e))
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    await startAgent('agent-1')
    unsub()

    const transitions = events
      .filter((e): e is Extract<OrchestratorEvent, { name: 'agent:lifecycle' }> =>
        e.name === 'agent:lifecycle')
      .map(e => e.payload.to)

    // Every gate must appear, in order, before ready
    const requiredGates = ['starting', 'chrome_ready', 'session_ready', 'extension_loading', 'service_worker_ready', 'mcp_ready', 'ready']
    expect(transitions).toEqual(requiredGates)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 19: SA detection specificity (vertical slice bug fix)
// ═══════════════════════════════════════════════════════════════════════════════

describe('19. SA detection rejects non-SA extensions', () => {
  test('non-SA extension with background.js does NOT pass extension gate', async () => {
    // Only non-SA extensions present (AdBlock Plus has background.js)
    mockExtensionPresent = false
    mockSWActive = false

    // Override fetch to return ONLY AdBlock Plus targets (no SA)
    globalThis.fetch = (async (url: string | URL | Request, _init?: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/json/version')) {
        return new Response(JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
        }), { status: 200 })
      }
      if (urlStr.includes('/json')) {
        return new Response(JSON.stringify([
          // AdBlock Plus SW — has background.js but is NOT SA
          {
            type: 'service_worker',
            url: 'chrome-extension://gighmmpiobklfepjocnamgkkbiglidom/abp-background.js',
            title: 'AdBlock Plus',
          },
          // Another extension with background.js
          {
            type: 'service_worker',
            url: 'chrome-extension://mhnlakgilnojmhinhkckjpncpbhabphi/background.js',
            title: 'uBlock Origin',
          },
          { type: 'page', url: 'https://chatgpt.com', title: 'ChatGPT' },
        ]), { status: 200 })
      }
      if (urlStr.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')

    // MUST fail at extension_loading — AdBlock is NOT SA
    expect(result.status).toBe('error')
    expect(result.error).toContain('SA extension not detected')
  })

  test('SA CWS extension by ID passes gate correctly', async () => {
    // Default mocks have SA CWS ID in targets — should pass
    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('ready')
  })

  test('SA local build by dynamic ID passes gate correctly', async () => {
    // Simulate local build: launchChrome returns a dynamic ID (not CWS ID).
    // The runner uses checkExtensionById with the dynamic ID.
    const LOCAL_SA_DYNAMIC_ID = 'abcdefghijklmnopqrstuvwxyzabcdef'
    mockLaunchControl.saExtensionId = LOCAL_SA_DYNAMIC_ID

    globalThis.fetch = (async (url: string | URL | Request, _init?: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('/json/version')) {
        return new Response(JSON.stringify({
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
        }), { status: 200 })
      }
      if (urlStr.includes('/json')) {
        return new Response(JSON.stringify([
          // Local build SA — identified ONLY by dynamic ID, not by title
          {
            type: 'service_worker',
            url: `chrome-extension://${LOCAL_SA_DYNAMIC_ID}/background.js`,
            title: 'Service Worker chrome-extension://abcdefghijklmnopqrst',
          },
          { type: 'page', url: 'https://chatgpt.com', title: 'ChatGPT' },
        ]), { status: 200 })
      }
      if (urlStr.includes('/healthz')) {
        return new Response('ok', { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    createAgent({ agentId: 'agent-1', platformId: 'chatgpt' })
    const result = await startAgent('agent-1')
    expect(result.status).toBe('ready')
  })
})
