import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentState } from '../webRelay/orchestration/types.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'
import { workspaceInstanceLaunchHistoryStore } from './WorkspaceInstanceLaunchHistoryStore.js'

const control = {
  handshakes: [] as Array<{ agentId: string; role?: string; startsAtVerification: number }>,
  failingHandshakeRoles: new Set<string>(),
  starts: [] as Array<{
    agentId: string
    platformId: string
    role?: string
    sessionMode?: string
    chromeProfileDirectory?: string
  }>,
  stops: [] as string[],
  prepared: [] as Array<{ debugPort: number; extensionId?: string; platformId?: string }>,
  saStatusChanges: [] as Array<{ agentId: string; preparing: boolean }>,
  failingPorts: new Set<number>(),
  failingStartRoles: new Set<string>(),
  profileAuthStatus: 'authenticated' as 'authenticated' | 'loginRequired' | 'unknown',
  masterActive: true,
  masterAuthenticated: true,
  openedMasterSources: [] as string[],
  closedMasterSources: [] as string[],
  closedChromeProfileCopies: [] as string[],
  chromeProfileCloseError: undefined as string | undefined,
  existingAgents: [] as AgentState[],
  restartResult: undefined as AgentState | undefined,
}

const send = mock(async (command: any) => {
  if (command.name === 'agent:stop') {
    control.stops.push(command.payload.agentId)
    return undefined
  }

  if (command.name === 'agent:restart') {
    if (!control.restartResult) throw new Error('No restart result configured for test')
    return control.restartResult
  }

  if (command.name === 'agent:sa-preparation-status') {
    const { agentId, preparing } = command.payload
    control.saStatusChanges.push({ agentId, preparing })
    const start = control.starts.find(item => item.agentId === agentId) ?? control.restartResult
    if (!start) throw new Error(`Unknown test agent ${agentId}`)
    const index = control.starts.indexOf(start)
    return {
      ...start,
      instanceId: `instance-${index + 1}`,
      saExtensionId: `extension-${index + 1}`,
      status: preparing ? 'sa_preparing' : 'ready',
      debugPort: 9222 + index,
      activeExecutions: 0,
      unknownExecutions: 0,
      createdAt: Date.now(),
    }
  }

  if (command.name !== 'agent:start') throw new Error(`Unexpected command: ${command.name}`)

  const start = command.payload
  control.starts.push(start)
  if (control.failingStartRoles.has(start.role)) {
    throw new Error(`Chrome startup failed for ${start.role}`)
  }
  const debugPort = 9221 + control.starts.length
  return {
    ...start,
    instanceId: `instance-${control.starts.length}`,
    saExtensionId: `extension-${control.starts.length}`,
    status: 'ready',
    debugPort,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  }
})

const query = mock(async (request: any) => {
  if (request.name === 'agent:list') return control.existingAgents
  throw new Error(`Unexpected test query: ${request.name}`)
})

test('launches two selected workers plus one Web coordinator without duplicating the coordinator', async () => {
  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: true,
    count: 3,
    sessionModes: ['clean', 'clean', 'clean'],
  })

  expect(result.success).toBe(true)
  expect(result.readyAgents).toHaveLength(3)
  expect(control.starts.map(start => start.role)).toEqual(['primary', 'worker-1', 'worker-2'])
})

test('refuses to launch another Web coordinator while one is still registered', async () => {
  control.existingAgents.push({
    agentId: 'existing-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'authenticated',
    status: 'ready',
    debugPort: 9400,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  })

  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: true,
    count: 2,
    sessionModes: ['clean', 'clean'],
  })

  expect(result.success).toBe(false)
  expect(result.error).toContain('Ya existe un pool con orquestador Web registrado (existing-primary')
  expect(control.starts).toEqual([])
})

test('closes a Master Session opened only to transfer an authenticated launch session', async () => {
  control.masterActive = false

  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: false,
    count: 1,
    sessionModes: ['authenticated'],
    masterSessionSourceIds: ['test-master'],
  })

  expect(result.success).toBe(true)
  expect(control.openedMasterSources).toEqual(['test-master'])
  expect(control.closedMasterSources).toEqual(['test-master'])
  expect(control.masterActive).toBe(false)
})

test('keeps an unauthenticated Master Session open for sign-in instead of closing it as temporary', async () => {
  control.masterActive = false
  control.masterAuthenticated = false

  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: false,
    count: 1,
    sessionModes: ['authenticated'],
    masterSessionSourceIds: ['test-master'],
  })

  expect(result.success).toBe(false)
  expect(control.openedMasterSources).toEqual(['test-master'])
  expect(control.closedMasterSources).toEqual([])
  expect(control.starts).toEqual([])
})

test('leaves an already active Master Session open after an authenticated launch', async () => {
  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: false,
    count: 1,
    sessionModes: ['authenticated'],
    masterSessionSourceIds: ['test-master'],
  })

  expect(result.success).toBe(true)
  expect(control.openedMasterSources).toEqual([])
  expect(control.closedMasterSources).toEqual([])
  expect(control.masterActive).toBe(true)
})

test('restarts an authenticated Relay by opening its Master, transferring the session, preparing SA, then closing the temporary Master', async () => {
  control.masterActive = false
  control.restartResult = {
    agentId: 'relay-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'authenticated',
    masterSessionSourceId: 'test-master',
    instanceId: 'instance-restarted',
    saExtensionId: 'extension-restarted',
    status: 'ready',
    debugPort: 9230,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  }

  const result = await restartWebRelayAgent(control.restartResult)

  expect(result.status).toBe('ready')
  expect(control.openedMasterSources).toEqual(['test-master'])
  expect(control.closedMasterSources).toEqual(['test-master'])
  expect(control.prepared).toEqual([
    { debugPort: 9230, extensionId: 'extension-restarted', platformId: 'chatgpt' },
  ])
  expect(control.saStatusChanges).toEqual([
    { agentId: 'relay-primary', preparing: true },
    { agentId: 'relay-primary', preparing: false },
  ])
  expect((await workspaceInstanceLaunchHistoryStore.list('relay-primary')).map(event => event.status))
    .toEqual(['ready', 'preparing', 'restarting'])
})

test('coalesces concurrent restart requests for the same Relay', async () => {
  control.restartResult = {
    agentId: 'relay-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'clean',
    instanceId: 'instance-restarted',
    saExtensionId: 'extension-restarted',
    status: 'ready',
    debugPort: 9230,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  }

  const [first, second] = await Promise.all([
    restartWebRelayAgent(control.restartResult),
    restartWebRelayAgent(control.restartResult),
  ])

  expect(first).toEqual(second)
  expect(send).toHaveBeenCalledTimes(3)
  expect((await workspaceInstanceLaunchHistoryStore.list('relay-primary')).map(event => event.status))
    .toEqual(['ready', 'preparing', 'restarting'])
})

test('uses another prepared Web coordinator candidate before launching workers when the first fails SA', async () => {
  control.failingPorts.add(9222)

  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: true,
    coordinatorCount: 2,
    count: 3,
    sessionModes: ['clean', 'clean', 'clean'],
  })

  expect(result.success).toBe(true)
  expect(result.readyAgents.map(agent => agent.role)).toEqual(['orchestrator-2', 'worker-1'])
  expect(control.starts.map(start => start.role)).toEqual([
    'primary',
    'orchestrator-2',
    'worker-1',
  ])
  expect(control.prepared.map(item => item.debugPort)).toEqual([9222, 9223, 9224])
  expect(control.stops).toContain(control.starts[0]?.agentId)
})

test('requires a prepared worker even when multiple Web coordinator candidates pass SA', async () => {
  control.failingPorts.add(9224)

  const result = await launchWebRelayAgents({
    platformId: 'chatgpt',
    purpose: 'agent',
    launchCoordinator: true,
    coordinatorCount: 2,
    count: 3,
    sessionModes: ['clean', 'clean', 'clean'],
  })

  expect(result.success).toBe(false)
  expect(result.readyAgents).toEqual([])
  expect(result.error).toContain('ningún worker pasó la preparación de SuperAssistant')
  expect(control.starts.map(start => start.role)).toEqual([
    'primary',
    'orchestrator-2',
    'worker-1',
  ])
  expect([...new Set(control.stops)].sort()).toEqual(
    control.starts.map(start => start.agentId).sort(),
  )
})

test('keeps an unauthenticated Master Session open for sign-in when authenticated Relay restart is blocked', async () => {
  control.masterActive = false
  control.masterAuthenticated = false
  const agent: AgentState = {
    agentId: 'relay-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'authenticated',
    masterSessionSourceId: 'test-master',
    instanceId: 'instance-existing',
    saExtensionId: 'extension-existing',
    status: 'stopped',
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  }

  await expect(restartWebRelayAgent(agent)).rejects.toThrow('no está autenticada')

  expect(control.openedMasterSources).toEqual(['test-master'])
  expect(control.closedMasterSources).toEqual([])
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'agent:restart' }))
})

test('stops the restarted Relay and closes the temporary Master when SA preparation fails', async () => {
  control.masterActive = false
  control.failingPorts.add(9230)
  control.restartResult = {
    agentId: 'relay-primary',
    platformId: 'chatgpt',
    role: 'primary',
    sessionMode: 'authenticated',
    masterSessionSourceId: 'test-master',
    instanceId: 'instance-restarted',
    saExtensionId: 'extension-restarted',
    status: 'ready',
    debugPort: 9230,
    activeExecutions: 0,
    unknownExecutions: 0,
    createdAt: Date.now(),
  }

  await expect(restartWebRelayAgent(control.restartResult)).rejects.toThrow(
    'SuperAssistant configuration failed on 9230',
  )

  expect(control.stops).toEqual(['relay-primary'])
  expect(control.closedMasterSources).toEqual(['test-master'])
})

const prepareSAAgentForWebRelay = mock(async (
  debugPort: number,
  extensionId?: string,
  platformId?: string,
) => {
  control.prepared.push({ debugPort, extensionId, platformId })
  if (control.failingPorts.has(debugPort)) {
    throw new Error(`SuperAssistant configuration failed on ${debugPort}`)
  }
})

mock.module('../webRelay/orchestration/RelayBus.js', () => ({
  relayBus: { send, query },
}))

const verifyWebRelayStartup = mock(async (agent: AgentState) => {
  control.handshakes.push({
    agentId: agent.agentId, role: agent.role,
    startsAtVerification: control.starts.length,
  })
  if (control.failingHandshakeRoles.has(agent.role ?? '')) {
    throw new Error('Startup acknowledgement rejected for ' + agent.role)
  }
  return {
    agentId: agent.agentId, instanceId: agent.instanceId,
    platformId: agent.platformId, role: agent.role,
    handshakeId: 'test-' + agent.agentId,
    startedAt: 1, completedAt: 2, status: 'instructions-acknowledged',
  }
})

mock.module('../webRelay/WebRelayProvider.js', () => ({
  prepareSAAgentForWebRelay,
  verifyWebRelayStartup,
}))

mock.module('../webRelay/session/ChatGPTAuthVerifier.js', () => ({
  verifyChatGPTAuth: async () => ({
    status: control.profileAuthStatus,
    hasSessionCookie: control.profileAuthStatus === 'authenticated',
    hasLoginElements: control.profileAuthStatus === 'loginRequired',
    hasAccountIndicator: control.profileAuthStatus === 'authenticated',
    hasComposer: true,
    hasPlusBtn: false,
    reason: control.profileAuthStatus === 'authenticated'
      ? 'Account indicator verified'
      : 'No active session token cookie present in relay cookie jar',
  }),
}))

mock.module('../webRelay/session/SessionBroker.js', () => ({
  SessionBroker: {
    getInstance: () => ({
      getMasterStatus: async () => ({
        active: control.masterActive,
        debugPort: 9400,
        hasValidSession: control.masterAuthenticated,
      }),
    }),
  },
  closeMasterSession: async (sourceId: string) => {
    control.closedMasterSources.push(sourceId)
    control.masterActive = false
  },
}))

mock.module('../webRelay/session/MasterSessionController.js', () => ({
  openMasterSessionSource: async (sourceId: string) => {
    control.openedMasterSources.push(sourceId)
    control.masterActive = true
    return {
      sourceId,
      sourceName: 'Test Master',
      debugPort: 9400,
      authenticated: control.masterAuthenticated,
      superAssistantReady: false,
    }
  },
}))

mock.module('../webRelay/session/MasterSessionRegistry.js', () => ({
  getMasterSessionSource: (sourceId: string) => ({
    id: sourceId,
    name: 'Test Master',
    platformId: 'chatgpt',
  }),
}))

mock.module('../webRelay/session/ChromeProfileRegistry.js', () => ({
  closeChromeBeforeProfileCopy: async (profileId: string) => {
    control.closedChromeProfileCopies.push(profileId)
    if (control.chromeProfileCloseError) throw new Error(control.chromeProfileCloseError)
  },
  listChromeProfileSources: () => [{ id: 'Profile 2', name: 'Carlos' }],
}))

import { launchWebRelayAgents, restartWebRelayAgent } from './launchAgents.js'

let historyDirectory = ''

beforeEach(async () => {
  historyDirectory = await mkdtemp(join(tmpdir(), 'web-relay-launch-history-test-'))
  workspaceInstanceLaunchHistoryStore.resetForTests(join(historyDirectory, 'history.jsonl'))
  control.starts.length = 0
  control.stops.length = 0
  control.prepared.length = 0
  control.saStatusChanges.length = 0
  control.handshakes.length = 0
  control.failingHandshakeRoles.clear()
  verifyWebRelayStartup.mockClear()
  control.failingPorts.clear()
  control.failingStartRoles.clear()
  control.masterActive = true
  control.masterAuthenticated = true
  control.openedMasterSources.length = 0
  control.closedMasterSources.length = 0
  control.closedChromeProfileCopies.length = 0
  control.chromeProfileCloseError = undefined
  control.profileAuthStatus = 'authenticated'
  control.existingAgents.length = 0
  control.restartResult = undefined
  send.mockClear()
  query.mockClear()
  prepareSAAgentForWebRelay.mockClear()
})

afterEach(async () => {
  if (historyDirectory) await rm(historyDirectory, { recursive: true, force: true })
})

afterAll(() => {
  mock.restore()
})

describe('Web UI Relay launch SA gates', () => {
  test('requires explicit consent before copying a local Chrome profile', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['chrome-profile'],
      chromeProfileDirectories: ['Profile 2'],
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Confirma la copia aislada')
    expect(control.starts).toHaveLength(0)
  })

  test('passes a consented local Chrome profile to the Relay startup', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['chrome-profile'],
      chromeProfileDirectories: ['Profile 2'],
      allowChromeProfileCopy: true,
    })

    expect(result.success).toBe(true)
    expect(control.starts).toHaveLength(1)
    expect(control.starts[0]?.sessionMode).toBe('chrome-profile')
    expect(control.starts[0]?.chromeProfileDirectory).toBe('Profile 2')
    expect(control.closedChromeProfileCopies).toEqual(['Profile 2'])
  })

  test('does not launch when Chrome remains open after the graceful close request', async () => {
    control.chromeProfileCloseError = 'Chrome sigue activo; no se copió el perfil.'

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['chrome-profile'],
      chromeProfileDirectories: ['Profile 2'],
      allowChromeProfileCopy: true,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Chrome sigue activo')
    expect(control.closedChromeProfileCopies).toEqual(['Profile 2'])
    expect(control.starts).toHaveLength(0)
  })

  test('keeps an unauthenticated manual profile open and directs sign-in before ChatGPT use', async () => {
    control.profileAuthStatus = 'loginRequired'

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['chrome-profile'],
      chromeProfileDirectories: ['Profile 2'],
      allowChromeProfileCopy: true,
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(1)
    expect(result.failures.join('\n')).toContain('requiere inicio de sesión')
    expect(result.failures.join('\n')).toContain('Inicia sesión en esa ventana Relay antes de usar ChatGPT')
    expect(result.failures.join('\n')).not.toContain('antes de enviar tareas')
    expect(result.failures.join('\n')).toContain('no se comparten con esta copia aislada')
    expect(control.stops).toHaveLength(0)
  })

  test('Agent mode prepares every Relay before reporting success', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      count: 2,
      sessionModes: ['clean', 'authenticated'],
      masterSessionSourceIds: [undefined, 'test-master'],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(2)
    expect(control.starts.map(start => start.role)).toEqual(['primary', 'worker-1'])
    expect(control.starts[1]).toMatchObject({
      sessionMode: 'authenticated',
      masterSessionSourceId: 'test-master',
    })
    expect(control.prepared).toEqual([
      { debugPort: 9222, extensionId: 'extension-1', platformId: 'chatgpt' },
      { debugPort: 9223, extensionId: 'extension-2', platformId: 'chatgpt' },
    ])
    expect(control.saStatusChanges).toEqual([
      { agentId: control.starts[0]!.agentId, preparing: true },
      { agentId: control.starts[0]!.agentId, preparing: false },
      { agentId: control.starts[1]!.agentId, preparing: true },
      { agentId: control.starts[1]!.agentId, preparing: false },
    ])
  })

  test('adds one Web coordinator to three selected workers and preserves their session profiles', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: true,
      count: 4,
      sessionModes: ['authenticated', 'clean', 'authenticated', 'clean'],
      masterSessionSourceIds: ['test-master', undefined, 'test-master', undefined],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(4)
    expect(control.starts.map(start => start.role)).toEqual([
      'primary',
      'worker-1',
      'worker-2',
      'worker-3',
    ])
    expect(control.starts.map(start => start.sessionMode)).toEqual([
      'authenticated',
      'clean',
      'authenticated',
      'clean',
    ])
    expect(control.starts[0]).toMatchObject({
      masterSessionSourceId: 'test-master',
      role: 'primary',
    })
    expect(control.starts[2]).toMatchObject({
      masterSessionSourceId: 'test-master',
      role: 'worker-2',
    })
    expect(control.prepared).toHaveLength(4)
  })

  test('launches multiple Web coordinator candidates separately from workers', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: true,
      coordinatorCount: 2,
      count: 4,
      sessionModes: ['clean', 'clean', 'authenticated', 'clean'],
      masterSessionSourceIds: [undefined, undefined, 'test-master', undefined],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents.map(agent => agent.role)).toEqual([
      'primary',
      'orchestrator-2',
      'worker-1',
      'worker-2',
    ])
    expect(control.starts.map(start => start.role)).toEqual([
      'primary',
      'orchestrator-2',
      'worker-1',
      'worker-2',
    ])
  })

  test('API-brain Agent mode launches workers without assigning a Relay coordinator role', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: false,
      count: 1,
      sessionModes: ['clean'],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(1)
    expect(control.starts.map(start => start.role)).toEqual(['worker-1'])
    expect(control.prepared).toEqual([
      { debugPort: 9222, extensionId: 'extension-1', platformId: 'chatgpt' },
    ])
  })

  test('does not enable a Web coordinator pool when its primary Relay fails SA preparation', async () => {
    control.failingPorts.add(9222)
    const activityCursor = sharedActivityJournal.latestSequence

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: true,
      count: 3,
      sessionModes: ['clean', 'clean', 'clean'],
    })

    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(result.error).toContain('coordinador Web no pasó la preparación de SuperAssistant')
    expect(result.error).toContain(`orquestador Web (${control.starts[0]?.agentId}, puerto 9222)`)
    expect(result.error).toContain('SuperAssistant configuration failed on 9222')
    expect(control.starts.map(start => start.role)).toEqual(['primary'])
    expect(new Set(control.stops)).toEqual(new Set(control.starts.map(start => start.agentId)))

    const launchEvents = sharedActivityJournal.read({
      afterSequence: activityCursor,
      sources: ['orchestration'],
      limit: 20,
    }).events
    expect(launchEvents).toContainEqual(expect.objectContaining({
      event: 'relay:launch-warning',
      details: expect.objectContaining({ platformId: 'chatgpt', purpose: 'agent', status: 'failed' }),
    }))
    expect(launchEvents).toContainEqual(expect.objectContaining({
      event: 'relay:launch-instance-failure',
      details: expect.objectContaining({ failure: expect.stringContaining('SuperAssistant configuration failed on 9222') }),
    }))
  })

  test('records partial launch warnings for local Workspace agents', async () => {
    control.failingPorts.add(9224)
    const activityCursor = sharedActivityJournal.latestSequence

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: true,
      count: 3,
      sessionModes: ['clean', 'clean', 'clean'],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(2)
    const launchEvents = sharedActivityJournal.read({
      afterSequence: activityCursor,
      sources: ['orchestration'],
      limit: 20,
    }).events
    expect(launchEvents).toContainEqual(expect.objectContaining({
      event: 'relay:launch-warning',
      details: expect.objectContaining({ platformId: 'chatgpt', purpose: 'agent', status: 'partial', failureCount: 1 }),
    }))
    expect(launchEvents).toContainEqual(expect.objectContaining({
      event: 'relay:launch-instance-failure',
      details: expect.objectContaining({ failure: expect.stringContaining('SuperAssistant configuration failed on 9224') }),
    }))
  })

  test('reports and cleans up when the Web coordinator Relay fails to start', async () => {
    control.failingStartRoles.add('primary')

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      launchCoordinator: true,
      count: 2,
      sessionModes: ['clean', 'clean'],
    })

    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(result.error).toContain('orquestador Web primary (')
    expect(result.error).toContain('Chrome startup failed for primary')
    expect(control.starts.map(start => start.role)).toEqual(['primary'])
    expect(new Set(control.stops)).toEqual(new Set(control.starts.map(start => start.agentId)))
  })

  test('User mode also prepares its manual Relay before reporting success', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['clean'],
    })

    expect(result.success).toBe(true)
    expect(result.readyAgents).toHaveLength(1)
    expect(result.readyAgents[0]?.role).toBe('manual-user-1')
    expect(control.prepared).toEqual([
      { debugPort: 9222, extensionId: 'extension-1', platformId: 'chatgpt' },
    ])
    expect(control.saStatusChanges).toEqual([
      { agentId: control.starts[0]!.agentId, preparing: true },
      { agentId: control.starts[0]!.agentId, preparing: false },
    ])
  })

  test('does not report User mode success when SA preparation fails', async () => {
    control.failingPorts.add(9222)

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'user',
      count: 1,
      sessionModes: ['clean'],
    })

    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(result.failures[0]).toContain('manual-user-1 (')
    expect(result.failures[0]).toContain('puerto 9222')
    expect(result.failures[0]).toContain('SuperAssistant configuration failed on 9222')
    expect(control.stops).toContain(control.starts[0]?.agentId)
    expect(control.saStatusChanges).toEqual([
      { agentId: control.starts[0]!.agentId, preparing: true },
    ])
  })

  test('does not report Agent mode success when a Relay fails SA preparation', async () => {
    control.failingPorts.add(9223)

    const result = await launchWebRelayAgents({
      platformId: 'chatgpt',
      purpose: 'agent',
      count: 2,
      sessionModes: ['clean', 'clean'],
    })

    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(control.prepared).toHaveLength(2)
    expect(control.stops).toContain(control.starts[0]?.agentId)
    expect(control.stops).toContain(control.starts[1]?.agentId)
  })
})


describe('startup acknowledgement launch gates', () => {
  test('verifies the coordinator before starting workers and verifies every worker', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 3,
      launchCoordinator: true, sessionModes: ['clean', 'clean', 'clean'],
    })
    expect(result.success).toBe(true)
    expect(control.handshakes.map(item => item.role)).toEqual(['primary', 'worker-1', 'worker-2'])
    expect(control.handshakes[0]?.startsAtVerification).toBe(1)
    expect(result.readyAgents).toHaveLength(3)
  })

  test('does not start workers when the coordinator acknowledgement fails', async () => {
    control.failingHandshakeRoles.add('primary')
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 2,
      launchCoordinator: true, sessionModes: ['clean', 'clean'],
    })
    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(control.starts.map(item => item.role)).toEqual(['primary'])
    expect(control.saStatusChanges.filter(item => !item.preparing)).toEqual([])
    expect(result.failures.some(item => item.includes('Startup acknowledgement rejected'))).toBe(true)
  })

  test('does not mark a worker ready when its acknowledgement fails', async () => {
    control.failingHandshakeRoles.add('worker-1')
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 2,
      launchCoordinator: true, sessionModes: ['clean', 'clean'],
    })
    const worker = control.starts.find(item => item.role === 'worker-1')!
    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(control.saStatusChanges.some(item => item.agentId === worker.agentId && !item.preparing)).toBe(false)
    expect(control.stops).toContain(worker.agentId)
  })

  test('does not send an automatic startup prompt to manual conversations', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'user', count: 1,
      sessionModes: ['clean'],
    })
    expect(result.success).toBe(true)
    expect(control.handshakes).toEqual([])
  })
})
