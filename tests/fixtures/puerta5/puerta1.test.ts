/**
 * puerta1.test.ts — Puerta 1: Reconstrucción tras reinicio
 * 
 * Propiedad: El mismo conjunto de eventos produce el mismo TaskState
 * antes y después de "reiniciar" (nueva instancia, sin estado residual).
 * 
 * Prueba con persistencia real en archivo temporal.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  loadAndReduce,
  serializeState,
  parseEventsJsonl,
  reduceEvents,
  EventStoreState,
} from './contracts.js'

const TEMP_DIR = join(import.meta.dir, 'tmp-puerta1')
const EVENTS_FILE = join(TEMP_DIR, 'events.jsonl')

// Test data: a realistic event log
const REALISTIC_LOG = [
  JSON.stringify({ eventId: 'r001', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1000, agentId: 'ag-chatgpt', actor: 'user', sequence: 1, payload: { agentId: 'ag-chatgpt', platformId: 'chatgpt', role: 'primary' } }),
  JSON.stringify({ eventId: 'r002', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1001, agentId: 'ag-chatgpt', causationId: 'r001', actor: 'system', sequence: 2, payload: { agentId: 'ag-chatgpt', from: 'created', to: 'starting' } }),
  JSON.stringify({ eventId: 'r003', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1002, agentId: 'ag-chatgpt', causationId: 'r002', actor: 'system', sequence: 3, payload: { agentId: 'ag-chatgpt', from: 'starting', to: 'chrome_ready' } }),
  JSON.stringify({ eventId: 'r004', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1003, agentId: 'ag-chatgpt', causationId: 'r003', actor: 'system', sequence: 4, payload: { agentId: 'ag-chatgpt', from: 'chrome_ready', to: 'mcp_ready' } }),
  JSON.stringify({ eventId: 'r005', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1004, agentId: 'ag-chatgpt', causationId: 'r004', actor: 'system', sequence: 5, payload: { agentId: 'ag-chatgpt', from: 'mcp_ready', to: 'ready' } }),
  JSON.stringify({ eventId: 'r006', schemaVersion: '1', source: 'activitystore', eventName: 'task:started', timestamp: 1010, taskId: 'task-alpha', agentId: 'ag-chatgpt', causationId: 'r005', actor: 'user', sequence: 1, payload: { prompt: 'Analiza tendencias IA 2026' } }),
  JSON.stringify({ eventId: 'r007', schemaVersion: '1', source: 'coordinator', eventName: 'worker:started', timestamp: 1011, taskId: 'task-alpha', agentId: 'ag-claude', causationId: 'r006', actor: 'agent', sequence: 1, payload: { prompt: 'Investiga fuentes técnicas' } }),
  JSON.stringify({ eventId: 'r008', schemaVersion: '1', source: 'coordinator', eventName: 'worker:started', timestamp: 1012, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r006', actor: 'agent', sequence: 2, payload: { prompt: 'Investiga experiencia de usuario' } }),
  JSON.stringify({ eventId: 'r009', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1013, agentId: 'ag-claude', actor: 'user', sequence: 6, payload: { agentId: 'ag-claude', platformId: 'claude' } }),
  JSON.stringify({ eventId: 'r010', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1014, agentId: 'ag-claude', causationId: 'r009', actor: 'system', sequence: 7, payload: { agentId: 'ag-claude', from: 'created', to: 'ready' } }),
  JSON.stringify({ eventId: 'r011', schemaVersion: '1', source: 'coordinator', eventName: 'worker:responded', timestamp: 1020, taskId: 'task-alpha', agentId: 'ag-claude', causationId: 'r007', actor: 'agent', sequence: 3, payload: { response: 'Encontré 15 fuentes relevantes sobre tendencias IA 2026...' } }),
  JSON.stringify({ eventId: 'r012', schemaVersion: '1', source: 'relaybus', eventName: 'execution:unknown', timestamp: 1021, taskId: 'task-alpha', agentId: 'ag-glm', executionId: 'exec-456', actor: 'system', sequence: 8, payload: { reason: 'timeout esperando respuesta' } }),
  JSON.stringify({ eventId: 'r013', schemaVersion: '1', source: 'user', eventName: 'user:acknowledged', timestamp: 1025, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r012', actor: 'user', sequence: 1, payload: { attentionId: 'att-r012' } }),
  JSON.stringify({ eventId: 'r014', schemaVersion: '1', source: 'user', eventName: 'user:action', timestamp: 1026, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r013', actor: 'user', sequence: 2, payload: { attentionId: 'att-r012', action: 'retry' } }),
  JSON.stringify({ eventId: 'r015', schemaVersion: '1', source: 'relaybus', eventName: 'execution:update', timestamp: 1030, taskId: 'task-alpha', agentId: 'ag-glm', executionId: 'exec-456', causationId: 'r014', actor: 'system', sequence: 9, payload: { status: 'success' } }),
  JSON.stringify({ eventId: 'r016', schemaVersion: '1', source: 'activitystore', eventName: 'task:finished', timestamp: 1035, taskId: 'task-alpha', agentId: 'ag-chatgpt', causationId: 'r006', actor: 'system', sequence: 2, payload: { result: 'Síntesis de 15 fuentes: tendencias dominantes son agents, MCP y colaboración.' } }),
].join('\n')

// Setup and cleanup
describe('Puerta 1: Reconstrucción tras reinicio', () => {
  beforeAll(() => {
    if (!existsSync(TEMP_DIR)) {
      mkdirSync(TEMP_DIR, { recursive: true })
    }
    // Write the events to a real file
    writeFileSync(EVENTS_FILE, REALISTIC_LOG, 'utf8')
  })

  afterAll(() => {
    // Cleanup
    if (existsSync(EVENTS_FILE)) unlinkSync(EVENTS_FILE)
    if (existsSync(TEMP_DIR)) {
      try { unlinkSync(join(TEMP_DIR)) } catch { /* ignore */ }
    }
  })

  test('P1.1: persistir a archivo, cargar, reducir → estado inicial', () => {
    // Load from real file
    const fileContent = readFileSync(EVENTS_FILE, 'utf8')
    const { state, warnings } = loadAndReduce(fileContent)

    // Verify expected state
    expect(state.tasks.size).toBe(1)
    expect(state.tasks.has('task-alpha')).toBe(true)

    const task = state.tasks.get('task-alpha')!
    expect(task.status).toBe('complete')
    expect(task.prompt).toBe('Analiza tendencias IA 2026')
    expect(task.workers.length).toBe(2) // ag-claude and ag-glm

    expect(state.agents.size).toBe(2) // ag-chatgpt and ag-claude
    expect(state.agents.get('ag-chatgpt')!.status).toBe('ready')
    expect(state.agents.get('ag-claude')!.status).toBe('ready')

    expect(warnings.length).toBe(0) // No malformed events
  })

  test('P1.2: simular reinicio — nueva carga produce mismo estado', () => {
    // FIRST "PROCESS": load and reduce
    const content1 = readFileSync(EVENTS_FILE, 'utf8')
    const result1 = loadAndReduce(content1)
    const serialized1 = serializeState(result1.state)

    // Simulate process death: everything in memory is gone
    // (In a real scenario, the process would exit here)

    // SECOND "PROCESS": fresh load from the SAME file
    // No residual state, no cache, just file → parse → reduce
    const content2 = readFileSync(EVENTS_FILE, 'utf8')
    const result2 = loadAndReduce(content2)
    const serialized2 = serializeState(result2.state)

    // CRITICAL PROPERTY: both serializations are IDENTICAL
    expect(serialized1).toBe(serialized2)
  })

  test('P1.3: tres procesos secuenciales producen el mismo estado', () => {
    const serializations: string[] = []

    // Simulate 3 sequential "processes" reading the same log
    for (let i = 0; i < 3; i++) {
      const content = readFileSync(EVENTS_FILE, 'utf8')
      const result = loadAndReduce(content)
      serializations.push(serializeState(result.state))
    }

    // All three must be identical
    expect(serializations[0]).toBe(serializations[1])
    expect(serializations[1]).toBe(serializations[2])
    expect(serializations[0]).toBe(serializations[2])
  })

  test('P1.4: estado no depende de variables estáticas o residuales', () => {
    // This test verifies that reduceEvents creates a completely new state
    // each time, not mutating a shared global.

    const events = parseEventsJsonl(REALISTIC_LOG).events

    // First reduction
    const state1 = reduceEvents(events)
    const task1 = state1.tasks.get('task-alpha')
    const task1Status = task1!.status

    // Mutate the first state (simulating residual contamination)
    task1!.status = 'failed'

    // Second reduction — should NOT be affected by mutation above
    const state2 = reduceEvents(events)
    const task2 = state2.tasks.get('task-alpha')

    // The second reduction should still have the correct status
    // regardless of what we did to the first state
    expect(task2!.status).toBe(task1Status === 'failed' ? 'complete' : task1Status)
    expect(task2!.status).toBe('complete') // The correct value from events
  })

  test('P1.5: archivo con 16 eventos completos se reconstruye sin pérdida', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { events } = parseEventsJsonl(content)

    // Verify all 16 events were parsed
    expect(events.length).toBe(16)

    // Verify no duplicates were detected
    const result = loadAndReduce(content)
    expect(result.state.deduplicatedEvents.length).toBe(0)

    // Verify no unknown events
    expect(result.state.unknownEvents.length).toBe(0)
  })

  test('P1.6: reconstrucción desde archivo truncado produce estado parcial correcto', () => {
    // Simulate: process crashed after writing 12 of 16 events
    const lines = REALISTIC_LOG.split('\n')
    const partialLog = lines.slice(0, 12).join('\n')

    // Write partial log to a temp file
    const partialFile = join(TEMP_DIR, 'partial-events.jsonl')
    writeFileSync(partialFile, partialLog, 'utf8')

    // Load from partial file
    const partialContent = readFileSync(partialFile, 'utf8')
    const partialResult = loadAndReduce(partialContent)

    // Task should still be running (not complete, because task:finished was lost)
    const task = partialResult.state.tasks.get('task-alpha')
    expect(task!.status).toBe('running')

    // But workers that responded should be complete
    const claudeWorker = task!.workers.find(w => w.agentId === 'ag-claude')
    expect(claudeWorker!.status).toBe('complete')

    // Cleanup
    if (existsSync(partialFile)) unlinkSync(partialFile)
  })
})

// ─── Puerta 1: Additional robustness ─────────────────────────────────────────

describe('Puerta 1: Robustez adicional de reconstrucción', () => {
  test('P1.7: archivo vacío produce estado vacío sin crash', () => {
    const emptyFile = join(TEMP_DIR, 'empty.jsonl')
    writeFileSync(emptyFile, '', 'utf8')

    const content = readFileSync(emptyFile, 'utf8')
    const result = loadAndReduce(content)

    expect(result.state.tasks.size).toBe(0)
    expect(result.state.agents.size).toBe(0)
    expect(result.warnings.length).toBe(0)

    if (existsSync(emptyFile)) unlinkSync(emptyFile)
  })

  test('P1.8: archivo con solo eventos de agente produce estado sin tareas', () => {
    const agentOnlyLog = [
      JSON.stringify({ eventId: 'ao1', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1000, agentId: 'ag-1', actor: 'user', sequence: 1, payload: { agentId: 'ag-1', platformId: 'test' } }),
      JSON.stringify({ eventId: 'ao2', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1001, agentId: 'ag-1', causationId: 'ao1', actor: 'system', sequence: 2, payload: { agentId: 'ag-1', from: 'created', to: 'ready' } }),
    ].join('\n')

    const result = loadAndReduce(agentOnlyLog)
    expect(result.state.agents.size).toBe(1)
    expect(result.state.agents.get('ag-1')!.status).toBe('ready')
    expect(result.state.tasks.size).toBe(0)
  })
})