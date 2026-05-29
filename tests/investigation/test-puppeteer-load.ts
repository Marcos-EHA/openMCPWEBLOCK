/**
 * Test: Extensions.loadUnpacked via Puppeteer pipe transport
 * 
 * Puppeteer handles Windows named pipes natively.
 * This should confirm that loadUnpacked works when connected via pipe.
 */
import puppeteer from 'puppeteer-core'

const SA_DIR = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\sa-extension`
const UD = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\chrome-debug`
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

console.log('=== Puppeteer Pipe + Extensions.loadUnpacked ===\n')
console.log('SA dir:', SA_DIR)
console.log('User data:', UD)

// Launch Chrome via Puppeteer with pipe transport
const browser = await puppeteer.launch({
  executablePath: CHROME,
  pipe: true,  // ← Use pipe transport (not port)
  userDataDir: UD,
  args: [
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--disable-default-apps',
  ],
  headless: false,
})

console.log('\nChrome launched via Puppeteer (pipe mode)')

// Get the CDP session at browser level
const pages = await browser.pages()
console.log(`Pages: ${pages.length}`)

// Create a CDP session on the browser target
const target = await browser.target()
const cdpSession = await target.createCDPSession()

console.log('\nCDP session created on browser target')

// Try Extensions.loadUnpacked
console.log(`\nCalling Extensions.loadUnpacked("${SA_DIR}")...`)
try {
  const result = await cdpSession.send('Extensions.loadUnpacked', {
    path: SA_DIR,
  })
  console.log('\n🎉 SUCCESS!')
  console.log('Extension ID:', result.id)
  
  // Verify by listing extensions
  const exts = await cdpSession.send('Extensions.getExtensions')
  console.log('\nLoaded extensions:')
  for (const ext of exts.extensions || []) {
    console.log(`  [${ext.id}] ${ext.name} v${ext.version} (enabled: ${ext.enabled})`)
  }
} catch (e: any) {
  console.log('\n❌ FAILED:', e.message)
  
  // Try alternative: get extensions to see what's available
  try {
    const exts = await cdpSession.send('Extensions.getExtensions')
    console.log('getExtensions worked:', JSON.stringify(exts))
  } catch (e2: any) {
    console.log('getExtensions also failed:', e2.message)
  }
}

// Don't close browser - leave it running so we can inspect
// await browser.close()
await browser.disconnect()
console.log('\nDisconnected from browser (browser still running)')
process.exit(0)
