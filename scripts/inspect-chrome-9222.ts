async function inspect() {
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

  // Find extensions tab or create one
  const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json())
  let extTab = targets.find((t: any) => t.url.includes('chrome://extensions'))
  let targetId = extTab?.id

  if (!targetId) {
    const newTab = await send('Target.createTarget', { url: 'chrome://extensions' })
    targetId = newTab.targetId
    await new Promise(r => setTimeout(r, 1500))
  }

  console.log('Extensions targetId:', targetId)

  // Attach
  const att = await send('Target.attachToTarget', { targetId, flatten: true })
  console.log('Attached sessionId:', att.sessionId)

  // Evaluate chrome.developerPrivate.getExtensionsInfo
  const evalRes = await send('Runtime.evaluate', {
    expression: `new Promise(resolve => {
      if (typeof chrome !== 'undefined' && chrome.developerPrivate && chrome.developerPrivate.getExtensionsInfo) {
        chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, info => {
          resolve(info.map(i => ({
            id: i.id,
            name: i.name,
            version: i.version,
            state: i.state,
            installWarnings: i.installWarnings,
            manifestErrors: i.manifestErrors,
            runtimeErrors: i.runtimeErrors,
            views: i.views,
            error: i.error
          })));
        });
      } else {
        resolve({ error: 'chrome.developerPrivate not available in this context' });
      }
    })`,
    awaitPromise: true,
    returnByValue: true
  }, att.sessionId)

  console.log('=== EXTENSIONS INFO ===')
  console.log(JSON.stringify(evalRes.result?.value, null, 2))

  bws.close()
}

inspect().catch(console.error)
