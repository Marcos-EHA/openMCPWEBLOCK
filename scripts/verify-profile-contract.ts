/**
 * scripts/verify-profile-contract.ts
 *
 * MANDATORY INFRASTRUCTURE TEST (PART A):
 * Demuestra con un relay limpio donde:
 *   Local State.last_used = Profile 1
 *   relay sólo contiene Default/
 * que Chrome abre:
 *   Default
 * y NO crea/usa Profile 1.
 *
 * Verifica:
 *   - Profile 1 no creado en disco
 *   - Default usado exclusivamente
 *   - SA cargada y activa
 *   - Sesión/cookies esperadas en ChatGPT
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { launchChrome, isDebugPortActive } from '../src/services/webRelay/ChromeCDP.js'

const DEBUG_PORT = 9225
const INSTANCE_ID = 'verify-profile-contract'
const RELAY_DIR = path.join(
  process.env.LOCALAPPDATA ?? '',
  'openMCPWEBLOCK',
  'chrome-agents',
  INSTANCE_ID
)
const CHROME_USER_DATA = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Google',
  'Chrome',
  'User Data'
)

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

async function getCookiesViaCDP(wsUrl: string, urls: string[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('CDP Network.getCookies timeout'))
    }, 10000)

    let reqId = Math.floor(Math.random() * 1000000)
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: reqId,
          method: 'Network.getCookies',
          params: { urls },
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
          else resolve(msg.result?.cookies || [])
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
  console.log('  TEST OBLIGATORIO: VERIFICACIÓN DEL CONTRATO DE PERFIL RELAY')
  console.log('═'.repeat(65))

  await killPortIfActive(DEBUG_PORT)

  // 1. Preparar un relay limpio
  console.log(`\n1. Preparando directorio relay limpio: ${RELAY_DIR}`)
  if (fs.existsSync(RELAY_DIR)) {
    try {
      fs.rmSync(RELAY_DIR, { recursive: true, force: true })
    } catch {}
  }
  fs.mkdirSync(path.join(RELAY_DIR, 'Default'), { recursive: true })

  // 2. Inyectar condición de estrés: Local State con last_used = "Profile 1"
  console.log('2. Configurando condición de estrés: Local State con last_used = "Profile 1"')
  const srcLocalState = path.join(CHROME_USER_DATA, 'Local State')
  const dstLocalState = path.join(RELAY_DIR, 'Local State')
  if (fs.existsSync(srcLocalState)) {
    fs.copyFileSync(srcLocalState, dstLocalState)
    const raw = fs.readFileSync(dstLocalState, 'utf8')
    const ls = JSON.parse(raw)
    if (!ls.profile) ls.profile = {}
    ls.profile.last_used = 'Profile 1'
    ls.profile.last_active_profiles = ['Profile 1']
    fs.writeFileSync(dstLocalState, JSON.stringify(ls, null, 2), 'utf8')
  }

  // Comprobar estado previo al lanzamiento
  const preDefaultExists = fs.existsSync(path.join(RELAY_DIR, 'Default'))
  const preProfile1Exists = fs.existsSync(path.join(RELAY_DIR, 'Profile 1'))
  const preLastUsed = JSON.parse(fs.readFileSync(dstLocalState, 'utf8'))?.profile?.last_used

  assert('Pre-condición: relay/Default existe', preDefaultExists)
  assert('Pre-condición: relay/Profile 1 NO existe', !preProfile1Exists)
  assert('Pre-condición: Local State.last_used == "Profile 1"', preLastUsed === 'Profile 1')

  // 3. Lanzar Chrome usando la ruta de producción launchChrome()
  console.log(`\n3. Lanzando Chrome vía launchChrome(url, 'Default', { instanceId, debugPort: ${DEBUG_PORT} })...`)
  const launchResult = await launchChrome('https://chatgpt.com', 'Default', {
    instanceId: INSTANCE_ID,
    debugPort: DEBUG_PORT,
  })

  assert('Chrome arrancó y debugPort está activo', await isDebugPortActive(DEBUG_PORT))
  assert('SA extension ID detectada', !!launchResult.saExtensionId)

  // 4. Verificación post-lanzamiento en el sistema de archivos
  console.log('\n4. Verificando aislamiento de perfil en disco...')
  await sleep(3000) // Dar tiempo a Chrome de crear subdirectorios si fuera a equivocarse

  const postProfile1Exists = fs.existsSync(path.join(RELAY_DIR, 'Profile 1'))
  const postDefaultExists = fs.existsSync(path.join(RELAY_DIR, 'Default'))
  const postLastUsed = JSON.parse(fs.readFileSync(dstLocalState, 'utf8'))?.profile?.last_used

  assert('CRÍTICO: relay/Profile 1 NO fue creado ni usado', !postProfile1Exists)
  assert('CRÍTICO: relay/Default es el perfil activo', postDefaultExists)
  assert('CRÍTICO: Local State.last_used fue sanitizado a "Default"', postLastUsed === 'Default')

  // 5. Verificación de targets CDP, cookies y autenticación
  console.log('\n5. Verificando targets CDP, sesión y autenticación...')
  const targetsResp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
  const targets = (await targetsResp.json()) as any[]

  const pageTarget = targets.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))
  const swTarget = targets.find(
    t => t.type === 'service_worker' && (t.url?.includes(launchResult.saExtensionId!) || t.title?.includes('SuperAssistant'))
  )

  assert('Target de página ChatGPT encontrado', !!pageTarget)
  assert('Target de Service Worker de SuperAssistant encontrado', !!swTarget)

  if (pageTarget?.webSocketDebuggerUrl) {
    const cookies = await getCookiesViaCDP(pageTarget.webSocketDebuggerUrl, ['https://chatgpt.com', 'https://openai.com'])
    const hasAuthCookie = cookies.some(c =>
      c.name.includes('session-token') ||
      c.name.includes('jwt') ||
      c.name.includes('auth') ||
      c.name.includes('oai-')
    )
    console.log(`  Cookies totales encontradas para chatgpt.com: ${cookies.length}`)
    console.log(`  Cookies de autenticación / sesión detectadas: ${hasAuthCookie}`)
    assert('Cookies de sesión de ChatGPT presentes en el perfil Default', hasAuthCookie)

    // Comprobar estado en DOM de ChatGPT
    const domState = await evaluateInTarget(
      pageTarget.webSocketDebuggerUrl,
      `(() => {
        const hasTextarea = Boolean(document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'));
        const hasUserMenu = Boolean(document.querySelector('[data-testid="user-menu"], [aria-label*="User profile"], [aria-label*="Perfil"], img[alt*="User"]'));
        const isLoggedOut = Boolean(document.querySelector('button[data-testid="login-button"], a[href*="login"]'));
        return { hasTextarea, hasUserMenu, isLoggedOut };
      })()`
    )
    console.log('  Estado DOM en ChatGPT:', domState)
    assert('ChatGPT input box visible en el DOM', domState.hasTextarea === true)
  }

  // 6. Limpieza limpia
  console.log('\n6. Cerrando instancia de prueba...')
  await killPortIfActive(DEBUG_PORT)
  assert('Puerto de depuración 9225 liberado', (await findPidOnPort(DEBUG_PORT)) === null)

  console.log('\n' + '═'.repeat(65))
  console.log(`  RESULTADO: ${passCount} passed, ${failCount} failed`)
  console.log('═'.repeat(65))

  if (failCount > 0) {
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Error fatal en el test de contrato:', err)
  process.exit(1)
})
