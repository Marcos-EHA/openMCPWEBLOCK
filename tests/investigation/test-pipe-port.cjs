// Test: pipe + port coexistence for load, then use port for operation
const puppeteer = require('puppeteer-core');

const SA_DIR = process.env.LOCALAPPDATA + '\\openMCPWEBLOCK\\sa-extension';
const UD = process.env.LOCALAPPDATA + '\\openMCPWEBLOCK\\chrome-debug';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  console.log('=== Pipe Install + Port Operation ===\n');

  // Step 1: Launch Chrome with BOTH pipe and port
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    pipe: true,
    userDataDir: UD,
    args: [
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-port=9222',  // ← Also enable port!
      '--no-first-run',
      '--disable-default-apps',
    ],
    headless: false,
    timeout: 30000,
  });

  console.log('Chrome launched (pipe + port)');

  // Step 2: Load SA via pipe CDP
  const cdp = await browser.target().createCDPSession();
  
  try {
    const result = await cdp.send('Extensions.loadUnpacked', { path: SA_DIR });
    console.log('SA loaded! ID:', result.id);
  } catch (e) {
    console.log('loadUnpacked failed:', e.message);
  }

  // Step 3: Disconnect pipe (but browser stays alive with port)
  await browser.disconnect();
  console.log('Pipe disconnected');

  // Step 4: Verify port is available
  await new Promise(r => setTimeout(r, 2000));
  try {
    const resp = await fetch('http://127.0.0.1:9222/json');
    const tabs = await resp.json();
    console.log(`\nPort 9222 active! ${tabs.length} targets`);
    
    const saTargets = tabs.filter(t => t.url && t.url.includes('kngiafgkdnlkgmefdafaibkibegkcaef'));
    if (saTargets.length > 0) {
      console.log('\n✅ SA is active and accessible via port!');
      saTargets.forEach(t => console.log(`  [${t.type}] ${t.url}`));
    } else {
      console.log('\nExtension targets:');
      tabs.filter(t => t.url && t.url.startsWith('chrome-extension://')).forEach(t => {
        console.log(`  [${t.type}] ${t.url}`);
      });
    }
  } catch (e) {
    console.log('Port 9222 not available:', e.message);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
