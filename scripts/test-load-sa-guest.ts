import { join } from 'path'
import { existsSync, rmSync, mkdirSync } from 'fs'
import puppeteer from 'puppeteer-core'

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SA_LOCAL_DIST = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK\\chrome-extension\\source\\dist'
const TEST_PROFILE = join(process.env.LOCALAPPDATA || 'C:\\temp', 'openMCPWEBLOCK', 'test-guest-profile')

async function testPipeLoad() {
  console.log('--- Testing Pipe Transport Extensions.loadUnpacked ---')
  if (existsSync(TEST_PROFILE)) {
    rmSync(TEST_PROFILE, { recursive: true, force: true })
  }
  mkdirSync(TEST_PROFILE, { recursive: true })

  console.log(`Launching Chrome with pipe transport, profile=${TEST_PROFILE}...`)
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    pipe: true,
    userDataDir: TEST_PROFILE,
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
    ],
    headless: false,
    timeout: 30000,
  })

  try {
    const cdp = await browser.target().createCDPSession()
    console.log('Sending Extensions.loadUnpacked for:', SA_LOCAL_DIST)
    const result = await cdp.send('Extensions.loadUnpacked', { path: SA_LOCAL_DIST })
    console.log('Extensions.loadUnpacked RESULT:', JSON.stringify(result))

    // Check targets in browser
    const targets = browser.targets()
    console.log(`Targets count: ${targets.length}`)
    for (const t of targets) {
      console.log(` - [${t.type()}] ${t.url()}`)
    }

    const swTarget = targets.find(t => t.type() === 'service_worker' || t.url().includes('chrome-extension://'))
    if (swTarget) {
      console.log('SUCCESS! Extension target found:', swTarget.url())
    } else {
      console.log('No extension target found in targets list.')
    }
  } catch (err: any) {
    console.error('FAILED Extensions.loadUnpacked:', err.message)
  } finally {
    console.log('Closing test browser...')
    await browser.close()
  }
}

testPipeLoad().catch(console.error)
