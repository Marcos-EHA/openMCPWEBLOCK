/**
 * Launch Chrome with SA extension using Puppeteer (reliable extension loading)
 */
import puppeteer from 'puppeteer-core';
import { resolve } from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT_PATH = resolve(import.meta.dir, '..', 'chrome-extension', 'source', 'dist');
const PROFILE_DIR = resolve(import.meta.dir, '..', 'chrome-profile-pptr');

async function main() {
  console.log(`Extension: ${EXT_PATH}`);
  console.log(`Profile: ${PROFILE_DIR}`);
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    userDataDir: PROFILE_DIR,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    defaultViewport: null,
  });

  console.log('Browser launched');

  // Wait for startup
  await new Promise(r => setTimeout(r, 3000));

  // List all targets
  const targets = browser.targets();
  console.log(`\n=== ${targets.length} Targets ===`);
  for (const t of targets) {
    console.log(`  [${t.type()}] ${t.url().substring(0, 80)}`);
  }

  // Find our extension's background service worker
  const swTarget = targets.find(t => 
    t.type() === 'service_worker' && t.url().includes('background.js')
  );
  
  // Also check for any extension target
  const extTargets = targets.filter(t => t.url().includes('chrome-extension://'));
  console.log(`\nExtension targets: ${extTargets.length}`);
  for (const t of extTargets) {
    console.log(`  [${t.type()}] ${t.url()}`);
  }

  if (swTarget) {
    console.log(`\n✅ SA Service Worker found: ${swTarget.url()}`);
    // Extract extension ID from URL
    const extId = swTarget.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
    console.log(`Extension ID: ${extId}`);
  } else {
    console.log('\n⚠️  SA SW not found. Checking for errors...');
    
    // Navigate to chrome://extensions to see status
    const page = await browser.newPage();
    await page.goto('chrome://extensions', { waitUntil: 'networkidle2' });
    
    // Get extension info from the page
    // chrome://extensions uses shadow DOM, so we need to pierce it
    const extInfo = await page.evaluate(() => {
      // Try to get extension data from the extensions page
      const manager = document.querySelector('extensions-manager');
      if (!manager?.shadowRoot) return 'No extensions-manager found';
      
      const itemList = manager.shadowRoot.querySelector('extensions-item-list');
      if (!itemList?.shadowRoot) return 'No item-list found';
      
      const items = itemList.shadowRoot.querySelectorAll('extensions-item');
      const result: any[] = [];
      for (const item of items) {
        const name = item.shadowRoot?.querySelector('#name')?.textContent?.trim();
        const id = item.id;
        const errors = item.shadowRoot?.querySelector('.dev-reload-button')?.textContent?.trim();
        result.push({ name, id, errors });
      }
      return result;
    });
    console.log('Extensions page:', JSON.stringify(extInfo, null, 2));
    await page.close();
  }

  // Navigate to ChatGPT
  const pages = await browser.pages();
  let chatPage = pages[0] || await browser.newPage();
  await chatPage.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log('\nNavigated to ChatGPT');
  
  // Wait for content script
  await new Promise(r => setTimeout(r, 5000));
  
  // Check SA injection
  const saStatus = await chatPage.evaluate(() => {
    return {
      mcpClient: typeof (window as any).mcpClient,
      saStyles: [...document.querySelectorAll('style')].filter(s => 
        s.textContent?.includes('function-call') || s.textContent?.includes('mcp-')
      ).length,
      saElements: document.querySelectorAll('[data-function-call-id], [class*="mcp-"]').length,
      hasPrompt: !!document.querySelector('#prompt-textarea'),
    };
  });
  console.log('SA Status:', JSON.stringify(saStatus));

  // Keep browser open
  console.log('\n✅ Browser running. Press Ctrl+C to exit.');
  console.log(`CDP: chrome://inspect or http://localhost:9222`);
  
  // Keep alive
  await new Promise(() => {});
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
