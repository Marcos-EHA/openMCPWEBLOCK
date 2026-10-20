import { spawn } from 'child_process'
import { join } from 'path'
import { rmSync, mkdirSync, existsSync } from 'fs'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const USER_DIR = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-ext-dir')
const PORT = 9225

async function run() {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true })
  mkdirSync(USER_DIR, { recursive: true })

  console.log('Launching Chrome with --load-extension...')
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    `--load-extension=${EXT_DIR}`,
    `--disable-extensions-except=${EXT_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'chrome://extensions',
  ], { detached: true, stdio: 'ignore' })
  proc.unref()

  console.log('Waiting 5s for Chrome to start...')
  await new Promise(r => setTimeout(r, 5000))

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const targets = await res.json()
    console.log('Targets found:', targets.length)
    for (const t of targets) {
      console.log(` - [${t.type}] ${t.title || ''} | ${t.url}`)
    }
  } catch (err: any) {
    console.error('Fetch error:', err.message)
  }

  // Also check browser version
  try {
    const ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(r => r.json())
    console.log('Browser version:', ver.Browser)
    console.log('User-Agent:', ver['User-Agent'])
  } catch {}

  console.log('\nDone check. Now closing Chrome on port', PORT)
  // Kill this instance
  try {
    const pids = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null)
  } catch {}
}

run()
