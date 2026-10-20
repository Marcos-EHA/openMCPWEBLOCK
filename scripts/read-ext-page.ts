async function readExtensionsPage() {
  const ver = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json())
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(r => bws.onopen = () => r(null))

  let id = 1
  function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const curId = id++
    return new Promise((resolve, reject) => {
      const h = (ev: MessageEvent) => {
        const d = JSON.parse(ev.data)
        if (d.id === curId) {
          bws.removeEventListener('message', h)
          if (d.error) reject(new Error(JSON.stringify(d.error)))
          else resolve(d.result)
        }
      }
      bws.addEventListener('message', h)
      const msg: any = { id: curId, method, params }
      if (sessionId) msg.sessionId = sessionId
      bws.send(JSON.stringify(msg))
    })
  }

  const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
  const extTab = targets.find((t: any) => t.url.includes('chrome://extensions'))
  if (!extTab) {
    console.log('No extensions tab found')
    return
  }

  const att = await send('Target.attachToTarget', { targetId: extTab.id, flatten: true })

  // Pierce shadow DOM
  const script = `(() => {
    function getAllText(root) {
      let texts = [];
      let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
      let n;
      while (n = walker.nextNode()) {
        const t = n.textContent.trim();
        if (t) texts.push(t);
      }
      // Check shadow roots
      let allElements = root.querySelectorAll('*');
      for (let el of allElements) {
        if (el.shadowRoot) {
          texts = texts.concat(getAllText(el.shadowRoot));
        }
      }
      return texts;
    }
    return getAllText(document.body);
  })()`

  const evalRes = await send('Runtime.evaluate', {
    expression: script,
    returnByValue: true
  }, att.sessionId)

  console.log('=== TEXT CONTENT ON chrome://extensions ===')
  console.log(evalRes.result?.value)

  bws.close()
}

readExtensionsPage().catch(console.error)
