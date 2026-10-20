import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const TEST_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-guest-launcher')
const PORT = 9231

export async function launchGuestChromeWithSA(
  url = 'https://chatgpt.com',
  userDataDir = TEST_DIR,
  debugPort = PORT,
): Promise<{ extId: string; debugPort: number }> {
  console.log(`[GuestLauncher] Starting Chrome on port ${debugPort} with profile ${userDataDir}...`)
  if (existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })

  // Launch Chrome
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  // Wait for debug port
  let ver: any = null
  for (let i = 0; i < 20; i++) {
    try {
      ver = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json())
      if (ver?.webSocketDebuggerUrl) break
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  if (!ver?.webSocketDebuggerUrl) {
    throw new Error(`Chrome failed to start on port ${debugPort}`)
  }

  // Connect to browser CDP
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(res => { bws.onopen = () => res(null) })

  let reqId = 1
  function sendBrowser(method: string, params: any = {}): Promise<any> {
    const id = reqId++
    return new Promise((resolve, reject) => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === id) {
          bws.removeEventListener('message', h)
          if (d.error) reject(new Error(JSON.stringify(d.error)))
          else resolve(d.result)
        }
      }
      bws.addEventListener('message', h)
      bws.send(JSON.stringify({ id, method, params }))
    })
  }

  // Load unpacked extension
  console.log('[GuestLauncher] Loading local SA extension from:', EXT_DIR)
  const loadRes = await sendBrowser('Extensions.loadUnpacked', { path: EXT_DIR })
  const extId = loadRes.id
  console.log(`[GuestLauncher] SA loaded with ID: ${extId}`)

  // Wait for service worker
  let swSessionId: string | null = null
  for (let i = 0; i < 20; i++) {
    const { targetInfos } = await sendBrowser('Target.getTargets')
    const sw = targetInfos.find((t: any) => t.type === 'service_worker' && (t.url.includes(extId) || t.url.includes('background.js')))
    if (sw) {
      const att = await sendBrowser('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
      swSessionId = att.sessionId
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }

  if (swSessionId) {
    console.log('[GuestLauncher] Configuring SA storage (mcpServerUrl = http://localhost:3006)...')
    const evalId = reqId++
    bws.send(JSON.stringify({
      id: evalId,
      sessionId: swSessionId,
      method: 'Runtime.evaluate',
      params: {
        expression: `(async () => {
          await chrome.storage.local.set({
            mcpServerUrl: 'http://localhost:3006',
            mcpConnectionType: 'streamable-http'
          });
          return 'CONFIGURED';
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    }))
    await new Promise(res => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === evalId) {
          bws.removeEventListener('message', h)
          res(d.result?.result?.value)
        }
      }
      bws.addEventListener('message', h)
    })
    console.log('[GuestLauncher] SA storage configured!')
  }

  // Navigate the initial page to the target URL
  console.log(`[GuestLauncher] Navigating page to ${url}...`)
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())
  const pageTab = targets.find((t: any) => t.type === 'page')
  if (pageTab) {
    const pws = new WebSocket(pageTab.webSocketDebuggerUrl)
    await new Promise(res => { pws.onopen = () => res(null) })
    pws.send(JSON.stringify({
      id: 99,
      method: 'Page.navigate',
      params: { url }
    }))
    await new Promise(r => setTimeout(r, 1000))
    pws.close()
  }

  bws.close()
  console.log(`[GuestLauncher] Chrome ready in Guest Mode on port ${debugPort}!`)
  return { extId, debugPort }
}

// Test runner
if (import.meta.main) {
  launchGuestChromeWithSA().catch(console.error)
}
