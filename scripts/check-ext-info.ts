async function checkExts() {
  const targets = await fetch('http://127.0.0.1:9226/json/list').then(r => r.json())
  const extPage = targets.find((t: any) => t.url.includes('chrome://extensions'))
  const ws = new WebSocket(extPage.webSocketDebuggerUrl)
  await new Promise(r => { ws.onopen = () => r(null) })

  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `new Promise(resolve => {
        chrome.developerPrivate.getExtensionsInfo(info => resolve(info.map(i => ({id: i.id, name: i.name, state: i.state, views: i.views}))));
      })`,
      awaitPromise: true,
      returnByValue: true
    }
  }))

  const res = await new Promise(res => {
    ws.onmessage = (e: MessageEvent) => {
      const d = JSON.parse(e.data)
      if (d.id === 1) res(d.result?.result?.value)
    }
  })
  console.log('Extensions info from developerPrivate:', JSON.stringify(res, null, 2))
  ws.close()
}

checkExts().catch(console.error)
