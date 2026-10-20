import { describe, expect, test } from 'bun:test'
import { SharedActivityJournal } from './SharedActivityJournal.js'

describe('SharedActivityJournal', () => {
  test('retains bounded, ordered events and reports cursor gaps', () => {
    const journal = new SharedActivityJournal(2)
    journal.append({ source: 'mcp', event: 'first' })
    journal.append({ source: 'execution', event: 'second', agentId: 'relay-a' })
    journal.append({ source: 'sentinel', event: 'third' })

    expect(journal.read({ afterSequence: 1 })).toMatchObject({
      events: [{ sequence: 2, event: 'second' }, { sequence: 3, event: 'third' }],
      nextSequence: 3,
      oldestSequence: 2,
      truncated: false,
    })
    expect(journal.read({ afterSequence: 0 })).toMatchObject({
      truncated: true,
      oldestSequence: 2,
    })
  })

  test('filters without returning prompt or response fields and deduplicates Relay events', () => {
    const journal = new SharedActivityJournal()
    let observed = 0
    journal.subscribe(() => { observed += 1 })
    const event = {
      source: 'execution' as const,
      event: 'relay:tool-complete',
      agentId: 'relay-a',
      details: {
        callId: 'call-1',
        toolName: 'Read',
        success: true,
      },
    }
    expect(journal.appendOnce('relay-event-1', event)?.sequence).toBe(1)
    expect(journal.appendOnce('relay-event-1', event)).toBeNull()
    expect(observed).toBe(1)
    expect(journal.read({
      agentIds: ['relay-a'],
      sources: ['execution'],
    }).events[0]).toMatchObject({
      sequence: 1,
      details: { callId: 'call-1', toolName: 'Read', success: true },
    })
    expect(JSON.stringify(journal.read())).not.toContain('prompt')
    expect(JSON.stringify(journal.read())).not.toContain('response')
  })

  test('bounds and sanitizes event detail fields', () => {
    const journal = new SharedActivityJournal()
    const event = journal.append({
      source: 'mcp',
      event: 'x'.repeat(400),
      details: {
        safe: 'x'.repeat(400),
      },
    })
    expect(event.event).toHaveLength(256)
    expect(event.details?.safe).toHaveLength(256)
  })
})
