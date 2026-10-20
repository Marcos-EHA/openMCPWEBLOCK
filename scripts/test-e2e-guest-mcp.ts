import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-e2e-guest')
const PORT = 9230

async function run() {
  // 1. Check MCP server
  console.log('1. Checking MCP server on :3006...')
  let mcpRunning = false
  try {
    const h = await fetch('http://localhost:3006/healthz').then(r => r.text())
    if (h === 'ok') mcpRunning = true
  } catch {}

  if (!mcpRunning) {
    console.log('Starting MCP server...')
    const mcpProc = spawn('bun', ['run', 'server:mcp'], {
      cwd: 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK',
      detached: true,
      stdio: 'ignore'
    })
    mcpProc.unref()
    await new Promise(r => setTimeout(r, 4000))
  }
  console.log('MCP server running on :3006')

  // 2. Prepare clean profile
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('2. Launching Chrome (Guest Mode) on port', PORT)
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  await new Promise(r => setTimeout(r, 3000))

  // 3. Connect to Browser WS and load unpacked extension
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json())
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(res => { bws.onopen = () => res(null) })

  let reqId = 1
  function sendBrowser(method: string, params: any = {}): Promise<any> {
    const id = reqId++
    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === id) {
          bws.removeEventListener('message', handler)
          if (d.error) reject(new Error(JSON.stringify(d.error)))
          else resolve(d.result)
        }
      }
      bws.addEventListener('message', handler)
      bws.send(JSON.stringify({ id, method, params }))
    })
  }

  console.log('3. Loading local SA extension...')
  const loadRes = await sendBrowser('Extensions.loadUnpacked', { path: EXT_DIR })
  const extId = loadRes.id
  console.log(`Local SA loaded with ID: ${extId}`)

  // 4. Wait for SW target
  console.log('4. Locating SA Service Worker...')
  let swSessionId: string | null = null
  for (let i = 0; i < 15; i++) {
    const { targetInfos } = await sendBrowser('Target.getTargets')
    const sw = targetInfos.find((t: any) => t.type === 'service_worker' && t.url.includes(extId))
    if (sw) {
      console.log('Found SW:', sw.url)
      const att = await sendBrowser('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
      swSessionId = att.sessionId
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }

  if (swSessionId) {
    console.log('5. Configuring SA extension storage via SW session...')
    const cfgExpr = `(async () => {
      await chrome.storage.local.set({
        mcpServerUrl: 'http://localhost:3006',
        mcpConnectionType: 'streamable-http'
      });
      const readBack = await chrome.storage.local.get(['mcpServerUrl', 'mcpConnectionType']);
      return readBack;
    })()`

    // Send Runtime.evaluate to the SW session
    const evalId = reqId++
    bws.send(JSON.stringify({
      id: evalId,
      sessionId: swSessionId,
      method: 'Runtime.evaluate',
      params: { expression: cfgExpr, awaitPromise: true, returnByValue: true }
    }))

    const cfgRes: any = await new Promise(res => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === evalId) {
          bws.removeEventListener('message', h)
          res(d.result?.result?.value)
        }
      }
      bws.addEventListener('message', h)
    })
    console.log('SA Storage Configuration:', JSON.stringify(cfgRes))
  } else {
    console.warn('SW target not attached yet (will wake up on page navigation)')
  }

  // 6. Navigate page to ChatGPT
  console.log('6. Navigating to https://chatgpt.com/ ...')
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
  const pageTab = targets.find((t: any) => t.type === 'page')

  const pws = new WebSocket(pageTab.webSocketDebuggerUrl)
  await new Promise(res => { pws.onopen = () => res(null) })

  pws.send(JSON.stringify({
    id: 100,
    method: 'Page.navigate',
    params: { url: 'https://chatgpt.com/' }
  }))

  console.log('7. Waiting 10s for ChatGPT and SA content script...')
  await new Promise(r => setTimeout(r, 10000))

  // Inspect page
  let pReqId = 200
  function sendPage(method: string, params: any = {}): Promise<any> {
    const id = pReqId++
    return new Promise((resolve) => {
      const h = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === id) {
          pws.removeEventListener('message', h)
          resolve(d.result?.result?.value)
        }
      }
      pws.addEventListener('message', h)
      pws.send(JSON.stringify({ id, method, params }))
    })
  }

  const pageStatus = await sendPage('Runtime.evaluate', {
    expression: `(() => {
      return {
        url: location.href,
        title: document.title,
        hasPromptTextarea: !!document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'),
        hasMcpPopover: !!document.querySelector('#mcp-popover-container, .mcp-popover-container, .mcp-main-button'),
        hasSaElements: document.querySelectorAll('[class*="mcp-"], [data-mcp], [class*="superassistant"]').length,
        styleCount: document.querySelectorAll('style').length,
      };
    })()`,
    returnByValue: true
  })
  console.log('\nPage Status:', JSON.stringify(pageStatus, null, 2))

  // Check SW targets again
  const { targetInfos: finalTargets } = await sendBrowser('Target.getTargets')
  console.log(`\n=== All Chrome Targets (${finalTargets.length}) ===`)
  for (const t of finalTargets) {
    const isSA = t.url.includes(extId) || t.url.includes('background.js')
    console.log(` - [${t.type}] ${t.title || ''} | ${t.url} ${isSA ? '★ SA TARGET' : ''}`)
  }

  pws.close()
  bws.close()

  console.log('\nSUCCESS! Chrome running on port', PORT)
  console.log('Browser left open for inspection. Close with powershell when done.')
}

run().catch(console.error)
