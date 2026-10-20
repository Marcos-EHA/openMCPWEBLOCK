import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-guest-sa-reload')
const PORT = 9229

async function run() {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('1. Launching Chrome with CDP port', PORT)
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

  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json())
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(res => { bws.onopen = () => res(null) })

  console.log('2. Loading unpacked extension via Browser CDP...')
  bws.send(JSON.stringify({
    id: 1,
    method: 'Extensions.loadUnpacked',
    params: { path: EXT_DIR }
  }))

  const loadResult = await new Promise(res => {
    bws.onmessage = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 1) res(d)
    }
  })
  const extId = (loadResult as any).result?.id
  console.log('Extensions.loadUnpacked result:', JSON.stringify(loadResult))

  console.log('3. Navigating to https://chatgpt.com/ ...')
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
  const pageTab = targets.find((t: any) => t.type === 'page')

  const pws = new WebSocket(pageTab.webSocketDebuggerUrl)
  await new Promise(res => { pws.onopen = () => res(null) })

  // Navigate to ChatGPT
  pws.send(JSON.stringify({
    id: 10,
    method: 'Page.navigate',
    params: { url: 'https://chatgpt.com/' }
  }))

  console.log('4. Waiting 8s for ChatGPT to load and SA content script to inject...')
  await new Promise(r => setTimeout(r, 8000))

  // Now check if SA injected into ChatGPT
  pws.send(JSON.stringify({
    id: 11,
    method: 'Runtime.evaluate',
    params: {
      expression: `(() => {
        return {
          url: location.href,
          title: document.title,
          // Check for SA elements or attributes
          hasSaElements: document.querySelectorAll('[class*="mcp"], [data-mcp], [class*="superassistant"]').length,
          hasPromptTextarea: !!document.querySelector('#prompt-textarea, textarea, [contenteditable="true"]'),
          scriptTags: document.querySelectorAll('script').length,
          styleTags: document.querySelectorAll('style').length,
          bodyChildren: document.body ? document.body.children.length : 0,
        };
      })()`,
      returnByValue: true
    }
  }))

  const pageCheck = await new Promise(res => {
    const h = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 11) {
        pws.removeEventListener('message', h)
        res(d.result?.result?.value)
      }
    }
    pws.addEventListener('message', h)
  })
  console.log('\nChatGPT Page Inspection:', JSON.stringify(pageCheck, null, 2))

  // Check all targets again to see service workers
  bws.send(JSON.stringify({ id: 20, method: 'Target.getTargets' }))
  const allTargets: any = await new Promise(res => {
    const h = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 20) {
        bws.removeEventListener('message', h)
        res(d.result?.targetInfos || [])
      }
    }
    bws.addEventListener('message', h)
  })

  console.log(`\n=== All Targets in Chrome (${allTargets.length}) ===`)
  for (const t of allTargets) {
    console.log(` - [${t.type}] ${t.title || ''} | ${t.url}`)
  }

  pws.close()
  bws.close()

  console.log('\nCleaning up Chrome on port', PORT)
  spawn('powershell', ['-Command', `Get-Process -Name chrome | Where-Object { $_.CommandLine -like "*${PORT}*" } | Stop-Process -Force`], { stdio: 'ignore' })
}

run().catch(console.error)
