import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-fresh-ext-load')
const PORT = 9227

async function run() {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('Launching FRESH Chrome with --load-extension...')
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://chatgpt.com',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  console.log('Waiting 5s for Chrome...')
  await new Promise(r => setTimeout(r, 5000))

  const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await listRes.json()
  console.log(`Targets on port ${PORT}: ${targets.length}`)
  for (const t of targets) {
    console.log(` - [${t.type}] ${t.title || ''} | ${t.url}`)
  }

  // Check for service worker or background page of our extension!
  const sw = targets.find((t: any) => t.type === 'service_worker' && (t.url.includes('background.js') || !t.url.includes('google')))
  console.log('\nExtension Service Worker Target:', sw ? JSON.stringify(sw) : 'NONE FOUND')

  // Check page content on chatgpt.com
  const chatTab = targets.find((t: any) => t.url.includes('chatgpt.com'))
  if (chatTab) {
    console.log('\nChecking ChatGPT page for SuperAssistant injection...')
    const ws = new WebSocket(chatTab.webSocketDebuggerUrl)
    await new Promise(res => { ws.onopen = () => res(null) })
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `JSON.stringify({
          url: location.href,
          hasMcpClient: typeof window.mcpClient !== 'undefined',
          hasSaElements: document.querySelectorAll('[class*="mcp-"], [data-mcp], #mcp-popover').length,
          styleCount: document.querySelectorAll('style').length
        })`,
        returnByValue: true
      }
    }))
    const res = await new Promise(res => {
      ws.onmessage = (e: MessageEvent) => {
        const d = JSON.parse(e.data)
        if (d.id === 1) res(d.result?.result?.value)
      }
    })
    console.log('ChatGPT page check:', res)
    ws.close()
  }

  // Cleanup
  console.log('Cleaning up Chrome on port', PORT)
  spawn('powershell', ['-Command', `Get-Process -Name chrome | Where-Object { $_.CommandLine -like "*${PORT}*" } | Stop-Process -Force`], { stdio: 'ignore' })
}

run().catch(console.error)
