/**
 * Arnés forense — ejecuta el ExecutionRegistry.ts REAL (no una reimplementación)
 * bajo un shim mínimo de chrome.storage.local.
 *
 * ACTUALIZADO tras docs/EXECUTION_FORENSIC_STATE.md: createExecution() ahora
 * devuelve {execution, coalesced, blockedByUnknownOutcome?}, y las mutaciones
 * (markRunning/completeExecution/failExecution/cancelExecution/attachExecutionTab)
 * exigen executionId — pasar executionKey debe lanzar explícitamente.
 *
 * Uso: bun run scripts/forensic-execution-registry.ts
 */

const storageData = new Map<string, unknown>()
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
        for (const k in obj) storageData.set(k, obj[k])
      },
      async remove(keys: unknown) {
        const arr = Array.isArray(keys) ? keys : [keys]
        for (const k of arr as string[]) storageData.delete(k)
      },
    },
    onChanged: { addListener() {} },
  },
}

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  [OK]   ${label}`) }
  else { failures++; console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}
async function checkThrows(label: string, fn: () => Promise<unknown>, matchText?: string): Promise<void> {
  try {
    await fn()
    failures++
    console.log(`  [FAIL] ${label} — no lanzó`)
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    const ok = matchText ? msg.includes(matchText) : true
    if (ok) { passed++; console.log(`  [OK]   ${label}`) }
    else { failures++; console.log(`  [FAIL] ${label} — lanzó pero sin el texto esperado: ${msg}`) }
  }
}

async function main() {
  const Registry = await import(
    '../chrome-extension/source/chrome-extension/src/background/ExecutionRegistry.ts'
  )

  console.log('\n=== Escenario 1: dos ejecuciones legítimamente IGUALES (mismo callId, mismos args, mismo agente) ===')
  {
    const input = { callId: 'call_1', toolName: 'Read', args: { path: 'a.txt' }, instanceId: 'agentA' }
    const r1 = await Registry.createExecution(input)
    const r2 = await Registry.createExecution({ ...input })
    check('misma dirección lógica → mismo executionId (deduplicado)',
      r1.execution.executionId === r2.execution.executionId,
      `e1=${r1.execution.executionId} e2=${r2.execution.executionId}`)
    check('la primera llamada NO viene marcada como coalescida', r1.coalesced !== true)
    check('la segunda llamada SÍ viene marcada como coalescida (no debe lanzar un segundo worker)',
      r2.coalesced === true, `coalesced=${r2.coalesced}`)
  }

  console.log('\n=== Escenario 2: dos ejecuciones legítimamente DISTINTAS (mismo agente, args distintos) ===')
  {
    const { execution: e1 } = await Registry.createExecution({ callId: 'call_2', toolName: 'Read', args: { path: 'x.txt' }, instanceId: 'agentA' })
    const { execution: e2 } = await Registry.createExecution({ callId: 'call_3', toolName: 'Read', args: { path: 'y.txt' }, instanceId: 'agentA' })
    check('callId distinto → executionId distinto', e1.executionId !== e2.executionId)
  }

  console.log('\n=== Escenario 3: mismo callId, CONTENIDO distinto (reutilización de callId por el modelo) ===')
  {
    // effectClass:'pure' explicito: Read no muta nada, así que reemplazar una
    // ejecucion interrumpida en la misma direccion es seguro por diseno. Sin
    // esto, createExecution() cae al default conservador 'effectful' y BLOQUEA
    // el reemplazo hasta que alguien reconozca el desenlace desconocido — el
    // comportamiento correcto de la invariante 12/13, no un bug de este escenario.
    const { execution: e1 } = await Registry.createExecution({ callId: 'call_4', toolName: 'Read', args: { path: 'first.txt' }, instanceId: 'agentA', effectClass: 'pure' })
    const { execution: e2 } = await Registry.createExecution({ callId: 'call_4', toolName: 'Read', args: { path: 'second.txt' }, instanceId: 'agentA', effectClass: 'pure' })
    check('misma dirección, contenido distinto → NUEVO executionId (no se devuelve el resultado viejo)',
      e1.executionId !== e2.executionId)
    check('la segunda ejecución lleva los args nuevos, no los del primer call',
      JSON.stringify(e2.params) === JSON.stringify({ path: 'second.txt' }))
  }

  console.log('\n=== Escenario 3b: la MISMA reutilización de callId, pero con una herramienta effectful sin effectClass explícito ===')
  {
    // Este es el camino conservador real: sin effectClass declarado, el sistema
    // NO reemplaza silenciosamente una ejecucion con desenlace desconocido.
    const { execution: e1 } = await Registry.createExecution({ callId: 'call_4b', toolName: 'Bash', args: { command: 'echo uno' }, instanceId: 'agentA' })
    const blocked = await Registry.createExecution({ callId: 'call_4b', toolName: 'Bash', args: { command: 'echo dos' }, instanceId: 'agentA' })
    check('sin effectClass explícito (default effectful), un callId reusado con contenido distinto se BLOQUEA, no se reemplaza a ciegas',
      blocked.blockedByUnknownOutcome !== undefined, `blockedByUnknownOutcome=${JSON.stringify(blocked.blockedByUnknownOutcome?.executionId)}`)
    const forced = await Registry.createExecution({ callId: 'call_4b', toolName: 'Bash', args: { command: 'echo dos' }, instanceId: 'agentA', force: true })
    check('con force:true explícito, el bloqueo se puede superar (decisión humana/orquestador, no automática)',
      forced.execution.executionId !== e1.executionId && !forced.blockedByUnknownOutcome)
  }

  console.log('\n=== Escenario 4: mismo callId Y mismo contenido, en DOS AGENTES distintos ===')
  {
    const args = { command: 'git status' }
    const { execution: eA } = await Registry.createExecution({ callId: 'call_5', toolName: 'Bash', args, instanceId: 'agentA', effectClass: 'effectful' })
    const { execution: eB } = await Registry.createExecution({ callId: 'call_5', toolName: 'Bash', args, instanceId: 'agentB', effectClass: 'effectful' })
    check('mismo callId + mismo contenido pero agentes distintos → NUNCA se fusionan',
      eA.executionId !== eB.executionId, `eA=${eA.executionId} eB=${eB.executionId}`)
    check('cada uno retiene su propio instanceId', eA.instanceId === 'agentA' && eB.instanceId === 'agentB')
  }

  console.log('\n=== Escenario 4b (invariante nueva de esta sesión): mutar por executionKey debe RECHAZARSE explícitamente ===')
  {
    const { execution } = await Registry.createExecution({ callId: 'call_5b', toolName: 'Read', args: { path: 'k.txt' }, instanceId: 'agentA' })
    await checkThrows(
      'markRunning(executionKey) lanza en vez de mutar silenciosamente lo que ocupe esa dirección',
      () => Registry.markRunning(execution.executionKey),
      'address',
    )
  }

  console.log('\n=== Escenario 5: DOS REINTENTOS CONCURRENTES de la misma ejecución (por executionId) ===')
  {
    const { execution: created } = await Registry.createExecution({ callId: 'call_6', toolName: 'Bash', args: { command: 'echo x' }, instanceId: 'agentA', effectClass: 'effectful' })
    const id = created.executionId
    const results = await Promise.allSettled([
      Registry.markRunning(id),
      Registry.markRunning(id),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled').length
    const rejected = results.filter(r => r.status === 'rejected').length
    check('la mutación está serializada: una transición corre, la otra ve el estado ya cambiado y es rechazada',
      fulfilled === 1 && rejected === 1, `fulfilled=${fulfilled} rejected=${rejected}`)

    const settleResults = await Promise.allSettled([
      Registry.completeExecution(id, 'ok'),
      Registry.failExecution(id, new Error('boom')),
    ])
    const settleFulfilled = settleResults.filter(r => r.status === 'fulfilled').length
    check('solo UNA transición terminal gana; la otra es rechazada por el DAG (no hay estado final ambiguo)',
      settleFulfilled === 1, `fulfilled=${settleFulfilled}`)

    const final = await Registry.getExecution(id)
    check('el estado final es un único valor terminal consistente, no un híbrido corrupto',
      final !== null && ['success', 'error'].includes(final.status))
  }

  console.log('\n=== Escenario 6 (regresión del bug de la sesión de integridad): resolución POST-TERMINAL por executionId ===')
  {
    const { execution: created } = await Registry.createExecution({ callId: 'call_7', toolName: 'Read', args: { path: 'z.txt' }, instanceId: 'agentA' })
    const id = created.executionId
    await Registry.markRunning(id)
    await Registry.completeExecution(id, { content: 'hola' })

    const fetched = await Registry.getExecution(id)
    check('getExecution(executionId) sigue resolviendo DESPUÉS de completar (recuperación post-refresco)',
      fetched !== null && fetched.status === 'success', `fetched=${JSON.stringify(fetched)}`)

    const fetchedByAddress = await Registry.getExecution(created.executionKey)
    check('getExecution(executionKey) también resuelve post-terminal (fix de la sesión de integridad: hydrate() ya indexa terminales)',
      fetchedByAddress !== null && fetchedByAddress.status === 'success')

    const attached = await Registry.attachExecutionTab(id, 999)
    check('attachExecutionTab(executionId) también resuelve post-terminal (mcp:resume-execution)',
      attached !== null && attached.tabId === 999)
  }

  console.log('\n=== Escenario 7: herramienta effectful interrumpida en boot anterior → NO se auto-reintenta ===')
  {
    const { execution: created } = await Registry.createExecution({ callId: 'call_8', toolName: 'Bash', args: { command: 'git push' }, instanceId: 'agentA', effectClass: 'effectful' })
    await Registry.markRunning(created.executionId)
    const stuck = await Registry.getExecution(created.executionId)
    check('canAutoRetry() es false para un effectful sin desenlace conocido',
      stuck !== null && Registry.canAutoRetry(stuck) === false)
  }

  console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`)
  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error('ERROR FATAL EN EL ARNÉS:', err)
  process.exit(1)
})
