async function inspect() {
  const tab = await fetch('http://127.0.0.1:9226/json/new?chrome://extensions', { method: 'PUT' }).then(r => r.json())
  console.log('Opened tab:', tab.id, tab.webSocketDebuggerUrl)
  await new Promise(r => setTimeout(r, 2000))
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = () => r(null) })

  const evalExpr = `(() => {
    const mgr = document.querySelector('extensions-manager');
    const shadow = mgr ? mgr.shadowRoot : null;
    const itemList = shadow ? shadow.querySelector('extensions-item-list') : null;
    const items = itemList && itemList.shadowRoot ? itemList.shadowRoot.querySelectorAll('extensions-item') : [];
    return Array.from(items).map(i => {
      const isr = i.shadowRoot;
      return {
        id: i.id,
        name: isr ? isr.querySelector('#name')?.textContent?.trim() : null,
        description: isr ? isr.querySelector('#description')?.textContent?.trim() : null,
        version: isr ? isr.querySelector('#version')?.textContent?.trim() : null,
        inspectUrl: isr ? isr.querySelector('.inspect-views a')?.textContent?.trim() : null
      };
    });
  })()`

  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: evalExpr, returnByValue: true }
  }))

  ws.onmessage = (e: MessageEvent) => {
    const d = JSON.parse(e.data)
    if (d.id === 1) {
      console.log('Extensions found in Chrome:', JSON.stringify(d.result?.result?.value, null, 2))
      ws.close()
      process.exit(0)
    }
  }
}

inspect().catch(console.error)
