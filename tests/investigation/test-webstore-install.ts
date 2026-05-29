/**
 * SA Install via Web Store: Navigate and click "Add to Chrome" using CDP
 */
import { CDPConnection } from './src/services/webRelay/ChromeCDP.ts'
import { execSync, spawn } from 'child_process'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('=== SA Install via Chrome Web Store ===\n')

  // 1. Ensure Chrome is running
  try {
    const tabs = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
    console.log('Chrome is running')
  } catch {
    console.log('Launching Chrome...')
    const ud = `${process.env.LOCALAPPDATA}\\openMCPWEBLOCK\\chrome-debug`
    spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--remote-debugging-port=9222',
      `--user-data-dir=${ud}`,
      '--no-first-run',
      'about:blank',
    ], { detached: true, stdio: 'ignore' }).unref()
    await sleep(5000)
  }

  // 2. Connect CDP
  const cdp = new CDPConnection()
  await cdp.connect()
  console.log('CDP connected')

  // 3. Navigate to SA's Web Store page
  const storeUrl = 'https://chromewebstore.google.com/detail/mcp-superassistant/kngiafgkdnlkgmefdafaibkibegkcaef'
  console.log(`\nNavigating to Web Store: ${storeUrl}`)
  await cdp.send('Page.navigate', { url: storeUrl })
  await sleep(6000)

  // 4. Check the page state
  const pageTitle = await cdp.evaluate('document.title')
  console.log(`Page title: ${pageTitle}`)

  // 5. Look for "Add to Chrome" button
  const buttonSearch = await cdp.evaluate(`
    (() => {
      // Try multiple selectors for the install button
      const selectors = [
        'button[aria-label*="Add to Chrome"]',
        'button[aria-label*="Añadir a Chrome"]',
        'button[aria-label*="Agregar a Chrome"]',
        '[role="button"][aria-label*="Add"]',
        '[role="button"][aria-label*="Añadir"]',
        'div.UywwFc-LgbsSe',  // Google's button class
      ]
      
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) {
          return JSON.stringify({
            found: true,
            selector: sel,
            text: el.textContent?.trim(),
            tag: el.tagName,
          })
        }
      }

      // Fallback: search all buttons
      const allButtons = document.querySelectorAll('button, [role="button"]')
      const results: any[] = []
      allButtons.forEach(b => {
        const text = b.textContent?.trim() || ''
        if (text && text.length < 50) {
          results.push({ text, tag: b.tagName, ariaLabel: b.getAttribute('aria-label') })
        }
      })
      
      return JSON.stringify({ found: false, buttons: results.slice(0, 10) })
    })()
  `)

  const result = JSON.parse(buttonSearch as string)
  console.log('\nButton search result:', JSON.stringify(result, null, 2))

  if (result.found) {
    console.log(`\n✓ Found install button: "${result.text}"`)
    console.log('  Clicking...')
    
    await cdp.evaluate(`document.querySelector('${result.selector}').click()`)
    await sleep(3000)

    // Check if a confirmation dialog appeared
    const dialogCheck = await cdp.evaluate(`
      (() => {
        const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
        if (dialogs.length > 0) {
          return JSON.stringify({
            found: true,
            count: dialogs.length,
            text: dialogs[0].textContent?.trim().substring(0, 200)
          })
        }
        return JSON.stringify({ found: false })
      })()
    `)
    console.log('Dialog check:', dialogCheck)
  } else {
    console.log('\n✗ Install button not found. Buttons on page:')
    for (const b of result.buttons || []) {
      console.log(`  [${b.tag}] "${b.text}" (aria: ${b.ariaLabel})`)
    }
  }

  cdp.close()
}

main().catch(e => { console.error(e); process.exit(1) })
