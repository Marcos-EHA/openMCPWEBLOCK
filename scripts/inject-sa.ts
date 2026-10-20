/**
 * Auto-attach to SA Service Worker and inject content script.
 * Uses Target.setAutoAttach to catch the SW before it sleeps.
 */

const BROWSER_WS = process.argv[2];
if (!BROWSER_WS) { console.error("Need browser WS URL"); process.exit(1); }

const ws = new WebSocket(BROWSER_WS);
let nextId = 1;
let swSessionId: string | null = null;

function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  return new Promise((resolve) => {
    const id = nextId++;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) { ws.removeEventListener("message", handler); resolve(data); }
    };
    ws.addEventListener("message", handler);
    const msg: any = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    setTimeout(() => { ws.removeEventListener("message", handler); resolve({ timeout: true }); }, 10000);
  });
}

async function onSwAttached(sessionId: string) {
  swSessionId = sessionId;
  console.log(`\n✅ Attached to SA Service Worker (session: ${sessionId})`);

  // Enable Runtime in the SW context
  await send("Runtime.enable", {}, sessionId);

  // Get extension info
  const info = await send("Runtime.evaluate", {
    expression: "JSON.stringify({id: chrome.runtime.id, name: chrome.runtime.getManifest().name})",
    returnByValue: true
  }, sessionId);
  console.log("Extension:", info.result?.result?.value);

  // List tabs
  const tabs = await send("Runtime.evaluate", {
    expression: `new Promise(r => chrome.tabs.query({}, tabs => r(JSON.stringify(tabs.map(t => ({id: t.id, url: t.url}))))))`,
    returnByValue: true, awaitPromise: true
  }, sessionId);
  console.log("Tabs:", tabs.result?.result?.value);

  // Configure MCP server
  const config = await send("Runtime.evaluate", {
    expression: `new Promise(r => chrome.storage.local.set({mcpServerUrl: 'http://localhost:3006', mcpConnectionType: 'streamable-http'}, () => r('done')))`,
    returnByValue: true, awaitPromise: true
  }, sessionId);
  console.log("Config:", config.result?.result?.value);

  // Force inject content script
  const inject = await send("Runtime.evaluate", {
    expression: `new Promise(async r => {
      try {
        const tabs = await chrome.tabs.query({});
        const target = tabs.find(t => t.url && t.url.includes('chatgpt.com'));
        if (!target) { r('No ChatGPT tab'); return; }
        await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['content/index.iife.js'] });
        r('INJECTED into tab ' + target.id);
      } catch(e) { r('ERROR: ' + e.message); }
    })`,
    returnByValue: true, awaitPromise: true
  }, sessionId);
  console.log("Inject:", inject.result?.result?.value);

  // Now verify from the page side
  console.log("\nWaiting 3s for content script to initialize...");
  await new Promise(r => setTimeout(r, 3000));

  // Find page target and check
  const allTargets = await send("Target.getTargets");
  const pageTarget = allTargets.result?.targetInfos?.find((t: any) => t.url?.includes("chatgpt.com") && t.type === "page");
  if (pageTarget) {
    const pageAttach = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
    const pageSid = pageAttach.result?.sessionId;
    if (pageSid) {
      await send("Runtime.enable", {}, pageSid);
      await new Promise(r => setTimeout(r, 500));

      // Check execution contexts in the page
      const pageCheck = await send("Runtime.evaluate", {
        expression: `JSON.stringify({
          hasMcpStyles: [...document.querySelectorAll('style')].filter(s => s.textContent?.includes('function-call') || s.textContent?.includes('mcp-')).length,
          hasMcpElements: document.querySelectorAll('[data-function-call-id]').length,
          hasPrompt: !!document.querySelector('#prompt-textarea'),
        })`,
        returnByValue: true
      }, pageSid);
      console.log("\nPage check:", pageCheck.result?.result?.value);
    }
  }

  console.log("\n✅ Setup complete!");
  ws.close();
  process.exit(0);
}

ws.onopen = async () => {
  console.log("Connected to browser CDP");

  // Set auto-attach to catch service workers
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    
    // Handle auto-attached targets
    if (data.method === "Target.attachedToTarget") {
      const info = data.params?.targetInfo;
      console.log(`Auto-attached: [${info?.type}] ${info?.url?.substring(0, 80)}`);
      
      if (info?.url?.includes("fignfifoniblkonapihmkfakmlgkbkcf") && data.params?.sessionId) {
        onSwAttached(data.params.sessionId);
      }
    }
  });

  // Enable auto-attach for service workers
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "service_worker" }]
  });
  console.log("Auto-attach enabled for service workers");

  // Also try to get existing targets
  const existing = await send("Target.getTargets");
  const swTarget = existing.result?.targetInfos?.find((t: any) => 
    t.type === "service_worker" && t.url?.includes("fignfifoniblkonapihmkfakmlgkbkcf")
  );

  if (swTarget) {
    console.log("SW already exists, attaching...");
    const attached = await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
    if (attached.result?.sessionId) {
      await onSwAttached(attached.result.sessionId);
      return;
    }
  }

  // If SW not found, wake it up by sending a message to it
  console.log("SW not in targets. Waking it up via page...");
  
  // Find and attach to the page
  const pageTarget = existing.result?.targetInfos?.find((t: any) => t.url?.includes("chatgpt.com") && t.type === "page");
  if (pageTarget) {
    const pageAttached = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
    const pageSid = pageAttached.result?.sessionId;
    if (pageSid) {
      // Wake up the SW by trying to send a message to it
      await send("Runtime.evaluate", {
        expression: `try { chrome.runtime.sendMessage('fignfifoniblkonapihmkfakmlgkbkcf', {type: 'ping'}); } catch(e) {}`,
        returnByValue: true
      }, pageSid);
      console.log("Sent wake-up ping, waiting for SW to appear...");
    }
  }
  
  // Wait for auto-attach to trigger
  console.log("Waiting up to 10s for SW to wake up...");
  setTimeout(() => {
    if (!swSessionId) {
      console.log("❌ SW did not wake up. Extension may not be properly loaded.");
      ws.close();
      process.exit(1);
    }
  }, 10000);
};

setTimeout(() => { ws.close(); process.exit(1); }, 30000);
