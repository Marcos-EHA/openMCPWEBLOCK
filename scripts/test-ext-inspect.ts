import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'debug-ext-test')
const PORT = 9226

async function run() {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('Testing launch with --enable-unsafe-extension-debugging and --load-extension...')
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--enable-unsafe-extension-debugging',
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'chrome://extensions',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  await new Promise(r => setTimeout(r, 4000))

  try {
    const listRes = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const targets = await listRes.json()
    console.log(`Targets on port ${PORT}:`, targets.length)
    for (const t of targets) {
      console.log(`  [${t.type}] ${t.title} -> ${t.url}`)
    }

    // Now connect to the chrome://extensions page via WebSocket and evaluate!
    const extPage = targets.find((t: any) => t.url.includes('chrome://extensions'))
    if (extPage) {
      console.log('\nConnecting to chrome://extensions page via CDP...')
      const ws = new WebSocket(extPage.webSocketDebuggerUrl)
      await new Promise(res => { ws.onopen = res })

      const evalScript = `(() => {
        // Query the extensions manager custom element
        const mgr = document.querySelector('extensions-manager');
        if (!mgr) return 'No extensions-manager element';
        const shadow = mgr.shadowRoot;
        if (!shadow) return 'No shadowRoot on extensions-manager';
        const itemList = shadow.querySelector('extensions-item-list');
        const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') || [];
        const errorList = shadow.querySelectorAll('.error-message, extensions-item-error');
        return {
          itemCount: items.length,
          itemNames: Array.from(items).map(i => i.shadowRoot?.querySelector('#name')?.textContent?.trim()),
          itemIds: Array.from(items).map(i => i.id),
          errorCount: errorList.length,
          errors: Array.from(errorList).map(e => e.textContent?.trim()),
        };
      })()`

      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: evalScript, returnByValue: true }
      }))

      const result = await new Promise(res => {
        ws.onmessage = (ev: MessageEvent) => {
          const d = JSON.parse(ev.data)
          if (d.id === 1) res(d.result?.result?.value)
        }
      })

      console.log('Extensions Page DOM Result:', JSON.stringify(result, null, 2))
      ws.close()
    }
  } catch (err: any) {
    console.error('Error:', err.message)
  }

  // Clean up
  const p = spawn('powershell', ['-Command', `Get-Process -Name chrome | Where-Object { $_.CommandLine -like "*${PORT}*" } | Stop-Process -Force`], { stdio: 'ignore' })
}

run()
