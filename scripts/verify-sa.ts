// Full SA verification via CDP - check content script, configure server, test tool
const WS_URL = process.argv[2] || "";
if (!WS_URL) { console.error("Usage: bun run verify-sa.ts <ws-url>"); process.exit(1); }

const ws = new WebSocket(WS_URL);
let nextId = 1;

function cdp(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.id === id) { ws.removeEventListener("message", handler); resolve(data); }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener("message", handler); resolve({ timeout: true }); }, 8000);
  });
}

ws.onopen = async () => {
  console.log("=== SA Verification ===\n");
  
  // 1. Check page state
  const pageState = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      url: location.href,
      readyState: document.readyState,
      hasPrompt: !!document.querySelector('#prompt-textarea, .ProseMirror, textarea'),
      styleCount: document.querySelectorAll('style').length,
      scriptCount: document.querySelectorAll('script').length,
    })`,
    returnByValue: true,
  });
  console.log("1. Page:", pageState.result?.result?.value);

  // 2. Check if content script injected (SA creates a contextBridge)
  // Content scripts run in ISOLATED world - we can't see their globals from MAIN world
  // But they DO inject DOM elements. Let's check for SA's telltale signs:
  const saCheck = await cdp("Runtime.evaluate", {
    expression: `(() => {
      // SA injects styles for function call rendering
      const styles = [...document.querySelectorAll('style')];
      const saStyles = styles.filter(s => {
        const t = s.textContent || '';
        return t.includes('function-call') || t.includes('mcp-') || t.includes('execute-btn') || t.includes('loading-indicator');
      });
      
      // SA also uses data attributes
      const mcpElements = document.querySelectorAll('[data-mcp-tool], [data-function-call-id], [class*="mcp-"]');
      
      // Check for SA sidebar/popover
      const saContainers = document.querySelectorAll('#mcp-popover-container, [class*="mcp-popover"], [class*="sa-sidebar"]');
      
      // Check all injected scripts (SA injects render_prescript via script tag)
      const injectedScripts = [...document.querySelectorAll('script[src*="chrome-extension"]')].map(s => s.src);
      
      return JSON.stringify({
        saStyles: saStyles.length,
        saStylePreview: saStyles.map(s => s.textContent?.substring(0, 80)).slice(0, 2),
        mcpElements: mcpElements.length,
        saContainers: saContainers.length,
        injectedScripts: injectedScripts.slice(0, 5),
        totalStyles: styles.length,
      });
    })()`,
    returnByValue: true,
  });
  console.log("2. SA injection:", saCheck.result?.result?.value);

  // 3. Try to wake up the service worker by navigating to its URL
  // Actually, let's check the extension's storage to see if it's configured
  // We can't access chrome.storage from main world, but we can trigger it via
  // window.postMessage which the content script might listen to
  
  // 4. Check if there's a connection indicator from SA
  const connectionCheck = await cdp("Runtime.evaluate", {
    expression: `(() => {
      // SA typically shows a connection status somewhere
      // Check for any elements that mention "connected", "server", or "MCP"
      const allText = document.body?.innerText || '';
      const hasMcpText = allText.toLowerCase().includes('mcp') || allText.toLowerCase().includes('superassistant');
      
      // Check for floating action buttons or toolbar
      const fixedElements = [...document.querySelectorAll('*')].filter(el => {
        const style = getComputedStyle(el);
        return style.position === 'fixed' && el.offsetWidth > 0 && el.offsetHeight > 0 && el.offsetHeight < 200;
      });
      
      return JSON.stringify({
        hasMcpText,
        fixedElements: fixedElements.length,
        fixedElementInfo: fixedElements.map(e => ({
          tag: e.tagName,
          class: e.className?.toString()?.substring(0, 40),
          id: e.id,
          size: e.offsetWidth + 'x' + e.offsetHeight,
        })).slice(0, 5),
      });
    })()`,
    returnByValue: true,
  });
  console.log("3. Connection:", connectionCheck.result?.result?.value);
  
  // 5. List ALL execution contexts (to find the isolated content script world)
  await cdp("Runtime.enable");
  await new Promise(r => setTimeout(r, 500));
  
  // Enumerate execution contexts  
  const contexts: any[] = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.method === "Runtime.executionContextCreated") {
      contexts.push(data.params.context);
    }
  });
  
  // Trigger context enumeration by disabling and re-enabling
  await cdp("Runtime.disable");
  await cdp("Runtime.enable");
  await new Promise(r => setTimeout(r, 1000));
  
  console.log(`\n4. Execution Contexts: ${contexts.length}`);
  for (const ctx of contexts) {
    console.log(`  [${ctx.id}] ${ctx.name || 'unnamed'} | origin: ${ctx.origin?.substring(0, 50)} | aux: ${JSON.stringify(ctx.auxData || {})}`);
  }
  
  // If we find an extension context, try to evaluate in it
  const extContext = contexts.find(c => c.origin?.includes("chrome-extension://"));
  if (extContext) {
    console.log(`\n5. Found extension context! ID: ${extContext.id}`);
    const extEval = await cdp("Runtime.evaluate", {
      expression: `JSON.stringify({
        mcpClient: typeof window.mcpClient,
        chromeRuntime: typeof chrome?.runtime?.sendMessage,
        connected: typeof window.__mcpConnected,
      })`,
      contextId: extContext.id,
      returnByValue: true,
    });
    console.log("Extension context eval:", extEval.result?.result?.value);
  } else {
    console.log("\n5. No extension execution context found among:", contexts.map(c => c.origin).join(", "));
  }

  ws.close();
  process.exit(0);
};

setTimeout(() => { console.log("Global timeout"); ws.close(); process.exit(1); }, 20000);
