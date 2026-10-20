/**
 * scripts/test-auth-propagation-feasibility.ts
 *
 * Prueba controlada y no destructiva de viabilidad de autenticación:
 * - Chrome real permanece abierto.
 * - Relay experimental en puerto 9226 con --profile-directory=Default.
 * - Suministra Network/Cookies desde el snapshot no bloqueado con credenciales.
 * - Comprueba vía CDP:
 *   1. Metadatos de cookies devueltas por CDP (Network.getCookies).
 *   2. URL final de ChatGPT.
 *   3. Si aparece Login/Signup o sesión autenticada.
 *   4. Presencia de [data-testid="composer-plus-btn"].
 *   5. Presencia de #prompt-textarea.
 */

import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'

const PORT = 9226
const INSTANCE_ID = 'test-auth-experiment'
const RELAY_DIR = path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-agents', INSTANCE_ID)
const CHROME_USER_DATA = path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'User Data')

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
    }, 15000)

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

async function main() {
  console.log('═'.repeat(65))
  console.log('  PRUEBA NO DESTRUCTIVA: PROPAGACIÓN DE AUTENTICACIÓN A RELAY')
  console.log('═'.repeat(65))

  await killPortIfActive(PORT)

  // 1. Preparar directorio de relay aislado
  console.log('\n1. Preparando directorio experimental de relay...')
  if (fs.existsSync(RELAY_DIR)) {
    fs.rmSync(RELAY_DIR, { recursive: true, force: true })
  }
  const defaultDir = path.join(RELAY_DIR, 'Default')
  fs.mkdirSync(defaultDir, { recursive: true })

  // Copiar archivos base de perfil (Preferences, Local State)
  const srcProfile = path.join(CHROME_USER_DATA, 'Default')
  for (const f of ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']) {
    try {
      const src = path.join(srcProfile, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(defaultDir, f))
    } catch {}
  }

  // Local State con last_used = Default
  try {
    const src = path.join(CHROME_USER_DATA, 'Local State')
    const dst = path.join(RELAY_DIR, 'Local State')
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
      const raw = fs.readFileSync(dst, 'utf8')
      const ls = JSON.parse(raw)
      if (ls.profile) {
        ls.profile.last_used = 'Default'
        fs.writeFileSync(dst, JSON.stringify(ls), 'utf8')
      }
    }
  } catch {}

  // Suministrar Network/Cookies desde el snapshot de cookies preservado
  const snapshotCookies = path.join(
    process.env.LOCALAPPDATA ?? '',
    'openMCPWEBLOCK',
    'chrome-agents',
    'web-780d0012-82b3-45fc-9d00-bb913f2e4f17',
    'Default',
    'Network',
    'Cookies'
  )

  const dstNet = path.join(defaultDir, 'Network')
  fs.mkdirSync(dstNet, { recursive: true })
  if (fs.existsSync(snapshotCookies)) {
    fs.copyFileSync(snapshotCookies, path.join(dstNet, 'Cookies'))
    console.log('  Snapshot de Cookies copiado con éxito (' + fs.statSync(snapshotCookies).size + ' bytes)')
  } else {
    console.log('  ADVERTENCIA: Snapshot de cookies no encontrado')
  }

  // 2. Lanzar Chrome en puerto aislado 9226
  console.log('\n2. Lanzando Chrome experimental en puerto ' + PORT + '...')
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const chromeArgs = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${RELAY_DIR}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    'https://chatgpt.com/',
  ]

  const proc = spawn(chromePath, chromeArgs, {
    detached: true,
    stdio: 'ignore',
  })
  proc.unref()

  console.log('  Chrome lanzado con PID:', proc.pid)

  // Esperar a que el puerto responda
  let cdpReady = false
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) {
        cdpReady = true
        break
      }
    } catch {}
  }

  if (!cdpReady) {
    throw new Error('Chrome no respondió en el puerto ' + PORT)
  }
  console.log('  CDP activo en http://127.0.0.1:' + PORT)

  // 3. Inspeccionar targets
  const targetsResp = await fetch(`http://127.0.0.1:${PORT}/json`)
  const targets = (await targetsResp.json()) as any[]
  const pageTarget = targets.find(t => t.type === 'page' && t.url?.includes('chatgpt.com'))

  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('Target de ChatGPT no encontrado en /json')
  }
  const pageWs = pageTarget.webSocketDebuggerUrl

  // 4. Inspeccionar cookies descifradas vía CDP (Network.getCookies)
  console.log('\n3. Inspeccionando cookies en memoria descifradas por Chrome vía CDP...')
  const cookiesResult = await sendCdpCommand(pageWs, 'Network.getCookies', {
    urls: ['https://chatgpt.com', 'https://auth.openai.com'],
  })

  const cookiesList: any[] = cookiesResult?.cookies || []
  console.log(`  CDP devolvió ${cookiesList.length} cookies para chatgpt.com / auth.openai.com`)

  const cookieMetadata = cookiesList.map(c => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'Session',
    session: c.session,
  }))

  console.log('  Metadatos de cookies clave identificadas:')
  for (const m of cookieMetadata) {
    if (m.name.includes('session') || m.name.includes('token') || m.name.includes('auth') || m.name.includes('cf_clearance') || m.name.includes('oai-did')) {
      console.log(`    - ${m.name} | Domain: ${m.domain} | Secure: ${m.secure} | HttpOnly: ${m.httpOnly} | SameSite: ${m.sameSite} | Expires: ${m.expires}`)
    }
  }

  // 5. Esperar a la hidratación completa de ChatGPT
  console.log('\n4. Esperando 10s para hidratación del DOM de ChatGPT...')
  await sleep(10000)

  // 6. Evaluar estado de autenticación real en el DOM
  console.log('\n5. Evaluando autenticación real y presencia de elementos en el DOM...')
  const domInfo = await sendCdpCommand(pageWs, 'Runtime.evaluate', {
    expression: `(() => {
      const url = window.location.href;
      const allButtons = Array.from(document.querySelectorAll('button, a'));
      const hasLoginBtn = Boolean(document.querySelector('button[data-testid="login-button"], a[href*="/auth/login"]')) ||
        allButtons.some(b => (b.textContent || '').trim().toLowerCase() === 'log in' || (b.textContent || '').trim().toLowerCase() === 'iniciar sesión');
      const hasSignupBtn = Boolean(document.querySelector('button[data-testid="signup-button"], a[href*="/auth/signup"]')) ||
        allButtons.some(b => (b.textContent || '').trim().toLowerCase() === 'sign up' || (b.textContent || '').trim().toLowerCase() === 'registrarse');
      const plusBtn = document.querySelector('[data-testid="composer-plus-btn"]');
      const textarea = document.querySelector('#prompt-textarea');
      const leadingArea = document.querySelector('[grid-area="leading"]');
      const userMenu = document.querySelector('[data-testid="user-menu-button"], [data-testid="profile-button"], [aria-label*="User profile"], [aria-label*="Cuenta"], [aria-label*="Perfil"]');
      const title = document.title;

      return {
        url,
        title,
        hasLoginBtn,
        hasSignupBtn,
        hasUserMenu: Boolean(userMenu),
        userMenuAriaLabel: userMenu ? userMenu.getAttribute('aria-label') : null,
        hasPlusBtn: Boolean(plusBtn),
        plusBtnVisible: plusBtn ? (window.getComputedStyle(plusBtn).display !== 'none') : false,
        hasTextarea: Boolean(textarea),
        hasLeadingArea: Boolean(leadingArea),
        bodyTextSnippet: document.body.innerText.slice(0, 300).replace(/\\s+/g, ' '),
      };
    })()`,
    returnByValue: true,
  })

  console.log('  Resultado DOM inspeccionado:', JSON.stringify(domInfo?.result?.value, null, 2))

  // 7. Limpieza controlada
  console.log('\n6. Cerrando Chrome experimental en puerto ' + PORT + '...')
  await killPortIfActive(PORT)
  if (fs.existsSync(RELAY_DIR)) {
    fs.rmSync(RELAY_DIR, { recursive: true, force: true })
  }
  console.log('  Limpieza completada.')

  console.log('\n' + '═'.repeat(65))
  console.log('  FIN DE LA PRUEBA')
  console.log('═'.repeat(65))
}

main().catch(err => {
  console.error('Error en prueba:', err)
  process.exit(1)
})
