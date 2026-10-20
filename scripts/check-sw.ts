// Check SW state and content script registration
const wsUrl = process.argv[2];
if (!wsUrl) { console.error("Need WS URL"); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 1;

function cdp(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const myId = id++;
    const handler = (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      if (d.id === myId) { ws.removeEventListener("message", handler); resolve(d); }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { ws.removeEventListener("message", handler); resolve({ timeout: true }); }, 5000);
  });
}

ws.onopen = async () => {
  // 1. Get extension info from SW
  const info = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      extensionId: chrome.runtime.id,
      manifest: chrome.runtime.getManifest().name,
      version: chrome.runtime.getManifest().version,
      contentScripts: chrome.runtime.getManifest().content_scripts?.length,
      permissions: chrome.runtime.getManifest().permissions,
    })`,
    returnByValue: true,
  });
  console.log("Extension Info:", info.result?.result?.value);

  // 2. Check if there are any registered content scripts
  const cs = await cdp("Runtime.evaluate", {
    expression: `new Promise(async (resolve) => {
      try {
        const scripts = await chrome.scripting.getRegisteredContentScripts();
        resolve(JSON.stringify({ registered: scripts.length, scripts }));
      } catch(e) {
        resolve(JSON.stringify({ error: e.message }));
      }
    })`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("Registered scripts:", cs.result?.result?.value);

  // 3. Check storage for MCP config
  const storage = await cdp("Runtime.evaluate", {
    expression: `new Promise(r => chrome.storage.local.get(null, d => r(JSON.stringify(Object.keys(d)))))`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("Storage keys:", storage.result?.result?.value);

  // 4. Check recent console errors
  await cdp("Console.enable");
  const errors = await cdp("Runtime.evaluate", {
    expression: `"SW is alive. Self: " + typeof self + ", chrome: " + typeof chrome.runtime`,
    returnByValue: true,
  });
  console.log("SW alive:", errors.result?.result?.value);

  // 5. Try to manually inject content script
  console.log("\nAttempting manual injection...");
  const inject = await cdp("Runtime.evaluate", {
    expression: `new Promise(async (resolve) => {
      try {
        const tabs = await chrome.tabs.query({url: '*://*.chatgpt.com/*'});
        resolve(JSON.stringify({ 
          chatgptTabs: tabs.length, 
          tabIds: tabs.map(t => ({id: t.id, url: t.url}))
        }));
      } catch(e) {
        resolve(JSON.stringify({ error: e.message }));
      }
    })`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("ChatGPT tabs:", inject.result?.result?.value);

  // 6. Force inject content script
  const forceInject = await cdp("Runtime.evaluate", {
    expression: `new Promise(async (resolve) => {
      try {
        const tabs = await chrome.tabs.query({url: '*://*.chatgpt.com/*'});
        if (tabs.length === 0) { resolve('No chatgpt tabs'); return; }
        const tabId = tabs[0].id;
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/index.iife.js']
        });
        resolve('Injected into tab ' + tabId);
      } catch(e) {
        resolve('Injection error: ' + e.message);
      }
    })`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log("Force inject:", forceInject.result?.result?.value);

  ws.close();
  process.exit(0);
};

setTimeout(() => process.exit(1), 15000);
