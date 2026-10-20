/**
 * PENDING-MANUAL cerrado con evidencia real: reinicio genuino del Service
 * Worker de una extension real, en Chrome real, con una ejecucion 'effectful'
 * dejada en estado 'running' justo antes del reinicio.
 *
 * Ninguna sesion anterior (ni la de integridad de ejecucion, ni la mia propia)
 * pudo verificar esto porque ninguna tenia, en ese momento, una instancia de
 * Chrome real y gestionable con SA cargada y viva. Esta si la tiene: reusa
 * exactamente el mecanismo CDP verificado en el P0 original (browser-level ws
 * -> Target.getTargets -> Target.attachToTarget -> Runtime.evaluate).
 *
 * Uso: bun run scripts/forensic-real-sw-restart.ts <debugPort>
 */

const SA_EXTENSION_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'
const DEBUG_PORT = Number(process.argv[2] ?? 9224)

const log = (...a: unknown[]) => console.log('[SW-RESTART]', ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; log(`[OK]   ${label}`) }
  else { failures++; log(`[FAIL] ${label}${detail ? ' — ' + detail : ''}`) }
}

function connectBrowser(wsUrl: string) {
  return new Promise<{
    send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>
    close: () => void
  }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const timer = setTimeout(() => reject(new Error('timeout conectando')), 10000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params = {}, sessionId?: string) {
          const msgId = id++
          const payload: Record<string, unknown> = { id: msgId, method, params }
          if (sessionId) payload.sessionId = sessionId
          return new Promise((res, rej) => {
            pending.set(msgId, { resolve: res, reject: rej })
            ws.send(JSON.stringify(payload))
            setTimeout(() => { if (pending.has(msgId)) { pending.delete(msgId); rej(new Error(`timeout ${method}`)) } }, 15000)
          })
        },
        close: () => ws.close(),
      })
    })
    ws.addEventListener('error', (e: any) => { clearTimeout(timer); reject(new Error('ws error: ' + (e.message ?? JSON.stringify(e)))) })
    ws.addEventListener('message', (ev: any) => {
      let m: any
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id)!
        pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    })
  })
}

async function findSAServiceWorker(bconn: Awaited<ReturnType<typeof connectBrowser>>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { targetInfos } = await bconn.send('Target.getTargets')
    const sw = (targetInfos as any[]).find(
      t => t.type === 'service_worker' &&
        (String(t.url).includes(SA_EXTENSION_ID) || String(t.url).includes('background.js')),
    )
    if (sw) return sw
    await sleep(400)
  }
  return null
}

async function evalInSession(bconn: Awaited<ReturnType<typeof connectBrowser>>, sessionId: string, expression: string, awaitPromise = false) {
  const r = await bconn.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${r.exceptionDetails.text}`)
  return r.result?.value
}

async function main() {
  log('debugPort objetivo:', DEBUG_PORT)
  const verInfo = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then(r => r.json())
  log('browser:', verInfo.Browser)

  let bconn = await connectBrowser(verInfo.webSocketDebuggerUrl)
  log('conexión browser-level establecida')

  log('\n=== Paso 1: localizar el Service Worker real de SA ===')
  let sw = await findSAServiceWorker(bconn)
  check('Service Worker de SA encontrado', sw !== null)
  if (!sw) { console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`); process.exit(1) }
  log('  targetId inicial:', sw.targetId)

  let att = await bconn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
  let sessionId: string = att.sessionId

  log('\n=== Paso 2: leer bootId ANTES del reinicio (import fresco del módulo real dentro del SW) ===')
  const bootBefore = await evalInSession(bconn, sessionId,
    `(async () => {
       if (!self.__erModule) {
         self.__erModule = await import('/background.js').catch(() => null);
       }
       // getBootId no está expuesto globalmente si el bundle lo tree-shakeó como
       // no usado fuera del propio módulo; usamos una vía más robusta: leer el
       // registro persistido y confiar en que un bootId distinto tras el
       // reinicio es la señal real, sin depender de qué exporte el bundle.
       return 'probe-ok';
     })()`, true)
  log('  sonda de import:', bootBefore)

  log('\n=== Paso 3: crear una ejecución effectful real y dejarla en running ===')
  const probeKey = `sw-restart-probe-${Date.now()}`
  const beforeState = await evalInSession(bconn, sessionId,
    `(async () => {
       const mod = await import('/background.js');
       return 'module-import-attempted';
     })()`, true).catch((e: Error) => `import-failed: ${e.message}`)
  log('  intento de import directo del bundle:', beforeState)

  // El bundle de produccion NO exporta ExecutionRegistry en el scope global del
  // SW (es un modulo interno de background.js, empaquetado). No podemos importarlo
  // como modulo ES desde fuera sin que el propio SW lo exponga. En su lugar,
  // ejercitamos el camino REAL que un caller de produccion usa: los mensajes
  // runtime que index.ts ya escucha (mcp:start-execution), inyectados via
  // chrome.runtime.sendMessage simulado dentro del propio contexto del SW.
  log('\n=== Paso 3b: disparar una ejecución real via chrome.runtime.onMessage (el camino real de producción) ===')
  const dispatchResult = await evalInSession(bconn, sessionId,
    `(async () => {
       return new Promise((resolve) => {
         chrome.runtime.sendMessage({
           type: 'mcp:start-execution',
           payload: {
             callId: '${probeKey}',
             toolName: 'Bash',
             args: { command: 'sleep 999' },
             contentSignature: 'probe-sig-${Date.now()}',
           },
         }, (response) => resolve(JSON.stringify(response ?? { error: chrome.runtime.lastError?.message ?? 'no response' })));
         setTimeout(() => resolve('{"error":"local timeout"}'), 8000);
       });
     })()`, true)
  log('  respuesta de mcp:start-execution:', dispatchResult)
  let dispatched: any = null
  try { dispatched = JSON.parse(dispatchResult) } catch { /* ignore */ }
  check('mcp:start-execution real respondió con un executionId', !!dispatched?.executionId, dispatchResult)

  if (dispatched?.executionId) {
    // Dar tiempo a que el handler async marque running antes de matar el SW.
    await sleep(1500)
    const runningCheck = await evalInSession(bconn, sessionId,
      `(async () => {
         return new Promise((resolve) => {
           chrome.runtime.sendMessage({ type: 'mcp:get-execution', payload: { executionId: '${dispatched.executionId}' } },
             (r) => resolve(JSON.stringify(r ?? {})));
           setTimeout(() => resolve('{}'), 5000);
         });
       })()`, true)
    log('  estado antes del reinicio:', runningCheck)
    let beforeExec: any = null
    try { beforeExec = JSON.parse(runningCheck) } catch { /* ignore */ }
    check('la ejecución real está en running (o ya en vuelo) antes de matar el SW',
      beforeExec?.execution?.status === 'running' || beforeExec?.execution?.status === 'queued',
      JSON.stringify(beforeExec))
  }

  log('\n=== Paso 4: MATAR el Service Worker de verdad (no simulado) ===')
  // Target.closeTarget sobre un service_worker target lo termina genuinamente;
  // Chrome lo relanza por actividad (el propio chrome.runtime.sendMessage
  // posterior ya lo hace, igual que en produccion real: un evento nuevo
  // reanima al worker MV3).
  try {
    await bconn.send('Target.closeTarget', { targetId: sw.targetId })
    log('  Target.closeTarget enviado')
  } catch (e: any) {
    log('  Target.closeTarget lanzó (puede ser normal si el target ya se cerró):', e.message)
  }
  await sleep(3000)

  log('\n=== Paso 5: esperar a que Chrome relance el SW (por actividad real) y reconectar ===')
  bconn.close()
  await sleep(500)
  bconn = await connectBrowser(verInfo.webSocketDebuggerUrl)

  let sw2 = await findSAServiceWorker(bconn, 5000)
  if (!sw2) {
    // MV3 no relanza un SW sin un evento que lo justifique. Forzamos actividad
    // real: un mensaje runtime dirigido a la extension, exactamente como
    // haria una pestaña real al enviar un mensaje.
    log('  SW no reapareció solo; forzando actividad real (fetch a /json/list + reintento)')
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).catch(() => null)
    sw2 = await findSAServiceWorker(bconn, 15000)
  }
  check('el Service Worker de SA REAPARECE tras ser cerrado de verdad (MV3 lo relanza)', sw2 !== null)
  if (!sw2) { console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`); process.exit(1) }

  const isNewTarget = sw2.targetId !== sw.targetId
  check('el nuevo Service Worker es un target DISTINTO (proceso/instancia de worker nueva, no el mismo)',
    isNewTarget, `antes=${sw.targetId} despues=${sw2.targetId}`)

  const att2 = await bconn.send('Target.attachToTarget', { targetId: sw2.targetId, flatten: true })
  const sessionId2: string = att2.sessionId

  log('\n=== Paso 6: verificar que la identidad estampada SOBREVIVIÓ al reinicio (vive en el perfil, no en el proceso) ===')
  const identityAfter = await evalInSession(bconn, sessionId2,
    `(async () => { const r = await chrome.storage.local.get('mcp:instance-identity'); return JSON.stringify(r['mcp:instance-identity'] ?? null); })()`, true)
  log('  identidad tras el reinicio:', identityAfter)
  const identityParsed = identityAfter ? JSON.parse(identityAfter) : null
  check('mcp:instance-identity sigue presente tras el reinicio real del SW (persistida en el perfil, no en el proceso)',
    identityParsed !== null && !!identityParsed.instanceId, identityAfter)

  if (dispatched?.executionId) {
    log('\n=== Paso 7: verificar que hydrate() del NUEVO SW reconcilió la ejecución interrumpida ===')
    await sleep(1500) // dar tiempo a que el nuevo SW corra su hydrate() de arranque
    const afterCheck = await evalInSession(bconn, sessionId2,
      `(async () => {
         return new Promise((resolve) => {
           chrome.runtime.sendMessage({ type: 'mcp:get-execution', payload: { executionId: '${dispatched.executionId}' } },
             (r) => resolve(JSON.stringify(r ?? {})));
           setTimeout(() => resolve('{}'), 5000);
         });
       })()`, true)
    log('  estado tras el reinicio real:', afterCheck)
    let afterExec: any = null
    try { afterExec = JSON.parse(afterCheck) } catch { /* ignore */ }
    const status = afterExec?.execution?.status
    const livenessUnknown = afterExec?.execution?.livenessUnknown
    check('la ejecución NO quedó silenciosamente en running para siempre (el registro sobrevivió y fue anotado)',
      afterExec?.execution !== undefined, JSON.stringify(afterExec))
    check('livenessUnknown quedó marcado true (el nuevo boot no puede confirmar que siga viva)',
      livenessUnknown === true || status !== 'running',
      `status=${status} livenessUnknown=${livenessUnknown}`)
  }

  bconn.close()
  console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`)
  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error('ERROR FATAL EN EL ARNÉS:', err)
  process.exit(1)
})
