import { describe, expect, it } from 'bun:test'
import { getSentinelMCPTools } from './SentinelMCPTools.js'
import { collaborationStore } from '../collaboration/CollaborationStore.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'
import { initializeSharedActivitySources } from '../observability/SharedActivitySources.js'

function tool(name: string) {
  const found = getSentinelMCPTools().find(candidate => candidate.name === name)
  if (!found) throw new Error(`Expected Sentinel MCP tool ${name} to be registered.`)
  return found
}

describe('Sentinel MCP tools', () => {
  it('exposes instance discovery and inspection to connected MCP clients', () => {
    const tools = getSentinelMCPTools()
    expect(tools.map(tool => tool.name)).toEqual([
      'openmcp_read_activity',
      'openmcp_watch_activity',
      'sentinel_watch_interactions',
      'sentinel_get_orchestration_state',
      'sentinel_list_instances',
      'sentinel_inspect_instance',
      'sentinel_capture_instance_view',
    ])
    expect(tool('sentinel_inspect_instance').inputSchema).toMatchObject({
      properties: {
        sourceId: { type: 'string' },
        includeConversation: { type: 'boolean' },
      },
      oneOf: [
        { required: ['agentId'], not: { required: ['sourceId'] } },
        { required: ['sourceId'], not: { required: ['agentId'] } },
      ],
    })
    expect(tool('sentinel_inspect_instance').description).toContain(
      'whether Chrome rewrote the copied cookie database after launch',
    )
    expect(tool('sentinel_inspect_instance').description).toContain('No cookie values are read or returned')
  })

  it('requires explicit approval and a registered agent for visual capture', async () => {
    const capture = tool('sentinel_capture_instance_view')
    expect(capture.inputSchema).toMatchObject({
      required: ['agentId', 'userApproved'],
      properties: {
        userApproved: { type: 'boolean' },
      },
    })
    await expect(capture.execute({
      agentId: 'nonexistent-agent-for-test',
      userApproved: false,
    })).rejects.toThrow(/requires explicit user approval/i)
    await expect(capture.execute({
      agentId: 'nonexistent-agent-for-test',
      userApproved: true,
    })).rejects.toThrow(/unregistered agent/i)
  })

  it('excludes conversation content unless the caller explicitly opts in', async () => {
    const inspect = tool('sentinel_inspect_instance')
    await expect(inspect.execute({ agentId: 'nonexistent-agent-for-test' }))
      .rejects.toThrow(/unregistered agent/i)
    await expect(inspect.execute({
      agentId: 'nonexistent-agent-for-test',
      includeConversation: 'yes',
    })).rejects.toThrow(/includeConversation must be a boolean/i)
  })

  it('requires an exact, non-empty agent ID', async () => {
    const inspect = tool('sentinel_inspect_instance')
    await expect(inspect.execute({ agentId: '  ' }))
      .rejects.toThrow(/exactly one non-empty agentId or sourceId/i)
    await expect(inspect.execute({}))
      .rejects.toThrow(/exactly one non-empty agentId or sourceId/i)
    await expect(inspect.execute({ agentId: 'agent-1', sourceId: 'master-1' }))
      .rejects.toThrow(/exactly one non-empty agentId or sourceId/i)
  })

  it('returns a bounded shared orchestration snapshot', async () => {
    const overview = tool('sentinel_get_orchestration_state')
    const result = JSON.parse(await overview.execute({ entryLimit: 5 })) as {
      agents: unknown[]
      collaboration: { recentEntries: unknown[] }
      sentinel: unknown
    }
    expect(Array.isArray(result.agents)).toBe(true)
    expect(result.collaboration.recentEntries.length).toBeLessThanOrEqual(5)
    expect(result).toHaveProperty('sentinel')
    await expect(overview.execute({ entryLimit: 51 }))
      .rejects.toThrow(/entryLimit must be an integer/i)
  })

  it('watches live collaboration events for a bounded interval', async () => {
    const watch = tool('sentinel_watch_interactions')
    const pending = watch.execute({ waitSeconds: 1 })
    setTimeout(() => {
      collaborationStore.addSentinelObservation({
        observation: `watch test ${Date.now()}`,
      })
    }, 25)
    const result = JSON.parse(await pending) as {
      events: Array<{ source: string; data: { entry?: { observation?: string } } }>
      durationMs: number
    }
    expect(result.events.some(event =>
      event.source === 'collaboration' && event.data.entry?.observation?.startsWith('watch test '),
    )).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(900)
    expect(result.durationMs).toBeLessThan(3000)
  })

  it('reports collaboration entry updates such as fulfilled worker requests', async () => {
    const request = collaborationStore.addRequest({
      workerId: `watch-worker-${Date.now()}`,
      workerPlatform: 'chatgpt',
      need: 'integration test update',
      reason: 'verify watcher sees status mutation',
      callId: `watch-call-${Date.now()}`,
    })
    const watch = tool('sentinel_watch_interactions')
    const pending = watch.execute({ waitSeconds: 1 })
    setTimeout(() => {
      collaborationStore.fulfillRequest(request.id, 'watch-coordinator', 'fulfilled test payload')
    }, 25)
    const result = JSON.parse(await pending) as {
      events: Array<{ source: string; data: { entry?: { id?: string; status?: string } } }>
    }
    expect(result.events.some(event =>
      event.source === 'collaboration' &&
      event.data.entry?.id === request.id &&
      event.data.entry.status === 'fulfilled',
    )).toBe(true)
  })

  it('rejects unbounded or malformed watch requests', async () => {
    const watch = tool('sentinel_watch_interactions')
    await expect(watch.execute({ waitSeconds: 21 }))
      .rejects.toThrow(/waitSeconds must be an integer/i)
    await expect(watch.execute({ agentIds: ['agent-1', ''] }))
      .rejects.toThrow(/agentIds must contain/i)
    await expect(watch.execute({ includeConversation: true }))
      .rejects.toThrow(/requires exactly one selected agentId/i)
  })

  it('exposes a shared activity cursor to every connected MCP role', async () => {
    const read = tool('openmcp_read_activity')
    const result = JSON.parse(await read.execute({ limit: 20 })) as {
      events: Array<{ source: string; event: string }>
      nextSequence: number
      truncated: boolean
    }
    expect(result.nextSequence).toBeGreaterThanOrEqual(0)
    expect(result.truncated).toBe(false)
    expect(Array.isArray(result.events)).toBe(true)
  })

  it('watches shared structured events and advances the cursor', async () => {
    const watch = tool('openmcp_watch_activity')
    const afterSequence = sharedActivityJournal.latestSequence
    const pending = watch.execute({
      afterSequence,
      waitSeconds: 1,
      sources: ['coordinator'],
    })
    setTimeout(() => {
      sharedActivityJournal.append({
        source: 'coordinator',
        event: 'coordinator:test-phase',
        agentId: 'test-coordinator',
        details: { phase: 'review-started' },
      })
    }, 25)
    const result = JSON.parse(await pending) as {
      events: Array<{ sequence: number; source: string; event: string; details?: Record<string, unknown> }>
      nextSequence: number
    }
    expect(result.events.some(event =>
      event.source === 'coordinator' &&
      event.event === 'coordinator:test-phase' &&
      event.details?.phase === 'review-started',
    )).toBe(true)
    expect(result.nextSequence).toBeGreaterThan(afterSequence)
  })

  it('rejects invalid activity source and cursor filters', async () => {
    const read = tool('openmcp_read_activity')
    await expect(read.execute({ afterSequence: -1 }))
      .rejects.toThrow(/afterSequence must be/i)
    await expect(read.execute({ sources: ['conversation'] }))
      .rejects.toThrow(/sources must be/i)
  })

  it('records shared collaboration state changes without copying their text payload', async () => {
    await initializeSharedActivitySources()
    const beforeSequence = sharedActivityJournal.latestSequence
    const marker = `private-collaboration-text-${Date.now()}`
    collaborationStore.addSentinelObservation({ observation: marker })
    const events = sharedActivityJournal.read({ afterSequence: beforeSequence }).events
    expect(events.some(event =>
      event.source === 'collaboration' && event.event === 'collaboration:sentinel_observation',
    )).toBe(true)
    expect(JSON.stringify(events)).not.toContain(marker)
  })
})
