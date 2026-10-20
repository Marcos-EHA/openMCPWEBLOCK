import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-guest-sa')
const PORT = 9228

async function run() {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('1. Launching Chrome with CDP port', PORT)
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--enable-unsafe-extension-debugging',
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://chatgpt.com',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  console.log('2. Waiting 4s for Chrome to initialize...')
  await new Promise(r => setTimeout(r, 4000))

  // Connect to Browser-level WS and load unpacked extension via Extensions.loadUnpacked
  const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json())
  console.log('Browser WS:', ver.webSocketDebuggerUrl)

  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(res => { bws.onopen = () => res(null) })

  console.log('3. Sending Extensions.loadUnpacked via Browser CDP...')
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
  console.log('Extensions.loadUnpacked response:', JSON.stringify(loadResult))

  console.log('4. Waiting 3s for Service Worker to register...')
  await new Promise(r => setTimeout(r, 3000))

  // Query targets via Target.getTargets
  bws.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }))
  const targetsResult: any = await new Promise(res => {
    const h = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 2) {
        bws.removeEventListener('message', h)
        res(d.result?.targetInfos || [])
      }
    }
    bws.addEventListener('message', h)
  })

  console.log(`\n=== Targets Found (${targetsResult.length}) ===`)
  for (const t of targetsResult) {
    console.log(` - [${t.type}] ${t.title || ''} | ${t.url}`)
  }

  const extTarget = targetsResult.find((t: any) => 
    t.url.includes('background.js') || (t.type === 'service_worker' && !t.url.includes('google'))
  )
  console.log('\n>>> Extension Service Worker target:', extTarget ? JSON.stringify(extTarget) : 'NOT FOUND')

  bws.close()

  // Clean up Chrome
  console.log('\nCleaning up test Chrome on port', PORT)
  spawn('powershell', ['-Command', `Get-Process -Name chrome | Where-Object { $_.CommandLine -like "*${PORT}*" } | Stop-Process -Force`], { stdio: 'ignore' })
}

run().catch(console.error)
