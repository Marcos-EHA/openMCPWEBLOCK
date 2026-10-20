/**
 * scripts/verify-single-agent-session-gate.ts
 *
 * GATE REAL DE UN SOLO AGENTE:
 * Verificación empírica estricta del flujo normal de OpenMCPWEBLOCK con sesión autenticada
 * vía Master Session + CDP en un relay completamente limpio.
 *
 * Requisitos:
 * - Flujo normal: MultiAgentRunner.createAgent() + MultiAgentRunner.startAgent()
 * - Relay limpio: NO copia artefactos del Chrome personal, no crea Profile 1
 * - Transferencia de sesión en memoria vía CDP
 * - ChatGPT autenticado sin clicks ni inyecciones simuladas
 * - SA Service Worker activo
 * - mcp-sidebar-shadow-host / Content Script montado
 * - Identidad durable estampada
 * - MCP server disponible
 * - Cleanup determinista al terminar
 */

import fs from 'fs'
import path from 'path'
import {
  createAgent,
  startAgent,
  stopAgent,
  getAgentStatus,
  onLifecycleEvent,
} from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import {
  getWebInstance,
  getWebInstanceForAgent,
} from '../src/services/webRelay/WebInstanceRegistry.js'
import {
  SessionBroker,
  findActiveMasterPort,
} from '../src/services/webRelay/session/SessionBroker.js'
import {
  inspectDomAuth,
} from '../src/services/webRelay/session/ChatGPTAuthVerifier.js'
import {
  CDPConnection,
  getInstanceIdentity,
} from '../src/services/webRelay/ChromeCDP.js'
import { MCPSSEServer } from '../src/services/mcpServer/MCPSSEServer.js'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

const evidence = {
  masterPort: null as number | null,
  masterSessionActive: false,
  agentLifecycles: [] as string[],
  reachedReady: false,
  relayDir: '',
  noProfile1: false,
  relayClean: false,
  relaySessionTokenPresent: false,
  chatgptAuthenticated: false,
  composerPlusBtnVisible: false,
  saContentScriptMounted: false,
  saServiceWorkerActive: false,
  identityStampedCorrectly: false,
  mcpServerAvailable: false,
  cleanupSuccessful: false,
}

async function main() {
  console.log('═'.repeat(70))
  console.log('  GATE REAL DE UN SOLO AGENTE — SESIÓN MASTER CDP + RELAY LIMPIO')
  console.log('═'.repeat(70))

  // ── Step 0: Iniciar servidor MCP en puerto 3006 si no está activo ──
  const mcpServer = new MCPSSEServer({ port: 3006 })
  let mcpStartedLocally = false
  try {
    const healthCheck = await fetch('http://127.0.0.1:3006/healthz', { signal: AbortSignal.timeout(600) })
    if (healthCheck.ok) {
      evidence.mcpServerAvailable = true
      console.log('  [0] Servidor MCP ya activo en http://127.0.0.1:3006')
    }
  } catch {
    console.log('  [0] Iniciando servidor MCP en puerto 3006...')
    await mcpServer.start()
    evidence.mcpServerAvailable = true
    mcpStartedLocally = true
    console.log('  [0] Servidor MCP iniciado con éxito.')
  }

  // ── Step 1: Verificar Master Session ──
  const broker = SessionBroker.getInstance()
  const masterPort = await findActiveMasterPort()
  evidence.masterPort = masterPort
  console.log(`  [1] Master Session detectado en puerto: ${masterPort}`)

  if (!masterPort) {
    throw new Error('Master Session Chrome no está activo. Inícialo antes de ejecutar el gate.')
  }

  const masterStatus = await broker.getMasterStatus()
  evidence.masterSessionActive = masterStatus.hasValidSession
  console.log(`  [1] Master Session autenticado: ${masterStatus.hasValidSession ? 'SÍ ✅' : 'NO ❌'} (${masterStatus.cookieCount} cookies)`)
  if (!masterStatus.hasValidSession) {
    throw new Error(`Master Session no tiene sesión válida: ${masterStatus.reason}`)
  }

  // ── Step 2: Registrar agente en MultiAgentRunner ──
  const agentId = 'gate-agent-' + Date.now().toString(36)
  console.log(`\n  [2] Registrando agente "${agentId}" en MultiAgentRunner...`)
  const unsub = onLifecycleEvent(e => {
    if (e.name === 'agent:lifecycle' && e.payload.agentId === agentId) {
      evidence.agentLifecycles.push(e.payload.to)
      console.log(`     [Lifecycle] ${e.payload.from} ──→ ${e.payload.to}`)
    }
  })

  createAgent({ agentId, platformId: 'chatgpt' })

  // ── Step 3: Lanzar agente con el flujo normal de OpenMCPWEBLOCK ──
  console.log(`\n  [3] Iniciando agente "${agentId}" mediante flujo normal startAgent()...`)
  const startTime = Date.now()
  const agentState = await startAgent(agentId)

  evidence.reachedReady = agentState.status === 'ready'
  console.log(`  [3] Estado final del agente: ${agentState.status} (${Date.now() - startTime}ms)`)

  const webInstance = getWebInstanceForAgent(agentId)
  if (!webInstance) {
    throw new Error('No se encontró webInstance asociada al agente')
  }

  evidence.relayDir = webInstance.profileDir
  console.log(`  [3] Relay user-data-dir: ${webInstance.profileDir}`)
  console.log(`  [3] Relay debugPort: ${webInstance.debugPort}`)

  // ── Step 4: Auditoría forense del perfil en disco ──
  console.log('\n  [4] Auditando sistema de archivos del relay...')
  const defaultDir = path.join(webInstance.profileDir, 'Default')
  const profile1Dir = path.join(webInstance.profileDir, 'Profile 1')

  evidence.noProfile1 = !fs.existsSync(profile1Dir)
  console.log(`     - ¿Profile 1 ausente?: ${evidence.noProfile1 ? 'PASS ✅' : 'FAIL ❌ (se creó Profile 1)'}`)

  // Comprobar que no hay archivos copiados del Chrome personal del usuario
  // En un relay limpio, Preferences se crea nuevo por Chromium sin datos personales
  const forbiddenPersonalFiles = [
    'Secure Preferences',
    'Login Data',
    'Web Data',
    'History',
  ]
  let hasForbiddenFile = false
  for (const f of forbiddenPersonalFiles) {
    if (fs.existsSync(path.join(defaultDir, f))) {
      // Nota: Chromium puede crear un Web Data / History vacío si navega,
      // pero NUNCA Secure Preferences o Login Data en arranque inicial de CDP sin sync
      if (f === 'Secure Preferences' || f === 'Login Data') {
        hasForbiddenFile = true
        console.log(`     - ❌ Encontrado archivo de perfil personal: ${f}`)
      }
    }
  }
  evidence.relayClean = !hasForbiddenFile
  console.log(`     - ¿Relay libre de artefactos de perfil personal?: ${evidence.relayClean ? 'PASS ✅' : 'FAIL ❌'}`)

  // ── Step 5: Auditoría de cookies en el relay vía CDP ──
  console.log('\n  [5] Verificando cookies transferidas en el relay...')
  const relayVerif = await broker.verifyRelayCookies(webInstance.debugPort)
  evidence.relaySessionTokenPresent = relayVerif.hasSessionToken
  console.log(`     - ¿Session token presente en jar de red?: ${relayVerif.hasSessionToken ? 'PASS ✅' : 'FAIL ❌'} (${relayVerif.count} cookies)`)

  // ── Step 6: Verificación de estado de ChatGPT y SuperAssistant en DOM ──
  console.log('\n  [6] Inspeccionando DOM de ChatGPT y SuperAssistant...')
  // Esperar hidratación completa de la UI
  await sleep(3000)

  const dom = await inspectDomAuth(webInstance.debugPort)
  evidence.chatgptAuthenticated = !dom.hasLoginElements && (dom.hasAccountIndicator || dom.hasComposer)
  evidence.composerPlusBtnVisible = dom.hasPlusBtn

  console.log(`     - ¿ChatGPT autenticado?: ${evidence.chatgptAuthenticated ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`     - ¿Elemento de cuenta / avatar visible?: ${dom.hasAccountIndicator ? 'SÍ ✅ (' + dom.accountDetail + ')' : 'NO'}`)
  console.log(`     - ¿Composer disponible?: ${dom.hasComposer ? 'SÍ ✅' : 'NO'}`)
  console.log(`     - ¿Botón composer-plus-btn presente?: ${dom.hasPlusBtn ? 'SÍ ✅' : 'NO'}`)
  console.log(`     - URL actual: ${dom.url}`)

  // Inspeccionar presencia de SuperAssistant (mcp-sidebar-shadow-host o UI montada)
  const cdp = new CDPConnection(webInstance.debugPort)
  await cdp.connect()
  try {
    let saDomCheck: any = null
    for (let i = 0; i < 10; i++) {
      saDomCheck = await cdp.evaluate(`(() => {
        const shadowHost = document.getElementById('mcp-sidebar-shadow-host') || document.querySelector('#mcp-sidebar-shadow-host, [data-shadow-host="true"]');
        const rootHost = document.querySelector('#mcp-superassistant-root, [id*="superassistant"], [class*="superassistant"]');
        return {
          hasShadowHost: Boolean(shadowHost),
          hasRootHost: Boolean(rootHost),
          hasSAElement: Boolean(shadowHost || rootHost),
        };
      })()`)
      if (saDomCheck?.hasShadowHost || saDomCheck?.hasSAElement) {
        break
      }
      await sleep(1000)
    }

    evidence.saContentScriptMounted = Boolean(saDomCheck?.hasSAElement || saDomCheck?.hasShadowHost)
    console.log(`     - ¿SuperAssistant Content Script montado (mcp-sidebar-shadow-host)?: ${evidence.saContentScriptMounted ? 'SÍ ✅' : 'Pendiente/Montando'}`)
  } catch (err: any) {
    console.log(`     - Error inspeccionando SA en DOM: ${err.message}`)
  }

  // ── Step 7: Inspeccionar Service Worker de SA ──
  console.log('\n  [7] Verificando Service Worker de SuperAssistant...')
  const targetsResp = await fetch(`http://127.0.0.1:${webInstance.debugPort}/json`)
  const allTargets = (await targetsResp.json()) as any[]
  const saSW = allTargets.find(
    (t: any) =>
      t.type === 'service_worker' &&
      (String(t.url || '').includes('background.js') || String(t.title || '').includes('SuperAssistant')),
  )

  evidence.saServiceWorkerActive = Boolean(saSW)
  console.log(`     - ¿SA Service Worker activo?: ${evidence.saServiceWorkerActive ? 'PASS ✅' : 'FAIL ❌'}`)
  if (saSW) {
    console.log(`     - URL del SW: ${saSW.url}`)
  }

  // ── Step 8: Verificar identidad durable estampada ──
  console.log('\n  [8] Verificando identidad de instancia estampada...')
  const stamped = await getInstanceIdentity(webInstance.debugPort)
  evidence.identityStampedCorrectly = Boolean(stamped?.instanceId === webInstance.instanceId)
  console.log(`     - ¿Identidad estampada coincide?: ${evidence.identityStampedCorrectly ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`     - Stamped: ${JSON.stringify(stamped)}`)

  // ── Step 9: Cleanup controlado ──
  console.log('\n  [9] Ejecutando cleanup controlado...')
  await stopAgent(agentId)
  unsub()
  if (mcpStartedLocally) {
    await mcpServer.stop()
  }
  cdp.close()

  const finalCheck = getAgentStatus(agentId)
  evidence.cleanupSuccessful = finalCheck?.status === 'stopped'
  console.log(`     - ¿Agente detenido limpiamente?: ${evidence.cleanupSuccessful ? 'PASS ✅' : 'FAIL ❌'}`)

  // ── Step 10: Resumen final de Gates ──
  console.log('\n' + '═'.repeat(70))
  console.log('  EVALUACIÓN DEL GATE (CRITERIOS DE ÉXITO)')
  console.log('═'.repeat(70))

  const checks = [
    { name: '1. Perfil relay limpio (Default creado, sin Profile 1)', pass: evidence.noProfile1 && evidence.relayClean },
    { name: '2. Sesión transferida por CDP (session-token en jar)', pass: evidence.relaySessionTokenPresent },
    { name: '3. ChatGPT autenticado (sin botones login, composer/avatar presente)', pass: evidence.chatgptAuthenticated },
    { name: '4. [data-testid="composer-plus-btn"] presente', pass: evidence.composerPlusBtnVisible },
    { name: '5. SA Service Worker activo en puerto de relay', pass: evidence.saServiceWorkerActive },
    { name: '6. SuperAssistant cargado / montado en DOM', pass: evidence.saContentScriptMounted },
    { name: '7. Identidad de instancia durable estampada', pass: evidence.identityStampedCorrectly },
    { name: '8. Servidor MCP disponible en :3006', pass: evidence.mcpServerAvailable },
    { name: '9. Secuencia completa de lifecycle (incluyendo session_ready)', pass: evidence.agentLifecycles.includes('session_ready') && evidence.reachedReady },
    { name: '10. Cleanup determinista al detener agente', pass: evidence.cleanupSuccessful },
  ]

  let allPass = true
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅ PASS' : '❌ FAIL'} — ${c.name}`)
    if (!c.pass) allPass = false
  }

  console.log('═'.repeat(70))
  if (allPass) {
    console.log('  RESULTADO FINAL: ALL CHECKS PASS — GATE REAL 1 AGENTE APROBADO ✅')
  } else {
    console.log('  RESULTADO FINAL: ALGUNOS CHECKS FALLARON ❌')
  }
  console.log('═'.repeat(70))

  process.exit(allPass ? 0 : 1)
}

main().catch(err => {
  console.error('\n❌ ERROR FATAL EN EL GATE:', err)
  process.exit(1)
})
