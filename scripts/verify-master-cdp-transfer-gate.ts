/**
 * scripts/verify-master-cdp-transfer-gate.ts
 *
 * GATE OBLIGATORIO: Prueba E2E de propagación de sesión vía CDP:
 * OPENMCPWEBLOCK MANAGED MASTER -> CDP getCookies -> NUEVO RELAY AISLADO -> CDP setCookies -> CHATGPT AUTENTICADO
 *
 * Restricciones estrictas:
 * - NO taskkill /IM chrome.exe
 * - NO modificar src/
 * - NO escribir jamás valores de cookies en logs, consola o informe
 * - Todo valor secreto permanece exclusivamente en memoria
 */

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'

const MASTER_PORT = 9227
const RELAY_A_PORT = 9228
const RELAY_B_PORT = 9229

const MASTER_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'master-session')
const RELAY_A_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-agents', 'test-cdp-session-transfer')
const RELAY_B_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-agents', 'test-cdp-session-transfer-B')

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

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

async function sendCdpCommand(wsUrl: string, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const reqId = Math.floor(Math.random() * 1000000)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP timeout calling ${method}`))
    }, 20000)

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: reqId, method, params }))
    })

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === reqId) {
          clearTimeout(timer)
          ws.close()
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
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

async function getPageWsUrl(port: number, urlFilter: string = 'chatgpt.com'): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/json`)
  const targets = (await resp.json()) as any[]
  const target = targets.find(t => t.type === 'page' && (!urlFilter || t.url?.includes(urlFilter)))
  if (!target?.webSocketDebuggerUrl) {
    // If not found by filter, get the first page target
    const firstPage = targets.find(t => t.type === 'page')
    if (firstPage?.webSocketDebuggerUrl) return firstPage.webSocketDebuggerUrl
    throw new Error(`Target de página no encontrado en http://127.0.0.1:${port}/json`)
  }
  return target.webSocketDebuggerUrl
}

async function launchInstance(userDataDir: string, debugPort: number, initialUrl: string = 'about:blank') {
  try {
    const check = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(400) })
    if (check.ok) {
      console.log(`  Puerto ${debugPort} ya está activo. Reutilizando instancia existente...`)
      return await findPidOnPort(debugPort)
    }
  } catch {}

  await killPortIfActive(debugPort)
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true })

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--new-window',
    initialUrl,
  ]

  const proc = spawn(CHROME_PATH, args, {
    detached: true,
    stdio: 'ignore',
  })
  proc.unref()

  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      if (res.ok) return proc.pid || (await findPidOnPort(debugPort))
    } catch {}
  }
  throw new Error(`Chrome no respondió en el puerto ${debugPort}`)
}

async function checkDomAuth(pageWs: string) {
  const result = await sendCdpCommand(pageWs, 'Runtime.evaluate', {
    expression: `(() => {
      const allButtons = Array.from(document.querySelectorAll('button, a'));
      const hasLoginBtn = Boolean(document.querySelector('button[data-testid="login-button"], a[href*="/auth/login"]')) ||
        allButtons.some(b => (b.textContent || '').trim().toLowerCase() === 'log in' || (b.textContent || '').trim().toLowerCase() === 'iniciar sesión');
      const hasSignupBtn = Boolean(document.querySelector('button[data-testid="signup-button"], a[href*="/auth/signup"]')) ||
        allButtons.some(b => (b.textContent || '').trim().toLowerCase() === 'sign up' || (b.textContent || '').trim().toLowerCase() === 'registrarse');
      const plusBtn = document.querySelector('[data-testid="composer-plus-btn"]');
      const textarea = document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]');
      const leadingArea = document.querySelector('[grid-area="leading"]');
      const userMenu = document.querySelector('[data-testid="user-menu-button"], [data-testid="profile-button"], [aria-label*="User profile"], [aria-label*="Cuenta"], [aria-label*="Perfil"]');
      const title = document.title;
      const url = window.location.href;

      return {
        url,
        title,
        hasLoginBtn,
        hasSignupBtn,
        hasUserMenu: Boolean(userMenu),
        userMenuLabel: userMenu ? (userMenu.getAttribute('aria-label') || userMenu.textContent?.trim().slice(0, 30)) : null,
        hasPlusBtn: Boolean(plusBtn),
        plusVisible: plusBtn ? (window.getComputedStyle(plusBtn).display !== 'none') : false,
        hasTextarea: Boolean(textarea),
        hasLeadingArea: Boolean(leadingArea),
      };
    })()`,
    returnByValue: true,
  })
  return result?.result?.value
}

// Memory-only cookie holder
let memoryCookies: any[] = []

const results: Record<string, boolean> = {
  masterAuth: false,
  masterGetCookies: false,
  relaySetCookies: false,
  relayCookiesVisible: false,
  relayAuth: false,
  relayPlusBtn: false,
  relayPersistRestart: false,
  relayPersistReload: false,
  relayBSeparate: false,
  isolationMaintained: false,
}

async function main() {
  console.log('═'.repeat(70))
  console.log('  GATE DE PROPAGACIÓN DE SESIÓN VÍA CDP (OPENMCPWEBLOCK MANAGED MASTER)')
  console.log('═'.repeat(70))

  // ─────────────────────────────────────────────────────────────────
  // FASE 1: CREAR / USAR MASTER SESSION
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 1] Verificando Master Session en %LOCALAPPDATA%\\openMCPWEBLOCK\\master-session...')
  console.log(`  Esperando que Master Chrome esté activo en puerto ${MASTER_PORT}...`)
  console.log('  (Si la ventana no se abre automáticamente, haz doble click en "Master-ChatGPT.bat" en tu Escritorio)')

  let masterPid = await findPidOnPort(MASTER_PORT)
  if (!masterPid) {
    try {
      masterPid = await launchInstance(MASTER_DIR, MASTER_PORT, 'https://chatgpt.com/')
    } catch {}
  }

  const startPortWait = Date.now()
  while (!(await findPidOnPort(MASTER_PORT))) {
    if (Date.now() - startPortWait > 300000) throw new Error('Timeout esperando inicio de Master Chrome en puerto ' + MASTER_PORT)
    await sleep(2000)
    process.stdout.write('.')
  }

  masterPid = await findPidOnPort(MASTER_PORT)
  console.log(`\n  Master Chrome activo en puerto ${MASTER_PORT} (PID: ${masterPid})`)

  let masterWs = await getPageWsUrl(MASTER_PORT, 'chatgpt.com')
  console.log('  Esperando estado inicial de ChatGPT en Master Session...')
  await sleep(4000)

  let masterDom = await checkDomAuth(masterWs)
  console.log('  Estado inicial Master DOM:', masterDom)

  if (!masterDom.hasPlusBtn || masterDom.hasLoginBtn) {
    console.log('\n  ⚠️ MASTER NO ESTÁ AUTENTICADO.')
    console.log('  👉 POR FAVOR INICIA SESIÓN EN LA VENTANA DE CHATGPT QUE SE ACABA DE ABRIR.')
    console.log('  Esperando login del usuario (polling cada 3s)...')

    const maxWaitSec = 600
    const startWait = Date.now()
    while (Date.now() - startWait < maxWaitSec * 1000) {
      await sleep(3000)
      try {
        masterWs = await getPageWsUrl(MASTER_PORT, 'chatgpt.com')
        masterDom = await checkDomAuth(masterWs)
        if (masterDom.hasPlusBtn && !masterDom.hasLoginBtn) {
          console.log('\n  🎉 ¡LOGIN DETECTADO EN MASTER!')
          break
        }
        process.stdout.write('.')
      } catch {
        // Page might be navigating during auth
      }
    }
  }

  // Comprobar condiciones de Phase 1
  results.masterAuth = Boolean(masterDom.hasPlusBtn && !masterDom.hasLoginBtn && masterDom.hasTextarea)
  console.log(`\n  Veredicto Fase 1: masterAuth = ${results.masterAuth ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log('  Detalles Master:', {
    hasPlusBtn: masterDom.hasPlusBtn,
    hasLoginBtn: masterDom.hasLoginBtn,
    hasTextarea: masterDom.hasTextarea,
    hasUserMenu: masterDom.hasUserMenu,
    userMenuLabel: masterDom.userMenuLabel,
  })

  if (!results.masterAuth) {
    throw new Error('Fase 1 falló: El Master no quedó autenticado. No se puede proceder.')
  }

  // ─────────────────────────────────────────────────────────────────
  // FASE 2: OBTENER COOKIES DEL MASTER POR CDP
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 2] Obteniendo cookies del Master vía CDP (Network.getCookies)...')
  await sendCdpCommand(masterWs, 'Network.enable')
  const masterCookiesResult = await sendCdpCommand(masterWs, 'Network.getCookies', {
    urls: ['https://chatgpt.com', 'https://openai.com', 'https://auth.openai.com'],
  })

  const rawCookies: any[] = masterCookiesResult?.cookies || []
  console.log(`  CDP devolvió ${rawCookies.length} cookies desde el Master.`)

  // Guardar en memoria (NUNCA exponer 'value' en consola ni disco)
  memoryCookies = rawCookies.map(c => ({ ...c }))

  const cookieMeta = memoryCookies.map(c => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite || 'None',
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'Session',
    partitionKey: c.partitionKey ? 'Present' : 'None',
  }))

  console.log('  Muestra de Metadatos de Cookies obtenidas:')
  for (const m of cookieMeta.slice(0, 15)) {
    console.log(`    - ${m.name} | ${m.domain} | path: ${m.path} | sec: ${m.secure} | http: ${m.httpOnly} | sSite: ${m.sameSite} | exp: ${m.expires}`)
  }

  results.masterGetCookies = memoryCookies.length > 0 && memoryCookies.some(c => c.name.includes('session-token'))
  console.log(`  Veredicto Fase 2: masterGetCookies = ${results.masterGetCookies ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // FASE 3: CREAR RELAY LIMPIO (RELAY A)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 3] Creando Relay Limpio A en puerto ' + RELAY_A_PORT + '...')
  if (fs.existsSync(RELAY_A_DIR)) {
    fs.rmSync(RELAY_A_DIR, { recursive: true, force: true })
  }
  const relayAPid = await launchInstance(RELAY_A_DIR, RELAY_A_PORT, 'about:blank')
  console.log(`  Relay A Chrome corriendo en puerto ${RELAY_A_PORT} (PID: ${relayAPid})`)
  let relayAWs = await getPageWsUrl(RELAY_A_PORT, '')

  // ─────────────────────────────────────────────────────────────────
  // FASE 4: TRANSFERENCIA REAL POR CDP (Network.setCookies)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 4] Transfiriendo cookies en memoria hacia Relay A vía Network.setCookies...')
  await sendCdpCommand(relayAWs, 'Network.enable')

  // Formatear cookies para CDP Network.setCookies
  const cookiesToSet = memoryCookies.map(c => {
    const p: any = {
      name: c.name,
      value: c.value, // Valor en memoria exclusivamente
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
    }
    if (c.sameSite) p.sameSite = c.sameSite
    if (c.expires && c.expires > 0) p.expires = c.expires
    if (c.priority) p.priority = c.priority
    if (c.partitionKey) p.partitionKey = c.partitionKey
    return p
  })

  let setCookiesSuccess = false
  try {
    await sendCdpCommand(relayAWs, 'Network.setCookies', { cookies: cookiesToSet })
    setCookiesSuccess = true
  } catch (err: any) {
    console.error('  Error en Network.setCookies:', err.message)
  }
  results.relaySetCookies = setCookiesSuccess
  console.log(`  Network.setCookies ejecutado: ${setCookiesSuccess ? 'PASS ✅' : 'FAIL ❌'}`)

  // Consultar en Relay A
  const relayACookiesResult = await sendCdpCommand(relayAWs, 'Network.getCookies', {
    urls: ['https://chatgpt.com', 'https://openai.com', 'https://auth.openai.com'],
  })
  const relayACookies: any[] = relayACookiesResult?.cookies || []
  console.log(`  Relay A ahora contiene ${relayACookies.length} cookies verificadas vía CDP.`)

  results.relayCookiesVisible = relayACookies.length >= memoryCookies.length * 0.8
  console.log(`  Veredicto Fase 4: relayCookiesVisible = ${results.relayCookiesVisible ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // FASE 5: PRUEBA REAL DE CHATGPT EN RELAY A
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 5] Navegando Relay A a https://chatgpt.com/ con sesión inyectada...')
  await sendCdpCommand(relayAWs, 'Page.navigate', { url: 'https://chatgpt.com/' })

  console.log('  Esperando 12s para hidratación completa del DOM en Relay A...')
  await sleep(12000)

  relayAWs = await getPageWsUrl(RELAY_A_PORT, 'chatgpt.com')
  const relayADom = await checkDomAuth(relayAWs)
  console.log('  Estado DOM en Relay A tras transferencia:')
  console.log(`    - URL: ${relayADom.url}`)
  console.log(`    - Title: ${relayADom.title}`)
  console.log(`    - hasLoginBtn: ${relayADom.hasLoginBtn}`)
  console.log(`    - hasSignupBtn: ${relayADom.hasSignupBtn}`)
  console.log(`    - hasUserMenu: ${relayADom.hasUserMenu} (${relayADom.userMenuLabel || 'N/A'})`)
  console.log(`    - hasPlusBtn: ${relayADom.hasPlusBtn} (visible: ${relayADom.plusVisible})`)
  console.log(`    - hasTextarea: ${relayADom.hasTextarea}`)
  console.log(`    - hasLeadingArea: ${relayADom.hasLeadingArea}`)

  results.relayAuth = Boolean(!relayADom.hasLoginBtn && (relayADom.hasUserMenu || relayADom.hasPlusBtn))
  results.relayPlusBtn = Boolean(relayADom.hasPlusBtn && relayADom.hasTextarea)
  console.log(`  Veredicto Fase 5: relayAuth = ${results.relayAuth ? 'PASS ✅' : 'FAIL ❌'}, relayPlusBtn = ${results.relayPlusBtn ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // FASE 6: PRUEBA DE PERSISTENCIA (REINICIAR SOLO RELAY A)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 6] Probando persistencia: Reiniciando Relay A sin reinyectar cookies...')
  await killPortIfActive(RELAY_A_PORT)
  await sleep(1500)

  // Reabrir el mismo directorio sin setCookies
  const relayARestartPid = await launchInstance(RELAY_A_DIR, RELAY_A_PORT, 'https://chatgpt.com/')
  console.log(`  Relay A reiniciado en puerto ${RELAY_A_PORT} (PID: ${relayARestartPid})`)
  await sleep(10000)

  relayAWs = await getPageWsUrl(RELAY_A_PORT, 'chatgpt.com')
  const relayAPersistDom = await checkDomAuth(relayAWs)
  console.log('  Estado DOM en Relay A tras reinicio:')
  console.log(`    - hasLoginBtn: ${relayAPersistDom.hasLoginBtn}`)
  console.log(`    - hasPlusBtn: ${relayAPersistDom.hasPlusBtn}`)
  console.log(`    - hasTextarea: ${relayAPersistDom.hasTextarea}`)

  results.relayPersistRestart = Boolean(!relayAPersistDom.hasLoginBtn && relayAPersistDom.hasPlusBtn)
  console.log(`  Veredicto Fase 6: relayPersistRestart = ${results.relayPersistRestart ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // FASE 7: PRUEBA DE RECARGA EN RELAY A
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 7] Probando recarga (Page.reload) en Relay A...')
  await sendCdpCommand(relayAWs, 'Page.reload', { ignoreCache: false })
  await sleep(8000)

  relayAWs = await getPageWsUrl(RELAY_A_PORT, 'chatgpt.com')
  const relayAReloadDom = await checkDomAuth(relayAWs)
  console.log('  Estado DOM en Relay A tras reload:')
  console.log(`    - hasLoginBtn: ${relayAReloadDom.hasLoginBtn}`)
  console.log(`    - hasPlusBtn: ${relayAReloadDom.hasPlusBtn}`)
  console.log(`    - hasTextarea: ${relayAReloadDom.hasTextarea}`)

  results.relayPersistReload = Boolean(!relayAReloadDom.hasLoginBtn && relayAReloadDom.hasPlusBtn)
  console.log(`  Veredicto Fase 7: relayPersistReload = ${results.relayPersistReload ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // FASE 8: PRUEBA DE SEPARACIÓN (RELAY B)
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[FASE 8] Probando aislamiento con segundo Relay B en puerto ' + RELAY_B_PORT + '...')
  if (fs.existsSync(RELAY_B_DIR)) {
    fs.rmSync(RELAY_B_DIR, { recursive: true, force: true })
  }
  const relayBPid = await launchInstance(RELAY_B_DIR, RELAY_B_PORT, 'https://chatgpt.com/')
  console.log(`  Relay B Chrome corriendo en puerto ${RELAY_B_PORT} (PID: ${relayBPid})`)
  await sleep(6000)

  let relayBWs = await getPageWsUrl(RELAY_B_PORT, 'chatgpt.com')
  const relayBInitialDom = await checkDomAuth(relayBWs)
  console.log('  Relay B inicial (sin cookies transferidas):')
  console.log(`    - hasLoginBtn: ${relayBInitialDom.hasLoginBtn}`)
  console.log(`    - hasPlusBtn: ${relayBInitialDom.hasPlusBtn}`)

  const bInitiallyUnauthed = relayBInitialDom.hasLoginBtn || !relayBInitialDom.hasPlusBtn
  console.log(`  Relay B empezó desautenticado de forma aislada: ${bInitiallyUnauthed ? 'SÍ ✅' : 'NO ❌'}`)

  // Inyectar sesión a B vía CDP
  console.log('  Inyectando sesión a Relay B vía Network.setCookies...')
  await sendCdpCommand(relayBWs, 'Network.enable')
  await sendCdpCommand(relayBWs, 'Network.setCookies', { cookies: cookiesToSet })
  await sendCdpCommand(relayBWs, 'Page.navigate', { url: 'https://chatgpt.com/' })
  await sleep(10000)

  relayBWs = await getPageWsUrl(RELAY_B_PORT, 'chatgpt.com')
  const relayBAfterDom = await checkDomAuth(relayBWs)
  console.log('  Relay B tras inyección de cookies:')
  console.log(`    - hasLoginBtn: ${relayBAfterDom.hasLoginBtn}`)
  console.log(`    - hasPlusBtn: ${relayBAfterDom.hasPlusBtn}`)

  const bAuthed = Boolean(!relayBAfterDom.hasLoginBtn && relayBAfterDom.hasPlusBtn)
  results.relayBSeparate = bInitiallyUnauthed && bAuthed

  // Verificar que Relay A sigue autenticado y vivo
  const relayAStillDom = await checkDomAuth(relayAWs)
  const aStillAuthed = Boolean(!relayAStillDom.hasLoginBtn && relayAStillDom.hasPlusBtn)
  console.log(`  Relay A sigue autenticado simultáneamente: ${aStillAuthed ? 'SÍ ✅' : 'NO ❌'}`)

  // Detener A y verificar que B no se ve afectado
  console.log('  Deteniendo Relay A para verificar no interferencia...')
  await killPortIfActive(RELAY_A_PORT)
  await sleep(1000)

  const relayBFinalDom = await checkDomAuth(relayBWs)
  const bStillAuthedAfterAStopped = Boolean(!relayBFinalDom.hasLoginBtn && relayBFinalDom.hasPlusBtn)
  console.log(`  Relay B sigue vivo y autenticado tras detener A: ${bStillAuthedAfterAStopped ? 'SÍ ✅' : 'NO ❌'}`)

  results.isolationMaintained = bAuthed && aStillAuthed && bStillAuthedAfterAStopped
  console.log(`  Veredicto Fase 8: relayBSeparate = ${results.relayBSeparate ? 'PASS ✅' : 'FAIL ❌'}, isolation = ${results.isolationMaintained ? 'PASS ✅' : 'FAIL ❌'}`)

  // ─────────────────────────────────────────────────────────────────
  // LIMPIEZA DE RELAYS DE PRUEBA
  // ─────────────────────────────────────────────────────────────────
  console.log('\n[LIMPIEZA] Cerrando relays experimentales A y B...')
  await killPortIfActive(RELAY_A_PORT)
  await killPortIfActive(RELAY_B_PORT)
  if (fs.existsSync(RELAY_A_DIR)) fs.rmSync(RELAY_A_DIR, { recursive: true, force: true })
  if (fs.existsSync(RELAY_B_DIR)) fs.rmSync(RELAY_B_DIR, { recursive: true, force: true })
  console.log('  Relays experimentales cerrados y eliminados. Master Session permanece preservada.')

  // ─────────────────────────────────────────────────────────────────
  // FASE 9: INFORME RESUMEN
  // ─────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70))
  console.log('  RESUMEN DE VEREDICTOS GATE (10 CHECKS OBLIGATORIOS)')
  console.log('═'.repeat(70))
  console.log(`  1. MASTER autenticado por login real:         ${results.masterAuth ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  2. Network.getCookies en MASTER:              ${results.masterGetCookies ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  3. Network.setCookies en RELAY:               ${results.relaySetCookies ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  4. Cookies visibles después en RELAY:         ${results.relayCookiesVisible ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  5. ChatGPT autenticado en RELAY:              ${results.relayAuth ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  6. composer-plus-btn en RELAY:                ${results.relayPlusBtn ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  7. Autenticación tras reinicio de RELAY:      ${results.relayPersistRestart ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  8. Autenticación tras reload de RELAY:        ${results.relayPersistReload ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(`  9. Segundo RELAY recibe sesión separada:      ${results.relayBSeparate ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log(` 10. A y B permanecen completamente aislados:   ${results.isolationMaintained ? 'PASS ✅' : 'FAIL ❌'}`)
  console.log('═'.repeat(70))
}

main().catch(err => {
  console.error('\n❌ ERROR FATAL EN PRUEBA GATE:', err)
  process.exit(1)
})
