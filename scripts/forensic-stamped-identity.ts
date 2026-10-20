/**
 * Arnés forense — verifica el mecanismo de estampado de identidad añadido en
 * esta reconciliación: chrome.storage.local['mcp:instance-identity'] debe
 * tener PRECEDENCIA sobre instanceId/agentId que llegue en el payload de
 * createExecution() (que en producción viene del content script, y que por
 * diseño nunca debe ser la fuente de la identidad de un agente).
 *
 * Uso: bun run scripts/forensic-stamped-identity.ts
 */

// ─── Shim de chrome.storage.local CON soporte de onChanged ──────────────────
const storageData = new Map<string, unknown>()
type Listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void
const changeListeners: Listener[] = []

;(globalThis as any).chrome = {
  storage: {
    local: {
      async get(keys: unknown) {
        if (keys == null) return Object.fromEntries(storageData)
        if (typeof keys === 'string') {
          return storageData.has(keys) ? { [keys]: storageData.get(keys) } : {}
        }
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {}
          for (const k of keys) if (storageData.has(k)) out[k] = storageData.get(k)
          return out
        }
        return Object.fromEntries(storageData)
      },
      async set(obj: Record<string, unknown>) {
        const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {}
        for (const k in obj) {
          changes[k] = { oldValue: storageData.get(k), newValue: obj[k] }
          storageData.set(k, obj[k])
        }
        for (const l of changeListeners) l(changes, 'local')
      },
      async remove(keys: unknown) {
        const arr = Array.isArray(keys) ? keys : [keys]
        for (const k of arr as string[]) storageData.delete(k)
      },
    },
    onChanged: {
      addListener(fn: Listener) { changeListeners.push(fn) },
    },
  },
}

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  [OK]   ${label}`) }
  else { failures++; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}

async function main() {
  const Registry = await import(
    '../chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.ts'
  )

  console.log('\n=== Escenario 1: SIN stamp — el instanceId del input se respeta (modo manual, sin cambios) ===')
  {
    const { execution: e } = await Registry.createExecution({
      callId: 'call_unmanaged',
      toolName: 'Read',
      args: { path: 'a.txt' },
      instanceId: 'from-payload-unmanaged',
    })
    check('sin stamp, se usa el instanceId del input tal cual (compatibilidad con perfiles sin CLI)',
      e.instanceId === 'from-payload-unmanaged', `got instanceId=${e.instanceId}`)
  }

  console.log('\n=== Escenario 2: estampando identidad DESPUÉS de que el módulo ya hidrató ===')
  {
    // Simula el flujo real: hydrate() ya corrió (arriba), y AHORA — como pasaría
    // cuando el CLI hace stampInstanceIdentity() vía CDP tras que el SW ya
    // arrancó — llega el storage.onChanged con la identidad real.
    await chrome.storage.local.set({
      'mcp:instance-identity': {
        schema: 1,
        instanceId: 'web-STAMPED-REAL-0001',
        agentId: 'agent-A-real',
        platformId: 'chatgpt',
        stampedAt: Date.now(),
      },
    })

    const { execution: e } = await Registry.createExecution({
      callId: 'call_stamped',
      toolName: 'Read',
      args: { path: 'b.txt' },
      // Un content script comprometido o con un bug intenta hacerse pasar
      // por OTRO agente — esto es exactamente lo que NO debe funcionar.
      instanceId: 'attacker-supplied-instance-id',
      agentId: 'attacker-supplied-agent-id',
    })

    check('la ejecución usa el instanceId ESTAMPADO, no el que vino en el payload',
      e.instanceId === 'web-STAMPED-REAL-0001', `got instanceId=${e.instanceId}`)
    check('la ejecución usa el agentId ESTAMPADO, no el que vino en el payload',
      e.agentId === 'agent-A-real', `got agentId=${e.agentId}`)
    check('la ejecución NUNCA adopta el instanceId que un content script intentó inyectar',
      e.instanceId !== 'attacker-supplied-instance-id')
  }

  console.log('\n=== Escenario 3: platformId SÍ se respeta desde el input aunque haya stamp (es metadato de UI, no identidad) ===')
  {
    const { execution: e } = await Registry.createExecution({
      callId: 'call_platform',
      toolName: 'Read',
      args: { path: 'c.txt' },
      platformId: 'gemini', // el adapter activo en ESTE momento, distinto al de la instancia
    })
    check('platformId del input tiene precedencia sobre el estampado (metadato de adapter en vivo)',
      e.platformId === 'gemini', `got platformId=${e.platformId}`)
  }

  console.log('\n=== Escenario 4: dos agentes reales, mismo callId, identidad SOLO por stamp (no por input) ===')
  {
    // Agente A: ya estampado arriba como web-STAMPED-REAL-0001.
    const { execution: eA } = await Registry.createExecution({
      callId: 'call_same', toolName: 'Bash', args: { command: 'echo A' }, effectClass: 'effectful',
    })
    check('agente A usa su identidad estampada sin pasar instanceId en el input',
      eA.instanceId === 'web-STAMPED-REAL-0001')

    // Re-estampar para simular que EL MISMO módulo de storage ahora "es" el
    // service worker de una instancia B (en la practica cada instancia tiene
    // su propio storage aislado; esto solo ejercita que el watcher reacciona).
    await chrome.storage.local.set({
      'mcp:instance-identity': {
        schema: 1, instanceId: 'web-STAMPED-REAL-0002', agentId: 'agent-B-real', stampedAt: Date.now(),
      },
    })
    const { execution: eB } = await Registry.createExecution({
      callId: 'call_same', toolName: 'Bash', args: { command: 'echo B' }, effectClass: 'effectful',
    })
    check('tras re-estampar, la siguiente ejecución usa la NUEVA identidad (el watcher de onChanged funciona)',
      eB.instanceId === 'web-STAMPED-REAL-0002')
    check('mismo callId, identidades de stamp distintas → executionKey distinto',
      eA.executionKey !== eB.executionKey, `A=${eA.executionKey} B=${eB.executionKey}`)
  }

  console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`)
  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error('ERROR FATAL EN EL ARNÉS:', err)
  process.exit(1)
})
