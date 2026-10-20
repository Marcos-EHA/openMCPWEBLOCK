/**
 * Check extension service worker logs and force content script injection
 */
const CDP = "http://localhost:9222";

async function main() {
  // Get all targets including service workers (need special flag)
  const targets = await (await fetch(`${CDP}/json`)).json();
  const allTargets = await (await fetch(`${CDP}/json/list`)).json();
  
  console.log("=== All targets ===");
  for (const t of allTargets) {
    console.log(`  [${t.type}] ${t.title?.substring(0, 50)} → ${t.url?.substring(0, 80)}`);
  }
  
  // Find ChatGPT page
  const page = targets.find((t: any) => t.url?.includes("chatgpt.com") && t.type === "page");
  if (!page) { console.error("No ChatGPT page"); return; }
  
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>(r => { ws.onopen = () => r(); });
  
  let nextId = 1;
  function send(method: string, params: any = {}): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (data.id === id) {
          ws.removeEventListener("message", handler);
          resolve(data.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error(`Timeout: ${method}`)); }, 10000);
    });
  }
  
  // Enable console and check for errors
  await send("Console.enable");
  await send("Runtime.enable");
  
  // Get all execution contexts - content scripts show as separate contexts
  const contexts = await send("Runtime.evaluate", {
    expression: "1+1",
    returnByValue: true
  });
  console.log("\n=== Main world eval test ===", contexts?.result?.value);
  
  // Check if there are console errors
  console.log("\n=== Checking for errors ===");
  const errorCheck = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      url: location.href,
      readyState: document.readyState,
      bodyChildren: document.body?.children?.length || 0,
    })`,
    returnByValue: true,
  });
  console.log("Page state:", errorCheck?.result?.value);
  
  // The key insight: content scripts run in ISOLATED worlds
  // Let's enumerate all execution contexts
  console.log("\n=== Listing all JavaScript execution contexts ===");
  
  // We need to listen for executionContextCreated events
  // But since the page is already loaded, let's use a different approach
  // Navigate the page to trigger content script re-injection
  
  // First, let's try programmatic content script injection via the service worker
  // But we don't have access to the SW from the page context
  
  // Instead, let's check the extension ID and try to use chrome.debugger
  // Actually, the simplest: reload and capture console
  
  // Collect console messages
  const consoleMessages: string[] = [];
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.method === "Console.messageAdded") {
      consoleMessages.push(`[${data.params?.message?.level}] ${data.params?.message?.text?.substring(0, 150)}`);
    }
    if (data.method === "Runtime.consoleAPICalled") {
      const args = data.params?.args?.map((a: any) => a.value || a.description || a.type).join(" ");
      consoleMessages.push(`[console] ${args?.substring(0, 150)}`);
    }
  });
  
  await send("Log.enable");
  
  // Reload the page
  console.log("\nReloading page and capturing console output...");
  await send("Page.reload", { ignoreCache: true });
  
  // Wait for content scripts to load
  await new Promise(r => setTimeout(r, 10000));
  
  // Print captured console messages
  console.log(`\n=== Console Messages (${consoleMessages.length} captured) ===`);
  for (const msg of consoleMessages.slice(0, 30)) {
    console.log(`  ${msg}`);
  }
  
  // Final SA check
  console.log("\n=== Final SA Check ===");
  const finalCheck = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      mcpClient: typeof window.mcpClient,
      saClasses: [...new Set([...document.querySelectorAll('*')].filter(e => e.className?.toString().match?.(/mcp|superassist|function.call|sa-/i)).map(e => e.tagName + '.' + e.className.toString().substring(0,40)))].slice(0,10),
      injectedStyles: [...document.querySelectorAll('style')].filter(s => s.textContent?.includes('mcp') || s.textContent?.includes('function-call')).length,
      allStyleTags: document.querySelectorAll('style').length,
    })`,
    returnByValue: true,
  });
  console.log("Final:", finalCheck?.result?.value);
  
  ws.close();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
