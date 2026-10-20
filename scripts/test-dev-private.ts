async function testDeveloperPrivate() {
  const targets = await fetch('http://127.0.0.1:9226/json/list').then(r => r.json())
  const extPage = targets.find((t: any) => t.url.includes('chrome://extensions'))
  if (!extPage) {
    console.error('No chrome://extensions page found')
    return
  }

  const ws = new WebSocket(extPage.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = () => r(null) })

  // Evaluate developerPrivate in chrome://extensions page
  const evalExpr = `(() => {
    return {
      hasDeveloperPrivate: typeof chrome !== 'undefined' && typeof chrome.developerPrivate !== 'undefined',
      methods: typeof chrome !== 'undefined' && chrome.developerPrivate ? Object.keys(chrome.developerPrivate) : []
    };
  })()`

  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: evalExpr, returnByValue: true }
  }))

  const res1 = await new Promise(res => {
    ws.onmessage = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 1) res(d.result?.result?.value)
    }
  })
  console.log('chrome.developerPrivate check:', JSON.stringify(res1, null, 2))

  ws.close()
}

testDeveloperPrivate().catch(console.error)
