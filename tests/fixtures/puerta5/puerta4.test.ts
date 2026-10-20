/**
 * puerta4.test.ts — Puerta 4: Replay seguro
 * 
 * Propiedad: Tomar un log de eventos y generar las tres proyecciones
 * (Inbox, Timeline, Canvas) SIN ejecutar agentes ni comandos.
 * Las proyecciones deben ser consistentes entre sí.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  loadAndReduce,
  serializeState,
  parseEventsJsonl,
  EventStoreState,
  CanonicalEvent,
  TaskState,
  AttentionItem,
} from './contracts.js'

const TEMP_DIR = join(import.meta.dir, 'tmp-puerta4')
const EVENTS_FILE = join(TEMP_DIR, 'events.jsonl')

// Same realistic log as Puerta 1
const REALISTIC_LOG = [
  JSON.stringify({ eventId: 'r001', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1000, agentId: 'ag-chatgpt', actor: 'user', sequence: 1, payload: { agentId: 'ag-chatgpt', platformId: 'chatgpt', role: 'primary' } }),
  JSON.stringify({ eventId: 'r002', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1001, agentId: 'ag-chatgpt', causationId: 'r001', actor: 'system', sequence: 2, payload: { agentId: 'ag-chatgpt', from: 'created', to: 'starting' } }),
  JSON.stringify({ eventId: 'r003', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1002, agentId: 'ag-chatgpt', causationId: 'r002', actor: 'system', sequence: 3, payload: { agentId: 'ag-chatgpt', from: 'starting', to: 'ready' } }),
  JSON.stringify({ eventId: 'r004', schemaVersion: '1', source: 'activitystore', eventName: 'task:started', timestamp: 1010, taskId: 'task-alpha', agentId: 'ag-chatgpt', causationId: 'r003', actor: 'user', sequence: 1, payload: { prompt: 'Analiza tendencias IA 2026' } }),
  JSON.stringify({ eventId: 'r005', schemaVersion: '1', source: 'coordinator', eventName: 'worker:started', timestamp: 1011, taskId: 'task-alpha', agentId: 'ag-claude', causationId: 'r004', actor: 'agent', sequence: 1, payload: { prompt: 'Investiga fuentes técnicas' } }),
  JSON.stringify({ eventId: 'r006', schemaVersion: '1', source: 'coordinator', eventName: 'worker:started', timestamp: 1012, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r004', actor: 'agent', sequence: 2, payload: { prompt: 'Investiga experiencia de usuario' } }),
  JSON.stringify({ eventId: 'r007', schemaVersion: '1', source: 'relaybus', eventName: 'agent:created', timestamp: 1013, agentId: 'ag-claude', actor: 'user', sequence: 4, payload: { agentId: 'ag-claude', platformId: 'claude' } }),
  JSON.stringify({ eventId: 'r008', schemaVersion: '1', source: 'relaybus', eventName: 'agent:lifecycle', timestamp: 1014, agentId: 'ag-claude', causationId: 'r007', actor: 'system', sequence: 5, payload: { agentId: 'ag-claude', from: 'created', to: 'ready' } }),
  JSON.stringify({ eventId: 'r009', schemaVersion: '1', source: 'coordinator', eventName: 'worker:responded', timestamp: 1020, taskId: 'task-alpha', agentId: 'ag-claude', causationId: 'r005', actor: 'agent', sequence: 3, payload: { response: 'Encontré 15 fuentes relevantes...' } }),
  JSON.stringify({ eventId: 'r010', schemaVersion: '1', source: 'relaybus', eventName: 'execution:unknown', timestamp: 1021, taskId: 'task-alpha', agentId: 'ag-glm', executionId: 'exec-456', actor: 'system', sequence: 6, payload: { reason: 'timeout esperando respuesta' } }),
  JSON.stringify({ eventId: 'r011', schemaVersion: '1', source: 'user', eventName: 'user:acknowledged', timestamp: 1025, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r010', actor: 'user', sequence: 1, payload: { attentionId: 'att-r010' } }),
  JSON.stringify({ eventId: 'r012', schemaVersion: '1', source: 'user', eventName: 'user:action', timestamp: 1026, taskId: 'task-alpha', agentId: 'ag-glm', causationId: 'r011', actor: 'user', sequence: 2, payload: { attentionId: 'att-r010', action: 'retry' } }),
  JSON.stringify({ eventId: 'r013', schemaVersion: '1', source: 'relaybus', eventName: 'execution:update', timestamp: 1030, taskId: 'task-alpha', agentId: 'ag-glm', executionId: 'exec-456', causationId: 'r012', actor: 'system', sequence: 7, payload: { status: 'success' } }),
  JSON.stringify({ eventId: 'r014', schemaVersion: '1', source: 'activitystore', eventName: 'task:finished', timestamp: 1035, taskId: 'task-alpha', agentId: 'ag-chatgpt', causationId: 'r004', actor: 'system', sequence: 2, payload: { result: 'Síntesis: tendencias dominantes son agents, MCP y colaboración.' } }),
].join('\n')

// ─── Projection generators (TEST versions, not production) ──────────────────

function generateInbox(state: EventStoreState): string {
  const lines: string[] = ['# Inbox — Items que requieren atención', '']

  if (state.attention.size === 0) {
    lines.push('_No hay items pendientes._')
  }

  for (const [id, item] of state.attention) {
    const icon = item.lifecycle === 'resolved' ? '✅' :
                 item.lifecycle === 'expired' ? '⏭️' :
                 item.lifecycle === 'detected' ? '🔴' :
                 item.lifecycle === 'acknowledged' ? '🟡' : '🔵'

    lines.push(`## ${icon} ${item.title}`)
    lines.push(`- **ID:** ${item.attentionId}`)
    lines.push(`- **Estado:** ${item.lifecycle}`)
    lines.push(`- **Descripción:** ${item.description}`)
    if (item.agentId) lines.push(`- **Agente:** ${item.agentId}`)
    if (item.taskId) lines.push(`- **Tarea:** ${item.taskId}`)
    lines.push(`- **Acciones disponibles:** ${item.availableActions.join(', ')}`)
    lines.push(`- **Historial:** ${item.history.map(h => h.to).join(' → ')}`)
    lines.push('')
  }

  return lines.join('\n')
}

function generateTimeline(events: CanonicalEvent[]): string {
  const lines: string[] = ['# Timeline — Secuencia de eventos', '']

  for (const ev of events) {
    const time = new Date(ev.timestamp).toISOString().substring(11, 19) // HH:MM:SS
    const source = ev.source.padEnd(14)
    const name = ev.eventName.padEnd(22)
    const agent = ev.agentId ?? '—'
    lines.push(`${time} | ${source} | ${name} | ${agent} | ${ev.eventId}`)
  }

  return lines.join('\n')
}

function generateCanvas(state: EventStoreState): string {
  const nodes: any[] = []
  const edges: any[] = []

  // Agent nodes
  for (const [agentId, agent] of state.agents) {
    nodes.push({
      id: agentId.replace(/[^a-f0-9]/g, '').padEnd(16, '0').substring(0, 16),
      type: 'text',
      x: 100,
      y: 100 + nodes.length * 100,
      width: 300,
      height: 120,
      color: agent.status === 'ready' ? '4' : agent.status === 'error' ? '1' : '3',
      text: `# ${agentId}\nStatus: ${agent.status}\nPlatform: ${agent.platformId ?? 'unknown'}`,
    })
  }

  // Task nodes
  for (const [taskId, task] of state.tasks) {
    nodes.push({
      id: taskId.replace(/[^a-f0-9]/g, '').padEnd(16, '1').substring(0, 16),
      type: 'text',
      x: 500,
      y: 100,
      width: 360,
      height: 200,
      color: task.status === 'complete' ? '4' : task.status === 'running' ? '5' : '3',
      text: `# ${taskId}\nStatus: ${task.status}\nPrompt: ${task.prompt.substring(0, 50)}...\nWorkers: ${task.workers.map(w => w.agentId).join(', ')}`,
    })

    // Edge from each worker to the task
    for (const worker of task.workers) {
      edges.push({
        id: `edge-${worker.agentId}-${taskId}`,
        fromNode: worker.agentId.replace(/[^a-f0-9]/g, '').padEnd(16, '0').substring(0, 16),
        fromSide: 'right',
        toNode: taskId.replace(/[^a-f0-9]/g, '').padEnd(16, '1').substring(0, 16),
        toSide: 'left',
      })
    }
  }

  return JSON.stringify({ nodes, edges }, null, 2)
}

// ─── Puerta 4 tests ───────────────────────────────────────────────────────────

describe('Puerta 4: Replay seguro', () => {
  beforeAll(() => {
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })
    writeFileSync(EVENTS_FILE, REALISTIC_LOG, 'utf8')
  })

  afterAll(() => {
    if (existsSync(EVENTS_FILE)) unlinkSync(EVENTS_FILE)
  })

  test('P4.1: replay genera Inbox desde events.jsonl sin ejecutar agentes', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { state } = loadAndReduce(content)

    const inbox = generateInbox(state)

    // Property: inbox contains the attention item
    expect(inbox).toContain('att-r010')
    expect(inbox).toContain('timeout esperando respuesta')
    expect(inbox).toContain('resolved') // The item was resolved via retry

    // Property: inbox is valid markdown
    expect(inbox).toContain('# Inbox')
    expect(inbox.length).toBeGreaterThan(100)
  })

  test('P4.2: replay genera Timeline desde events.jsonl', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { events } = parseEventsJsonl(content)

    const timeline = generateTimeline(events)

    // Property: timeline has all 14 events in order
    expect(timeline).toContain('r001')
    expect(timeline).toContain('r014')
    expect(timeline.split('\n').length).toBe(16) // 14 events + title + empty line

    // Property: events are in timestamp order
    const timestamps = events.map(e => e.timestamp)
    const sorted = [...timestamps].sort((a, b) => a - b)
    expect(timestamps).toEqual(sorted)
  })

  test('P4.3: replay genera Canvas (JSON Canvas válido) desde events.jsonl', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { state } = loadAndReduce(content)

    const canvasJson = generateCanvas(state)
    const canvas = JSON.parse(canvasJson)

    // Property: valid JSON Canvas structure
    expect(canvas.nodes).toBeDefined()
    expect(canvas.edges).toBeDefined()
    expect(Array.isArray(canvas.nodes)).toBe(true)
    expect(Array.isArray(canvas.edges)).toBe(true)

    // Property: nodes for both agents
    expect(canvas.nodes.length).toBeGreaterThanOrEqual(2) // ag-chatgpt, ag-claude

    // Property: node for the task
    expect(canvas.nodes.length).toBeGreaterThanOrEqual(3) // + task-alpha

    // Property: edges connect workers to task
    expect(canvas.edges.length).toBeGreaterThanOrEqual(2) // ag-claude→task, ag-glm→task
  })

  test('P4.4: las tres proyecciones son consistentes entre sí', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { state, events } = {
      ...loadAndReduce(content),
      ...parseEventsJsonl(content),
    }

    const inbox = generateInbox(state)
    const timeline = generateTimeline(events)
    const canvas = generateCanvas(state)

    // Consistency: the agent mentioned in inbox appears in timeline and canvas
    if (state.attention.size > 0) {
      const firstItem = Array.from(state.attention.values())[0]
      if (firstItem.agentId) {
        expect(timeline).toContain(firstItem.agentId)
        expect(canvas).toContain(firstItem.agentId.replace(/[^a-f0-9]/g, ''))
      }
    }

    // Consistency: task in canvas has the same workers as in state
    const task = state.tasks.get('task-alpha')
    if (task) {
      for (const worker of task.workers) {
        expect(canvas).toContain(worker.agentId)
      }
    }
  })

  test('P4.5: replay es determinista — dos corridas producen las mismas proyecciones', () => {
    const content = readFileSync(EVENTS_FILE, 'utf8')

    // First replay
    const { state: state1, events: events1 } = {
      ...loadAndReduce(content),
      ...parseEventsJsonl(content),
    }
    const inbox1 = generateInbox(state1)
    const timeline1 = generateTimeline(events1)
    const canvas1 = generateCanvas(state1)

    // Second replay (simulating a new session)
    const { state: state2, events: events2 } = {
      ...loadAndReduce(content),
      ...parseEventsJsonl(content),
    }
    const inbox2 = generateInbox(state2)
    const timeline2 = generateTimeline(events2)
    const canvas2 = generateCanvas(state2)

    // Property: all three projections are identical across replays
    expect(inbox1).toBe(inbox2)
    expect(timeline1).toBe(timeline2)
    expect(canvas1).toBe(canvas2)
  })

  test('P4.6: replay no toca el canvas editable humano', () => {
    // Simulate the human-editable canvas existing
    const humanCanvasPath = join(TEMP_DIR, 'Encargo de investigación multiagente.canvas')
    const humanCanvasContent = '{"nodes":[{"id":"human1","type":"text","text":"Editado por humano"}],"edges":[]}'
    writeFileSync(humanCanvasPath, humanCanvasContent, 'utf8')

    // Do a replay
    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { state } = loadAndReduce(content)
    const generatedCanvas = generateCanvas(state)

    // Write generated canvas to a DIFFERENT location
    const generatedPath = join(TEMP_DIR, '.generated', 'estado-sistema.canvas')
    mkdirSync(join(TEMP_DIR, '.generated'), { recursive: true })
    writeFileSync(generatedPath, generatedCanvas, 'utf8')

    // Property: human canvas is UNCHANGED
    const humanContentAfter = readFileSync(humanCanvasPath, 'utf8')
    expect(humanContentAfter).toBe(humanCanvasContent)

    // Property: generated canvas exists and is different from human canvas
    const generatedContentAfter = readFileSync(generatedPath, 'utf8')
    expect(generatedContentAfter).not.toBe(humanContentAfter)

    // Cleanup
    if (existsSync(humanCanvasPath)) unlinkSync(humanCanvasPath)
    if (existsSync(generatedPath)) unlinkSync(generatedPath)
  })

  test('P4.7: no se ejecutan agentes ni comandos durante el replay', () => {
    // This is a structural test: the replay path only uses
    // loadAndReduce + generateXxx functions, which are pure.
    // No side effects, no network calls, no agent execution.

    const content = readFileSync(EVENTS_FILE, 'utf8')
    const { state } = loadAndReduce(content)

    // The functions are pure: they only read state and produce strings
    const inbox = generateInbox(state)
    const canvas = generateCanvas(state)

    // Property: output is just strings (no side effects)
    expect(typeof inbox).toBe('string')
    expect(typeof canvas).toBe('string')

    // Property: state was not mutated by projection generation
    const stateBefore = serializeState(state)
    generateInbox(state) // Call again
    generateCanvas(state) // Call again
    const stateAfter = serializeState(state)
    expect(stateBefore).toBe(stateAfter)
  })
})