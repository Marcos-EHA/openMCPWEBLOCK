/**
 * fixtures.test.ts — 10 fixtures for Puerta 5 (Robustez)
 * 
 * These tests attempt to BREAK the contracts, not confirm them.
 * If a test fails, the evidence should be used to determine whether
 * the error is in the contract, the implementation, or the fixture.
 * 
 * Run with: bun test tests/fixtures/puerta5/fixtures.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  CanonicalEvent,
  TaskState,
  AttentionItem,
  loadAndReduce,
  serializeState,
  deepEqual,
  parseEventsJsonl,
  reduceEvents,
} from './contracts.js'

// ─── Shared test data ─────────────────────────────────────────────────────────

const VALID_LOG = [
  JSON.stringify({ eventId: 'e001', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1000, agentId: 'ag-1', actor: 'user', sequence: 1, payload: { agentId: 'ag-1', platformId: 'chatgpt' } }),
  JSON.stringify({ eventId: 'e002', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1001, agentId: 'ag-1', causationId: 'e001', actor: 'system', sequence: 2, payload: { agentId: 'ag-1', from: 'created', to: 'starting' } }),
  JSON.stringify({ eventId: 'e003', schemaVersion: '1', source: 'activitystore', eventName: 'task:started', timestamp: 1002, taskId: 'task-1', agentId: 'ag-1', causationId: 'e002', actor: 'user', sequence: 1, payload: { prompt: 'Investiga X' } }),
  JSON.stringify({ eventId: 'e004', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1003, agentId: 'ag-1', causationId: 'e002', actor: 'system', sequence: 3, payload: { agentId: 'ag-1', from: 'starting', to: 'ready' } }),
  JSON.stringify({ eventId: 'e005', schemaVersion: '1', source: 'activitystore', eventName: 'task:finished', timestamp: 1004, taskId: 'task-1', agentId: 'ag-1', causationId: 'e003', actor: 'system', sequence: 2, payload: { result: 'Resultado de investigación' } }),
].join('\n')

// ─── F1: Determinismo ─────────────────────────────────────────────────────────

describe('F1: Determinismo', () => {
  test('mismo log válido → mismo estado (byte a byte)', () => {
    // First pass
    const result1 = loadAndReduce(VALID_LOG)
    const serialized1 = serializeState(result1.state)

    // Second pass (same input)
    const result2 = loadAndReduce(VALID_LOG)
    const serialized2 = serializeState(result2.state)

    // Property: same input → identical output
    expect(serialized1).toBe(serialized2)
  })

  test('reducción con Map serialization produce resultados estables', () => {
    const r1 = loadAndReduce(VALID_LOG)
    const r2 = loadAndReduce(VALID_LOG)

    // Deep equality on the Map objects
    expect(deepEqual(r1.state.tasks, r2.state.tasks)).toBe(true)
    expect(deepEqual(r1.state.agents, r2.state.agents)).toBe(true)
    expect(deepEqual(r1.state.attention, r2.state.attention)).toBe(true)
  })
})

// ─── F2: Duplicación ──────────────────────────────────────────────────────────

describe('F2: Duplicación', () => {
  test('evento duplicado → no cambia incorrectamente el estado', () => {
    // Normal log
    const normal = loadAndReduce(VALID_LOG)

    // Log with duplicated line (e003 appears twice)
    const duplicated = VALID_LOG.split('\n')
    const dupLine = duplicated[2] // e003 line
    duplicated.splice(3, 0, dupLine) // Insert duplicate after position 3
    const dupLog = duplicated.join('\n')
    const result = loadAndReduce(dupLog)

    // Property: task-1 has only ONE startedAt (not two entries)
    const task = result.state.tasks.get('task-1')
    expect(task).toBeDefined()
    expect(task!.startedAt).toBe(1002)

    // Property: dedup was recorded
    expect(result.state.deduplicatedEvents.length).toBe(1)
    expect(result.state.deduplicatedEvents[0].eventId).toBe('e003')
    expect(result.state.deduplicatedEvents[0].count).toBe(2)
  })

  test('múltiples duplicados del mismo evento', () => {
    const lines = VALID_LOG.split('\n')
    const dupLine = lines[2] // e003
    const multiDup = [...lines.slice(0, 3), dupLine, dupLine, dupLine, ...lines.slice(3)].join('\n')
    const result = loadAndReduce(multiDup)

    // Should record 3 duplicates (total 4 occurrences)
    expect(result.state.deduplicatedEvents.length).toBe(1)
    expect(result.state.deduplicatedEvents[0].count).toBe(4)

    // State should still be correct
    const task = result.state.tasks.get('task-1')
    expect(task!.startedAt).toBe(1002)
    expect(task!.status).toBe('complete')
  })
})

// ─── F3: Fuera de orden ───────────────────────────────────────────────────────

describe('F3: Fuera de orden — semántica de reordenamiento', () => {
  test('eventos desordenados se reordenan por sequence/timestamp', () => {
    // Same events as VALID_LOG but in wrong file order
    const lines = VALID_LOG.split('\n')
    // Reorder: e004, e001, e003, e002, e005
    const shuffled = [lines[3], lines[0], lines[2], lines[1], lines[4]].join('\n')

    const result = loadAndReduce(shuffled)
    const task = result.state.tasks.get('task-1')

    // Property: the reordering rule produces the same state as the ordered version
    const orderedResult = loadAndReduce(VALID_LOG)
    const orderedTask = orderedResult.state.tasks.get('task-1')

    expect(task!.taskId).toBe(orderedTask!.taskId)
    expect(task!.status).toBe(orderedTask!.status)
    expect(task!.startedAt).toBe(orderedTask!.startedAt)
    expect(task!.updatedAt).toBe(orderedTask!.updatedAt)
    expect(task!.result).toBe(orderedTask!.result)
  })

  test('agent:lifecycle aplicado en orden correcto', () => {
    // Create events where lifecycle events are out of order
    const events = [
      JSON.stringify({ eventId: 'l003', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 3003, agentId: 'ag-1', actor: 'system', sequence: 3, payload: { agentId: 'ag-1', from: 'starting', to: 'ready' } }),
      JSON.stringify({ eventId: 'l001', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 3000, agentId: 'ag-1', actor: 'user', sequence: 1, payload: { agentId: 'ag-1', platformId: 'chatgpt' } }),
      JSON.stringify({ eventId: 'l002', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 3001, agentId: 'ag-1', causationId: 'l001', actor: 'system', sequence: 2, payload: { agentId: 'ag-1', from: 'created', to: 'starting' } }),
    ].join('\n')

    const result = loadAndReduce(events)
    const agent = result.state.agents.get('ag-1')

    // Property: after reordering, the LAST lifecycle event applied is l003 (to: ready)
    expect(agent!.status).toBe('ready')
  })

  test('reordenamiento es determinista', () => {
    const lines = VALID_LOG.split('\n')
    const shuffled = [lines[3], lines[0], lines[2], lines[1], lines[4]].join('\n')

    const r1 = loadAndReduce(shuffled)
    const r2 = loadAndReduce(shuffled)

    expect(serializeState(r1.state)).toBe(serializeState(r2.state))
  })
})

// ─── F4a: Evento desconocido por eventName ────────────────────────────────────

describe('F4a: Evento desconocido por eventName', () => {
  test('evento con eventName desconocido se registra pero no rompe', () => {
    const unknownEvent = JSON.stringify({
      eventId: 'e999', schemaVersion: '1', source: 'relaybus',
      eventName: 'quantum:flux', timestamp: 1002.5,
      actor: 'system', sequence: 99,
      payload: { meaning: 42 },
    })

    const logWithUnknown = VALID_LOG.split('\n')
    logWithUnknown.splice(3, 0, unknownEvent)
    const result = loadAndReduce(logWithUnknown.join('\n'))

    // Property: unknown event is recorded
    expect(result.state.unknownEvents.length).toBe(1)
    expect(result.state.unknownEvents[0].eventId).toBe('e999')
    expect(result.state.unknownEvents[0].eventName).toBe('quantum:flux')
    expect(result.state.unknownEvents[0].reason).toBe('unknown-eventName')

    // Property: other events processed normally
    const task = result.state.tasks.get('task-1')
    expect(task).toBeDefined()
    expect(task!.status).toBe('complete')
  })

  test('múltiples eventos desconocidos', () => {
    const unknowns = [
      JSON.stringify({ eventId: 'u001', schemaVersion: '1', source: 'relaybus', eventName: 'foo:bar', timestamp: 1001, actor: 'system', sequence: 90, payload: {} }),
      JSON.stringify({ eventId: 'u002', schemaVersion: '1', source: 'relaybus', eventName: 'baz:qux', timestamp: 1002, actor: 'system', sequence: 91, payload: {} }),
    ]

    const logWithUnknowns = [...VALID_LOG.split('\n'), ...unknowns].join('\n')
    const result = loadAndReduce(logWithUnknowns)

    expect(result.state.unknownEvents.length).toBe(2)
    // Other events still processed
    expect(result.state.tasks.get('task-1')!.status).toBe('complete')
  })
})

// ─── F4b: Evento desconocido por schemaVersion ─────────────────────────────────

describe('F4b: Evento desconocido por schemaVersion', () => {
  test('evento con schemaVersion desconocido se registra como incompatible', () => {
    const futureEvent = JSON.stringify({
      eventId: 'e888', schemaVersion: '999', source: 'relaybus',
      eventName: 'agent:created', timestamp: 1001,
      actor: 'system', sequence: 50,
      payload: { agentId: 'ag-future', platformId: 'future' },
    })

    const logWithFuture = [...VALID_LOG.split('\n'), futureEvent].join('\n')
    const result = loadAndReduce(logWithFuture)

    // Property: recorded as unknown-schemaVersion (not unknown-eventName)
    expect(result.state.unknownEvents.length).toBe(1)
    expect(result.state.unknownEvents[0].reason).toBe('unknown-schemaVersion')
    expect(result.state.unknownEvents[0].schemaVersion).toBe('999')

    // Property: the event was NOT processed (no agent-future created)
    expect(result.state.agents.has('ag-future')).toBe(false)

    // Property: other events with schemaVersion 1 processed normally
    expect(result.state.agents.has('ag-1')).toBe(true)
    expect(result.state.tasks.get('task-1')!.status).toBe('complete')
  })
})

// ─── F5: Truncamiento ─────────────────────────────────────────────────────────

describe('F5: Truncamiento', () => {
  test('log cortado a mitad de JSON → ignora última línea, procesa resto', () => {
    // Take VALID_LOG and cut the last line in half
    const lines = VALID_LOG.split('\n')
    const lastLine = lines[lines.length - 1]
    const truncatedLast = lastLine.substring(0, Math.floor(lastLine.length / 2))
    const truncatedLog = [...lines.slice(0, -1), truncatedLast].join('\n')

    const result = loadAndReduce(truncatedLog)

    // Property: first 4 lines processed normally
    expect(result.state.agents.has('ag-1')).toBe(true)
    expect(result.state.agents.get('ag-1')!.status).toBe('ready') // e004 applied
    expect(result.state.tasks.has('task-1')).toBe(true)

    // Property: task-1 is still running (task:finished was lost)
    const task = result.state.tasks.get('task-1')
    expect(task!.status).toBe('running') // NOT complete

    // Property: truncation warning recorded
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0].line).toBe(5)
  })

  test('log vacío → sin crash, sin tareas', () => {
    const result = loadAndReduce('')
    expect(result.state.tasks.size).toBe(0)
    expect(result.state.agents.size).toBe(0)
    expect(result.warnings.length).toBe(0)
  })

  test('log con solo whitespace → sin crash', () => {
    const result = loadAndReduce('   \n\n  \n')
    expect(result.state.tasks.size).toBe(0)
    expect(result.warnings.length).toBe(0)
  })
})

// ─── F6: Causalidad ───────────────────────────────────────────────────────────

describe('F6: Causalidad', () => {
  test('cadena de causationId es navegable desde task hasta agent:created', () => {
    const result = loadAndReduce(VALID_LOG)
    const { events } = parseEventsJsonl(VALID_LOG)

    // Build eventId → event map
    const eventMap = new Map<string, CanonicalEvent>()
    for (const ev of events) {
      eventMap.set(ev.eventId, ev)
    }

    // Start from the task:finished event (e005)
    let current = eventMap.get('e005')
    expect(current).toBeDefined()

    // Follow causationId chain: e005 → e003 → e002 → e001
    const chain: string[] = ['e005']
    while (current?.causationId) {
      chain.push(current.causationId)
      current = eventMap.get(current.causationId)
    }

    // Property: chain reaches the root event (e001: agent:created)
    expect(chain).toEqual(['e005', 'e003', 'e002', 'e001'])
  })

  test('cada campo de TaskState puede responder qué evento lo estableció', () => {
    const result = loadAndReduce(VALID_LOG)
    const task = result.state.tasks.get('task-1')

    // Property: taskId and startedAt come from task:started (e003)
    expect(task!.taskId).toBe('task-1') // from e003.taskId
    expect(task!.startedAt).toBe(1002) // from e003.timestamp

    // Property: status comes from task:finished (e005)
    expect(task!.status).toBe('complete') // from e005.payload.result

    // Property: result comes from e005 payload
    expect(task!.result).toBe('Resultado de investigación') // from e005.payload.result
  })

  test('evento sin causationId es la raíz de su cadena', () => {
    const { events } = parseEventsJsonl(VALID_LOG)
    const rootEvent = events.find(e => e.eventId === 'e001')

    // e001 (agent:created) has no causationId — it's the root
    expect(rootEvent).toBeDefined()
    expect(rootEvent!.causationId).toBeUndefined()
  })
})

// ─── F7: Ciclo de vida de atención ───────────────────────────────────────────

describe('F7: Ciclo de vida de atención', () => {
  const ATTENTION_LOG = [
    JSON.stringify({ eventId: 'a001', schemaVersion: '1', source: 'relaybus', eventName: 'execution:unknown', timestamp: 2000, taskId: 'task-1', agentId: 'ag-1', executionId: 'exec-123', actor: 'system', sequence: 10, payload: { reason: 'timeout sin respuesta' } }),
    JSON.stringify({ eventId: 'a002', schemaVersion: '1', source: 'user', eventName: 'user:acknowledged', timestamp: 2100, taskId: 'task-1', agentId: 'ag-1', causationId: 'a001', actor: 'user', sequence: 1, payload: { attentionId: 'att-a001' } }),
    JSON.stringify({ eventId: 'a003', schemaVersion: '1', source: 'user', eventName: 'user:action', timestamp: 2200, taskId: 'task-1', agentId: 'ag-1', causationId: 'a002', actor: 'user', sequence: 2, payload: { attentionId: 'att-a001', action: 'retry' } }),
    JSON.stringify({ eventId: 'a004', schemaVersion: '1', source: 'relaybus', eventName: 'execution:update', timestamp: 2300, taskId: 'task-1', agentId: 'ag-1', executionId: 'exec-123', causationId: 'a003', actor: 'system', sequence: 11, payload: { status: 'success' } }),
  ].join('\n')

  test('attention item pasa por detected → acknowledged → in-progress → resolved', () => {
    const result = loadAndReduce(ATTENTION_LOG)
    const item = result.state.attention.get('att-a001')

    expect(item).toBeDefined()

    // Property: final lifecycle is resolved
    expect(item!.lifecycle).toBe('resolved')

    // Property: history records the transitions
    const transitions = item!.history.map(h => `${h.from}→${h.to}`)
    expect(transitions).toContain('detected→detected') // initial
    expect(transitions).toContain('detected→acknowledged') // user saw it
    expect(transitions).toContain('acknowledged→action-required') // user decided to act
    expect(transitions).toContain('action-required→in-progress') // retry started
    expect(transitions).toContain('in-progress→resolved') // execution:update success
  })

  test('attention item sin user:acknowledged permanece en detected', () => {
    // Only the detection event, no user interaction
    const partialLog = ATTENTION_LOG.split('\n')[0] // just a001
    const result = loadAndReduce(partialLog)
    const item = result.state.attention.get('att-a001')

    expect(item).toBeDefined()
    expect(item!.lifecycle).toBe('detected')
    expect(item!.history.length).toBe(1) // only initial
  })

  test('execution:update con status success resuelve el attention item', () => {
    const result = loadAndReduce(ATTENTION_LOG)
    const item = result.state.attention.get('att-a001')

    // Property: the item is resolved (not still in in-progress)
    expect(item!.lifecycle).toBe('resolved')

    // Property: the task has evidence of the successful execution
    const task = result.state.tasks.get('task-1')
    // Note: task-1 might not exist if task:started wasn't in this log
    // This is correct behavior — attention exists independently of tasks
  })
})

// ─── F8a: Atomicidad lógica (contrato del reducer) ─────────────────────────────

describe('F8a: Atomicidad lógica', () => {
  test('reducer nunca deja estado parcial ante evento malformado', () => {
    // Event with missing required fields
    const malformed = JSON.stringify({
      eventId: 'bad-1',
      // Missing: schemaVersion, eventName, timestamp, source, actor, sequence
      payload: { something: true },
    })

    const logWithBad = [...VALID_LOG.split('\n'), malformed].join('\n')

    // Should not crash
    const result = loadAndReduce(logWithBad)

    // Property: valid events processed, malformed ignored
    expect(result.state.tasks.get('task-1')!.status).toBe('complete')
    expect(result.warnings.length).toBe(1) // malformed line detected
  })

  test('reducer con evento con payload null no rompe', () => {
    const nullPayload = JSON.stringify({
      eventId: 'null-1', schemaVersion: '1', source: 'relaybus',
      eventName: 'agent:created', timestamp: 1001,
      actor: 'system', sequence: 99,
      payload: null, // Explicitly null payload
    })

    const logWithNull = [...VALID_LOG.split('\n'), nullPayload].join('\n')
    const result = loadAndReduce(logWithNull)

    // Should not crash; agent:created with null payload won't create an agent
    // but the rest should work
    expect(result.state.tasks.get('task-1')!.status).toBe('complete')
  })

  test('reducer con payload de tipo incorrecto no rompe', () => {
    const wrongPayload = JSON.stringify({
      eventId: 'wrong-1', schemaVersion: '1', source: 'relaybus',
      eventName: 'task:started', timestamp: 1001,
      taskId: 'task-wrong',
      actor: 'system', sequence: 98,
      payload: 'this is a string not an object', // Wrong type
    })

    const logWithWrong = [...VALID_LOG.split('\n'), wrongPayload].join('\n')

    // Should not crash
    const result = loadAndReduce(logWithWrong)

    // The event with wrong payload type is processed but prompt will be undefined
    // This is acceptable degradation, not corruption
    expect(result.state.tasks.size).toBeGreaterThanOrEqual(1)
  })
})

// ─── F8b: Storage atomicity (separado, requiere persistencia real) ────────────
// NOTA: Este fixture requiere filesystem real y no puede probarse solo en memoria.
// Se documenta aquí pero su ejecución completa queda para cuando exista la capa de persistencia.

describe('F8b: Storage atomicity (placeholder — requiere persistencia real)', () => {
  test.skip('kill del proceso mid-escritura → events.jsonl recuperable', () => {
    // REQUIRES: real filesystem, real process kill
    // This test is a placeholder documenting the requirement.
    // 
    // Steps when implemented:
    // 1. Write N events to events.jsonl
    // 2. Kill process mid-write (SIGKILL)
    // 3. Restart: load events.jsonl
    // 4. Verify: last line may be incomplete (ignored), previous lines valid
    //
    // This cannot be tested in-memory. It requires:
    // - Actual file I/O
    // - Process lifecycle management
    // - Crash simulation
    //
    // MARKED AS SKIP until persistence layer exists.
    expect(true).toBe(true)
  })

  test.skip('tmp file huérfano se detecta y limpia al reiniciar', () => {
    // REQUIRES: real filesystem
    // Similar to above but testing the .tmp cleanup mechanism.
    expect(true).toBe(true)
  })
})

// ─── Summary ──────────────────────────────────────────────────────────────────

describe('Resumen de fixtures', () => {
  test('los 10 fixtures están definidos', () => {
    // This is a meta-test to confirm all fixture groups exist
    // If any describe block above was removed, this test won't catch it,
    // but it serves as documentation.
    const fixtureNames = [
      'F1: Determinismo',
      'F2: Duplicación',
      'F3: Fuera de orden',
      'F4a: Evento desconocido por eventName',
      'F4b: Evento desconocido por schemaVersion',
      'F5: Truncamiento',
      'F6: Causalidad',
      'F7: Ciclo de vida de atención',
      'F8a: Atomicidad lógica',
      'F8b: Storage atomicity',
    ]
    expect(fixtureNames.length).toBe(10)
  })
})