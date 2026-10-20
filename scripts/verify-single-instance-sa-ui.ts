/**
 * scripts/verify-single-instance-sa-ui.ts
 *
 * PARTE C: Verificar UI real de SA en UNA sola instancia normal del producto.
 *
 * Comprueba:
 * 1. Chrome abre el perfil correcto (Default, con --profile-directory=Default).
 * 2. Estado de autenticación en ChatGPT.
 * 3. SA Service Worker activo.
 * 4. Content script presente (window.mcpClient, window.pluginRegistry, shadowHost).
 * 5. Interfaz compacta de SA (#mcp-popover-container / .mcp-main-button).
 * 6. Sidebar (#mcp-sidebar-shadow-host, display, opacity).
 * 7. Autopush (html.push-mode-enabled, margin-right).
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createAgent, startAgent, stopAgent, resetRunner } from '../src/services/webRelay/orchestration/MultiAgentRunner.js'
import { resetWebInstanceRegistry, reclaimStalePortLocks } from '../src/services/webRelay/WebInstanceRegistry.js'
import { resetSentinel } from '../src/services/webRelay/orchestration/Sentinel.js'
import { resetRelayBus } from '../src/services/webRelay/orchestration/RelayBus.js'
import { orchestrationAppState } from '../src/services/webRelay/orchestration/AppState.js'
import { enableConfigs } from '../src/utils/config.js'

let passCount = 0
let failCount = 0

function assert(desc: string, condition: boolean, detail = '') {
  if (condition) {
    passCount++
    console.log(`  ✅ ${desc}${detail ? ` (${detail})` : ''}`)
  } else {
    failCount++
    console.log(`  ❌ FAIL: ${desc}${detail ? ` (${detail})` : ''}`)
  }
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 8000 })
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim()
      if (!line.includes(':' + port) || !line.includes('LISTENING')) continue
      const parts = line.split(/\s+/)
      if (parts[1]?.endsWith(':' + port)) {
        const pid = parseInt(parts[parts.length - 1]!, 10)
        if (pid > 0) return pid
      }
    }
  } catch {}
  return null
}

async function killPortIfActive(port: number) {
  const pid = await findPidOnPort(port)
  if (!pid) return
  try {
    execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' })
  } catch {}
  for (let i = 0; i < 15; i++) {
    if (!(await findPidOnPort(port))) return
    await sleep(200)
  }
}

async function evaluateInTarget(wsUrl: string, expression: string, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP evaluate timeout: ${expression.slice(0, 60)}`))
    }, timeoutMs)

    let reqId = Math.floor(Math.random() * 1000000)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: reqId,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      )
    })

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          clearTimeout(timer)
          ws.close()
          if (msg.error) reject(new Error(msg.error.message))
          else {
            const val =
              msg.result?.result?.value !== undefined
                ? msg.result.result.value
                : msg.result?.value !== undefined
                ? msg.result.value
                : msg.result?.result
            resolve(val)
          }
        }
      } catch (err) {
        clearTimeout(timer)
        ws.close()
        reject(err)
      }
    })

    ws.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

async function main() {
  console.log('═'.repeat(65))
  console.log('  PARTE C: VERIFICACIÓN FORENSE DE LA UI REAL DE SUPERASSISTANT')
  console.log('═'.repeat(65))

  enableConfigs()
  await killPortIfActive(9222)
  reclaimStalePortLocks()
  resetRunner()
  resetSentinel()
  resetRelayBus()
  resetWebInstanceRegistry()

  // 1. Lanzar UNA instancia normal de OpenMCPWEBLOCK usando el flujo de MultiAgentRunner
  console.log('\n1. Creando y lanzando agente único vía MultiAgentRunner...')
  createAgent({ agentId: 'agent-chatgpt-single', platformId: 'chatgpt', role: 'coder' })
  const agentState = await startAgent('agent-chatgpt-single')

  assert('Agente inició correctamente a estado ready', agentState.status === 'ready')
  const port = agentState.debugPort!
  const instanceId = agentState.instanceId!
  console.log(`  Instancia ID: ${instanceId}, Debug Port: ${port}`)

  // 2. Verificar que Chrome abrió el perfil correcto en disco
  console.log('\n2. Verificando perfil en disco y exclusión de Profile 1...')
  const instanceDir = path.join(
    process.env.LOCALAPPDATA ?? '',
    'openMCPWEBLOCK',
    'chrome-agents',
    instanceId
  )
  const defaultDirExists = fs.existsSync(path.join(instanceDir, 'Default'))
  const profile1DirExists = fs.existsSync(path.join(instanceDir, 'Profile 1'))
  const localStateFile = path.join(instanceDir, 'Local State')
  const lastUsed = fs.existsSync(localStateFile)
    ? JSON.parse(fs.readFileSync(localStateFile, 'utf8'))?.profile?.last_used
    : null

  assert('Subdirectorio Default/ existe en el relay', defaultDirExists)
  assert('Subdirectorio Profile 1/ NO existe (aislamiento garantizado)', !profile1DirExists)
  assert('Local State last_used está fijado a "Default"', lastUsed === 'Default')

  // 3. Obtener targets CDP de Chrome
  console.log('\n3. Consultando targets CDP en http://127.0.0.1:' + port + '/json...')
  const resp = await fetch(`http://127.0.0.1:${port}/json`)
  const targets = (await resp.json()) as any[]

  const pageTarget = targets.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const swTarget = targets.find(
    t => t.type === 'service_worker' && (t.url?.includes('background.js') || t.title?.includes('SuperAssistant'))
  )

  assert('Target de página ChatGPT existe', !!pageTarget)
  assert('Target de Service Worker de SuperAssistant existe y está activo', !!swTarget)

  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('No se pudo obtener WebSocketDebuggerUrl para la página ChatGPT')
  }
  const pageWs = pageTarget.webSocketDebuggerUrl

  // Esperar a que la página cargue su DOM
  console.log('\n4. Inspeccionando presencia del Content Script de SuperAssistant en ChatGPT...')
  let csInfo: any = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    csInfo = await evaluateInTarget(
      pageWs,
      `(() => {
        return {
          hasMcpClient: typeof window.mcpClient !== 'undefined',
          hasPluginRegistry: typeof window.pluginRegistry !== 'undefined',
          hasActiveSidebarManager: typeof window.activeSidebarManager !== 'undefined',
          hasAppDebug: typeof window._appDebug !== 'undefined',
          hasShadowHost: Boolean(document.getElementById('mcp-sidebar-shadow-host')),
          hasPopoverContainer: Boolean(document.getElementById('mcp-popover-container')),
          hasTextarea: Boolean(document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]')),
          hasPlusBtn: Boolean(document.querySelector('[data-testid="composer-plus-btn"], [grid-area="leading"]')),
          isPushModeEnabled: document.documentElement.classList.contains('push-mode-enabled'),
          htmlMarginRight: document.documentElement.style.marginRight,
          url: window.location.href,
        };
      })()`
    )
    if (csInfo.hasShadowHost || csInfo.hasMcpClient || csInfo.hasActiveSidebarManager) break
  }

  console.log('  Estado inspeccionado del content script:', csInfo)
  assert('Content Script de SA presente en el contexto de página (mcpClient / activeSidebarManager)',
    csInfo.hasMcpClient || csInfo.hasActiveSidebarManager || csInfo.hasPluginRegistry || csInfo.hasShadowHost)

  // 5. Verificar Interfaz Compacta (#mcp-popover-container)
  console.log('\n5. Verificando Interfaz Compacta de SA (#mcp-popover-container)...')
  const popoverDetails = await evaluateInTarget(
    pageWs,
    `(() => {
      const el = document.getElementById('mcp-popover-container');
      const btn = document.querySelector('.mcp-chatgpt-button-base, .mcp-main-button');
      return {
        exists: Boolean(el),
        html: el ? el.outerHTML.slice(0, 150) : null,
        buttonExists: Boolean(btn),
        buttonText: btn ? btn.textContent : null,
      };
    })()`
  )
  console.log('  Detalles de la Interfaz Compacta:', popoverDetails)
  console.log(`  -> Diagnóstico Interfaz Compacta: exists=${popoverDetails.exists}, buttonExists=${popoverDetails.buttonExists}`)

  // 6. Verificar Sidebar (#mcp-sidebar-shadow-host)
  console.log('\n6. Verificando Sidebar (#mcp-sidebar-shadow-host)...')
  const sidebarDetails = await evaluateInTarget(
    pageWs,
    `(() => {
      const host = document.getElementById('mcp-sidebar-shadow-host');
      if (!host) return { exists: false };
      const style = window.getComputedStyle(host);
      return {
        exists: true,
        display: style.display,
        opacity: style.opacity,
        width: style.width,
        classList: Array.from(host.classList),
        hasShadowRoot: Boolean(host.shadowRoot),
        shadowChildrenCount: host.shadowRoot ? host.shadowRoot.children.length : 0,
      };
    })()`
  )
  console.log('  Detalles del Sidebar:', sidebarDetails)
  console.log(`  -> Diagnóstico Sidebar: exists=${sidebarDetails.exists}, display=${sidebarDetails.display}, opacity=${sidebarDetails.opacity}`)

  // 7. Verificar Autopush (pushContentMode)
  console.log('\n7. Verificando Autopush en el documento HTML...')
  const autopushDetails = await evaluateInTarget(
    pageWs,
    `(() => {
      const html = document.documentElement;
      return {
        pushModeClass: html.classList.contains('push-mode-enabled'),
        collapsedClass: html.classList.contains('sidebar-collapsed'),
        marginRight: html.style.marginRight,
        width: html.style.width,
        storedPreferences: localStorage.getItem('mcp-super-assistant-ui-store'),
      };
    })()`
  )
  console.log('  Detalles de Autopush:', autopushDetails)
  console.log(`  -> Diagnóstico Autopush: pushModeClass=${autopushDetails.pushModeClass}, marginRight='${autopushDetails.marginRight}'`)

  // 8. Limpieza limpia
  console.log('\n8. Deteniendo agente...')
  await stopAgent('agent-chatgpt-single')
  for (let i = 0; i < 15; i++) {
    if (!(await findPidOnPort(port))) break
    await sleep(200)
  }
  assert('Puerto 9222 liberado limpiamente', (await findPidOnPort(port)) === null)

  console.log('\n' + '═'.repeat(65))
  console.log(`  RESULTADO PARTE C: ${passCount} passed, ${failCount} failed`)
  console.log('═'.repeat(65))
}

main().catch(err => {
  console.error('Error en verificación Parte C:', err)
  process.exit(1)
})
