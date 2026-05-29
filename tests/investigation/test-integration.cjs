// Integration test: full flow using ChromeCDP.ts
const { launchChrome, CDPConnection } = require('./src/services/webRelay/ChromeCDP');
const { execSync } = require('child_process');

async function main() {
  console.log('=== Full Integration Test ===\n');

  // Kill existing Chrome
  try { execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 3000));
  console.log('Chrome killed');

  // Launch Chrome via ChromeCDP (should use Puppeteer pipe + load SA)
  console.log('\nLaunching Chrome via launchChrome()...');
  await launchChrome('https://chatgpt.com');
  console.log('Chrome launched!');

  // Connect via CDPConnection (uses port 9222)
  const cdp = new CDPConnection();
  await cdp.connect();
  console.log('CDPConnection connected');

  // Wait for page to load
  await new Promise(r => setTimeout(r, 5000));

  // Check page state
  const state = await cdp.checkPageState();
  console.log('\nPage state:', JSON.stringify(state, null, 2));

  // Check if SA is visible in the page
  const saCheck = await cdp.evaluate(`
    JSON.stringify({
      hasMCPContainer: !!document.getElementById('mcp-popover-container'),
      hasMCPSidebar: !!document.querySelector('#mcp-sidebar-shadow-host'),
      hasMCPSidebarData: !!document.querySelector('[data-mcp-sidebar]'),
      extensionScripts: Array.from(document.querySelectorAll('script[src*="chrome-extension"]')).map(s => s.src),
    })
  `);
  console.log('\nSA DOM check:', saCheck);

  // Check SA service worker via CDP targets
  const resp = await fetch('http://127.0.0.1:9222/json');
  const tabs = await resp.json();
  const saTargets = tabs.filter(t => t.url && t.url.includes('kngiafgkdnlkgmefdafaibkibegkcaef'));
  console.log(`\nSA service worker targets: ${saTargets.length}`);
  saTargets.forEach(t => console.log(`  [${t.type}] ${t.url}`));

  cdp.close();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
