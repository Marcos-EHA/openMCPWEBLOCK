// Test Extensions.loadUnpacked via Puppeteer pipe (Node.js)
const puppeteer = require('puppeteer-core');

const SA_DIR = process.env.LOCALAPPDATA + '\\openMCPWEBLOCK\\sa-extension';
const UD = process.env.LOCALAPPDATA + '\\openMCPWEBLOCK\\chrome-debug';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  console.log('=== Puppeteer Pipe + Extensions.loadUnpacked ===\n');
  console.log('SA dir:', SA_DIR);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    pipe: true,
    userDataDir: UD,
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--disable-default-apps',
    ],
    headless: false,
    timeout: 30000,
  });

  console.log('\nChrome launched via pipe');

  // Create CDP session on browser target
  const cdpSession = await browser.target().createCDPSession();
  console.log('CDP session created');

  // Try Extensions.loadUnpacked
  console.log(`\nExtensions.loadUnpacked("${SA_DIR}")...`);
  try {
    const result = await cdpSession.send('Extensions.loadUnpacked', {
      path: SA_DIR,
    });
    console.log('\n🎉 SUCCESS!');
    console.log('Extension ID:', result.id);

    // Verify
    const exts = await cdpSession.send('Extensions.getExtensions');
    console.log('\nLoaded extensions:');
    for (const ext of exts.extensions || []) {
      console.log(`  [${ext.id}] ${ext.name} v${ext.version} (enabled: ${ext.enabled})`);
    }
  } catch (e) {
    console.log('\n❌ FAILED:', e.message);
    try {
      const exts = await cdpSession.send('Extensions.getExtensions');
      console.log('getExtensions result:', JSON.stringify(exts));
    } catch (e2) {
      console.log('getExtensions also failed:', e2.message);
    }
  }

  await browser.disconnect();
  console.log('\nDone. Browser still running.');
}

main().catch(e => { console.error(e); process.exit(1); });
