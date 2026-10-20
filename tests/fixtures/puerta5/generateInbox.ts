/**
 * generateInbox.ts — Genera un Inbox realista para Puerta 2
 * Simula las anomalías reales observadas por el usuario
 */

import {
  loadAndReduce,
  EventStoreState,
  AttentionItem,
} from './contracts.js'

// Eventos que simulan el estado REAL del sistema del usuario
const REALISTIC_EVENTS = [
  // GLM-5.3: prompt enviado, sin respuesta visible
  JSON.stringify({
    eventId: 'real001', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:created', timestamp: Date.now() - 3600000,
    agentId: 'z-ai-glm-5-3', actor: 'user', sequence: 1,
    payload: { agentId: 'z-ai-glm-5-3', platformId: 'zai', role: 'primary' }
  }),
  JSON.stringify({
    eventId: 'real002', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:lifecycle', timestamp: Date.now() - 3599000,
    agentId: 'z-ai-glm-5-3', causationId: 'real001', actor: 'system', sequence: 2,
    payload: { agentId: 'z-ai-glm-5-3', from: 'created', to: 'mcp_ready' }
  }),

  // ChatGPT: Pensar activo, sin dispatch tras 240 segundos
  JSON.stringify({
    eventId: 'real003', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:created', timestamp: Date.now() - 3500000,
    agentId: 'loco-verde', actor: 'user', sequence: 3,
    payload: { agentId: 'loco-verde', platformId: 'chatgpt', role: 'worker' }
  }),
  JSON.stringify({
    eventId: 'real004', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:lifecycle', timestamp: Date.now() - 3499000,
    agentId: 'loco-verde', causationId: 'real003', actor: 'system', sequence: 4,
    payload: { agentId: 'loco-verde', from: 'created', to: 'mcp_ready' }
  }),

  // Claude: usa bash_tool en vez de SA/MCP
  JSON.stringify({
    eventId: 'real005', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:created', timestamp: Date.now() - 3400000,
    agentId: 'locoverdesito', actor: 'user', sequence: 5,
    payload: { agentId: 'locoverdesito', platformId: 'claude', role: 'worker' }
  }),
  JSON.stringify({
    eventId: 'real006', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:lifecycle', timestamp: Date.now() - 3399000,
    agentId: 'locoverdesito', causationId: 'real005', actor: 'system', sequence: 6,
    payload: { agentId: 'locoverdesito', from: 'created', to: 'mcp_ready' }
  }),

  // Tarea de investigación enviada a los tres
  JSON.stringify({
    eventId: 'real007', schemaVersion: '1', source: 'activitystore',
    eventName: 'task:started', timestamp: Date.now() - 3300000,
    taskId: 'encargo-investigacion', causationId: 'real002', actor: 'user', sequence: 1,
    payload: { prompt: 'Investiga colaboración multiagente para OpenMCPWEBLOCK' }
  }),

  // ANOMALÍA 1: GLM-5.3 sin respuesta
  JSON.stringify({
    eventId: 'real008', schemaVersion: '1', source: 'relaybus',
    eventName: 'execution:unknown', timestamp: Date.now() - 3000000,
    taskId: 'encargo-investigacion', agentId: 'z-ai-glm-5-3',
    executionId: 'exec-glm-attempt', actor: 'sentinel', sequence: 7,
    payload: { reason: 'Prompt enviado hace 50 minutos. Sin respuesta visible. Sin dispatch SA/MCP correlacionado. Selector muestra GLM-5.3 (no Flash). Sin señal de cuota agotada.' }
  }),

  // ANOMALÍA 2: ChatGPT sin dispatch tras 240s
  JSON.stringify({
    eventId: 'real009', schemaVersion: '1', source: 'relaybus',
    eventName: 'execution:unknown', timestamp: Date.now() - 2760000,
    taskId: 'encargo-investigacion', agentId: 'loco-verde',
    executionId: 'exec-chatgpt-attempt', actor: 'sentinel', sequence: 8,
    payload: { reason: 'Pensar activo. Turno completado pero sin dispatch+resultado SA/MCP correlacionado tras 240 segundos. Hilo muestra aria-busy pero sin salida de eventos.' }
  }),

  // ANOMALÍA 3: Claude ejecutó bash_tool en vez de SA/MCP
  JSON.stringify({
    eventId: 'real010', schemaVersion: '1', source: 'relaybus',
    eventName: 'agent:error', timestamp: Date.now() - 2400000,
    taskId: 'encargo-investigacion', agentId: 'locoverdesito',
    actor: 'sentinel', sequence: 9,
    payload: { error: 'Ejecutó bash_tool en lugar de filesystem.read_text_file. El resultado no tiene executionId correlacionado ni dispatch SA/MCP. La llamada no cuenta como válida según el protocolo.', phase: 'execution' }
  }),

  // CLAUDE SÍ tuvo una ejecución válida posterior
  JSON.stringify({
    eventId: 'real011', schemaVersion: '1', source: 'relaybus',
    eventName: 'execution:update', timestamp: Date.now() - 1800000,
    taskId: 'encargo-investigacion', agentId: 'locoverdesito',
    executionId: 'exec-claude-valid', causationId: 'real005', actor: 'system', sequence: 10,
    payload: { status: 'success' }
  }),
].join('\n')

// Generar el Inbox
const { state } = loadAndReduce(REALISTIC_EVENTS)

// ─── Generar Inbox como lo vería el usuario ─────────────────────────────────

function generateInboxForHuman(state: EventStoreState): string {
  const lines: string[] = []

  lines.push('# 📥 Inbox — Qué necesita tu atención ahora')
  lines.push('')
  lines.push(`_Generado: ${new Date().toLocaleTimeString()} · ${state.attention.size} items_`)
  lines.push('')

  if (state.attention.size === 0) {
    lines.push('✅ **Todo normal.** Nada requiere tu intervención.')
    return lines.join('\n')
  }

  // Sort by severity: error > unknown
  const sorted = Array.from(state.attention.values()).sort((a, b) => {
    const severity = (lifecycle: string) => lifecycle === 'detected' ? 2 : 1
    return severity(b.lifecycle) - severity(a.lifecycle)
  })

  for (const item of sorted) {
    const icon = item.lifecycle === 'resolved' ? '✅' : '⚠️'
    const agentName = item.agentId
      ?.replace('z-ai-glm-5-3', 'GLM-5.3')
      .replace('loco-verde', 'ChatGPT')
      .replace('locoverdesito', 'Claude') ?? 'Desconocido'

    lines.push(`---`)
    lines.push(`## ${icon} ${agentName}: ${item.title}`)
    lines.push(`**Estado:** ${item.lifecycle === 'detected' ? '🔴 Requiere decisión' : '✅ Resuelto'}`)
    lines.push('')
    lines.push(`> ${item.description}`)
    lines.push('')

    if (item.lifecycle === 'detected') {
      lines.push(`**¿Qué puedes hacer?**`)

      // Suggest specific actions based on the anomaly
      if (item.agentId === 'z-ai-glm-5-3') {
        lines.push(`- 🔄 **Reintentar:** enviar el prompt de nuevo en la misma Master`)
        lines.push(`- 📝 **Ver hilo:** abrir :9402 y comprobar si hay respuesta tardía`)
        lines.push(`- ❌ **Descartar:** cerrar esta Master y usar otra vía`)
      } else if (item.agentId === 'loco-verde') {
        lines.push(`- ⏱️ **Esperar:** Pensar puede tardar >4 min en tareas complejas`)
        lines.push(`- 🔄 **Reintentar:** enviar follow-up en el mismo hilo`)
        lines.push(`- ❌ **Descartar:** cerrar y reabrir con prompt más simple`)
      } else if (item.agentId === 'locoverdesito') {
        lines.push(`- 📝 **Ver resultado:** Claude SÍ completó una lectura válida después`)
        lines.push(`- ✅ **Aceptar:** la ejecución válida ya está registrada`)
      }

      lines.push('')
      lines.push(`<sub>Item: ${item.attentionId} · Evento: ${item.eventId}</sub>`)
    }
  }

  // Summary
  const unresolved = Array.from(state.attention.values()).filter(i => i.lifecycle !== 'resolved').length
  const resolved = state.attention.size - unresolved

  lines.push('---')
  lines.push(`**Resumen:** ${unresolved} requieren decisión · ${resolved} resueltos`)

  return lines.join('\n')
}

// Print the inbox
const inbox = generateInboxForHuman(state)
console.log(inbox)

// Also print the raw state for verification
console.log('\n--- RAW STATE (for verification) ---')
console.log(`Agents: ${state.agents.size}`)
console.log(`Tasks: ${state.tasks.size}`)
console.log(`Attention items: ${state.attention.size}`)
for (const [id, item] of state.attention) {
  console.log(`  ${id}: ${item.lifecycle} - ${item.agentId}`)
}
console.log(`Unknown events: ${state.unknownEvents.length}`)
console.log(`Deduplicated: ${state.deduplicatedEvents.length}`)
console.log(`Errors in agents: ${Array.from(state.agents.values()).filter(a => a.status === 'error').length}`)
