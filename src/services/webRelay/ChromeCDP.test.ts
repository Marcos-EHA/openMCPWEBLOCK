import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
// @ts-ignore — ws types are not installed in this workspace
import { WebSocketServer } from 'ws'
import {
  buildChromeLaunchArgs,
  captureRelayScreenshot,
  CDPConnection,
  ensureSAExtensionLoaded,
  findSAExtensionId,
  findExistingSAExtensionContext,
  waitForPlatformPageTarget,
  getInstanceIdentity,
  shouldStartChromeMinimized,
  shouldTransferMasterSession,
} from './ChromeCDP.js'

interface FakeChromeOptions {
  contexts?: Array<{ id: number; name: string; origin: string }>
  evaluate?: (expression: string) => unknown
  loadedExtensionId?: string
  initialServiceWorkerId?: string
  serviceWorkerManifestName?: string
  serviceWorkerIdentity?: Record<string, unknown> | null
}

async function startFakeChrome(
  tabs: Array<{ id: string; url: string }>,
  options: FakeChromeOptions = {},
) {
  let loadedExtensionId: string | undefined
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      const address = server.address()
      if (!address || typeof address === 'string') {
        response.writeHead(500).end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser`,
      }))
      return
    }
    if (request.url !== '/json/list' && request.url !== '/json') {
      response.writeHead(404).end()
      return
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      response.writeHead(500).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    const pageTargets = tabs.map(tab => ({
      ...tab,
      type: 'page',
      title: 'test page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/${tab.id}`,
    }))
    const activeExtensionId = loadedExtensionId ?? options.initialServiceWorkerId
    const serviceWorkerTarget = activeExtensionId && {
      type: 'service_worker',
      targetId: 'test-service-worker',
      title: options.initialServiceWorkerId ? 'Service Worker' : 'MCP SuperAssistant',
      url: `chrome-extension://${activeExtensionId}/background.js`,
    }
    response.end(JSON.stringify(request.url === '/json' && serviceWorkerTarget
      ? [...pageTargets, serviceWorkerTarget]
      : pageTargets))
  })
  const webSocketServer = new WebSocketServer({ noServer: true })
  const methods: string[] = []
  webSocketServer.on('connection', socket => {
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as {
        id: number
        method: string
        params?: Record<string, unknown>
        sessionId?: string
      }
      methods.push(message.method)
      if (message.method === 'Extensions.loadUnpacked') {
        loadedExtensionId = options.loadedExtensionId
      }
      if (message.method === 'Runtime.enable') {
        for (const context of options.contexts ?? [{
          id: 7,
          name: 'MCP SuperAssistant',
          origin: 'chrome-extension://test-extension',
        }]) {
          socket.send(JSON.stringify({
            method: 'Runtime.executionContextCreated',
            params: {
              context: {
                ...context,
                auxData: { isDefault: false, frameId: 'test-page' },
              },
            },
          }))
        }
      }
      const result = message.method === 'Page.captureScreenshot'
        ? { data: '/9j/2Q==' }
        : message.method === 'Target.getTargets'
          ? {
            targetInfos: [
              ...tabs.map(tab => ({
                targetId: tab.id,
                type: 'page',
                url: tab.url,
                title: 'test page',
              })),
              ...(loadedExtensionId ?? options.initialServiceWorkerId
                ? [{
                  targetId: 'test-service-worker',
                  type: 'service_worker',
                  url: `chrome-extension://${loadedExtensionId ?? options.initialServiceWorkerId}/background.js`,
                  title: 'Service Worker',
                }]
                : []),
            ],
          }
          : message.method === 'Target.attachToTarget'
            ? { sessionId: 'test-worker-session' }
            : message.method === 'Runtime.evaluate'
              ? {
                result: {
                  value: (JSON.parse(raw.toString()) as { params?: { expression?: string } })
                    .params?.expression?.includes('chrome.runtime.getManifest()')
                    ? JSON.stringify({
                      id: loadedExtensionId ?? options.initialServiceWorkerId,
                      name: options.serviceWorkerManifestName ?? 'MCP SuperAssistant',
                    })
                    : (JSON.parse(raw.toString()) as { params?: { expression?: string } })
                      .params?.expression?.includes("chrome.storage.local.get('mcp:instance-identity')")
                      ? JSON.stringify(options.serviceWorkerIdentity ?? null)
                    : options.evaluate?.(
                      (JSON.parse(raw.toString()) as { params?: { expression?: string } }).params?.expression ?? '',
                    ) ?? null,
                },
              }
              : message.method === 'Extensions.loadUnpacked'
                ? { id: options.loadedExtensionId }
                : {}
      socket.send(JSON.stringify({
        id: message.id,
        result,
      }))
    })
  })
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, connection => {
      webSocketServer.emit('connection', connection, request)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('Could not start fake Chrome CDP server.')
  }
  return {
    port: address.port,
    methods,
    close: async () => {
      await new Promise<void>(resolve => webSocketServer.close(() => resolve()))
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

describe('CDP execution-context inspection', () => {
  test('discovers locally loaded SuperAssistant by its manifest when Chrome gives it a dynamic ID', async () => {
    const chrome = await startFakeChrome(
      [{ id: 'platform', url: 'https://chatgpt.com/' }],
      {
        initialServiceWorkerId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        serviceWorkerManifestName: 'MCP SuperAssistant',
      },
    )
    try {
      await expect(findSAExtensionId(chrome.port)).resolves.toBe('aklgcdphknfhpmhdplmkgmjemojchcea')
    } finally {
      await chrome.close()
    }
  })

  test('recovers a Relay identity from a dynamic SuperAssistant extension ID', async () => {
    const identity = {
      schema: 1,
      instanceId: 'web-5640c370-3e4d-4212-bd30-2718cbbb2457',
      agentId: 'web-chatgpt-user-df9bdf6b-1d28-4e22-b6fe-cdab22774890',
      role: 'manual-user-1',
      platformId: 'chatgpt',
      profileDir: 'web-5640c370-3e4d-4212-bd30-2718cbbb2457',
      sessionMode: 'chrome-profile',
      chromeProfileDirectory: 'Profile 16',
      stampedAt: 1,
    }
    const chrome = await startFakeChrome(
      [{ id: 'platform', url: 'https://chatgpt.com/' }],
      {
        initialServiceWorkerId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        serviceWorkerManifestName: 'MCP SuperAssistant',
        serviceWorkerIdentity: identity,
      },
    )
    try {
      await expect(getInstanceIdentity(chrome.port)).resolves.toEqual(identity)
    } finally {
      await chrome.close()
    }
  })

  test('lists contexts for the connected page without evaluating page content', async () => {
    const chrome = await startFakeChrome([
      { id: 'platform', url: 'https://chatgpt.com/' },
    ])
    const connection = new CDPConnection(chrome.port)
    try {
      await connection.connect('platform')

      const contexts = await connection.listExecutionContexts()

      expect(contexts).toContainEqual(expect.objectContaining({
        id: 7,
        name: 'MCP SuperAssistant',
        origin: 'chrome-extension://test-extension',
      }))
      expect(chrome.methods).toContain('Runtime.enable')
    } finally {
      connection.close()
      await chrome.close()
    }
  })

  test('reuses a responsive SuperAssistant page context without reloading the extension', async () => {
    const chrome = await startFakeChrome(
      [{ id: 'platform', url: 'https://chatgpt.com/' }],
      {
        contexts: [{
          id: 7,
          name: 'MCP SuperAssistant',
          origin: 'chrome-extension://aklgcdphknfhpmhdplmkgmjemojchcea',
        }],
        evaluate: expression => expression.includes('mcp:get-server-config')
          ? { available: true }
          : null,
      },
    )
    try {
      await expect(findExistingSAExtensionContext(chrome.port, 'chatgpt')).resolves.toEqual({
        extensionId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        requiresPageReload: false,
      })
      expect(chrome.methods).toContain('Runtime.enable')
      expect(chrome.methods).toContain('Runtime.evaluate')
    } finally {
      await chrome.close()
    }
  })

  test('requests a page reload for an installed but invalidated SuperAssistant context', async () => {
    const chrome = await startFakeChrome(
      [{ id: 'platform', url: 'https://chatgpt.com/' }],
      {
        contexts: [{
          id: 7,
          name: 'MCP SuperAssistant',
          origin: 'chrome-extension://aklgcdphknfhpmhdplmkgmjemojchcea',
        }],
        evaluate: () => ({ available: false }),
      },
    )
    try {
      await expect(findExistingSAExtensionContext(chrome.port, 'chatgpt')).resolves.toEqual({
        extensionId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        requiresPageReload: true,
      })
    } finally {
      await chrome.close()
    }
  })

  test('waits briefly for the exact platform tab to appear during Chrome startup', async () => {
    const tabs: Array<{ id: string; url: string }> = []
    const chrome = await startFakeChrome(tabs, {
      contexts: [{
        id: 7,
        name: 'MCP SuperAssistant',
        origin: 'chrome-extension://aklgcdphknfhpmhdplmkgmjemojchcea',
      }],
      evaluate: expression => expression.includes('mcp:get-server-config')
        ? { available: true }
        : null,
    })
    const opening = findExistingSAExtensionContext(chrome.port, 'claude')
    const timer = setTimeout(() => tabs.push({ id: 'claude', url: 'https://claude.ai/' }), 100)
    try {
      await expect(opening).resolves.toEqual({
        extensionId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        requiresPageReload: false,
      })
    } finally {
      clearTimeout(timer)
      await chrome.close()
    }
  })

  test('reports observed page hosts when the requested platform tab never appears', async () => {
    const chrome = await startFakeChrome([
      { id: 'wrong-platform', url: 'https://chatgpt.com/' },
    ])
    try {
      await expect(waitForPlatformPageTarget(chrome.port, 'claude', 40, 10))
        .rejects.toThrow('observed page hosts: chatgpt.com')
    } finally {
      await chrome.close()
    }
  })

  test('requests a page reload after loading SuperAssistant into a new Chrome profile', async () => {
    const chrome = await startFakeChrome(
      [{ id: 'platform', url: 'https://chatgpt.com/' }],
      {
        contexts: [],
        loadedExtensionId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
      },
    )
    const extensionDir = mkdtempSync(join(tmpdir(), 'openmcp-chrome-extension-test-'))
    const previousSAPath = process.env.OPENMCP_SA_PATH
    writeFileSync(join(extensionDir, 'manifest.json'), '{}')
    process.env.OPENMCP_SA_PATH = extensionDir
    try {
      const context = await ensureSAExtensionLoaded(chrome.port, 'chatgpt')
      expect(context).toEqual({
        extensionId: 'aklgcdphknfhpmhdplmkgmjemojchcea',
        requiresPageReload: true,
      })
      expect(chrome.methods).toContain('Extensions.loadUnpacked')
    } finally {
      if (previousSAPath === undefined) delete process.env.OPENMCP_SA_PATH
      else process.env.OPENMCP_SA_PATH = previousSAPath
      rmSync(extensionDir, { recursive: true, force: true })
      await chrome.close()
    }
  })
})

describe('background Chrome launch policy', () => {
  test('keeps copied Chrome profiles visible for possible account sign-in', () => {
    expect(shouldStartChromeMinimized('chrome-profile')).toBe(false)
    expect(shouldStartChromeMinimized('clean')).toBe(true)
    expect(shouldStartChromeMinimized('chrome-profile', true)).toBe(true)
  })

  test('starts relays minimized with background execution throttling disabled', () => {
    const args = buildChromeLaunchArgs(9222, 'C:\\relay-profile')

    expect(args).toContain('--start-minimized')
    expect(args).toContain('--disable-background-timer-throttling')
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).toContain('--disable-renderer-backgrounding')
    expect(args).toContain('--disable-features=IntensiveWakeUpThrottling')
  })

  test('allows an explicitly interactive relay without relaxing background timer protections', () => {
    const args = buildChromeLaunchArgs(9223, 'C:\\relay-profile', false)

    expect(args).not.toContain('--start-minimized')
    expect(args).toContain('--disable-background-timer-throttling')
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).toContain('--disable-renderer-backgrounding')
    expect(args).toContain('--disable-features=IntensiveWakeUpThrottling')
  })
})

describe('Master Session transfer policy', () => {
  test('does not transfer account cookies when session mode is omitted', () => {
    expect(shouldTransferMasterSession('https://chatgpt.com/')).toBe(false)
  })

  test('does not transfer account cookies to clean guest relays', () => {
    expect(shouldTransferMasterSession('https://chatgpt.com/', 'clean')).toBe(false)
  })

  test('transfers account cookies only when authentication is explicitly selected', () => {
    expect(shouldTransferMasterSession('https://chatgpt.com/', 'authenticated')).toBe(true)
  })

  test('does not transfer Master cookies when using an isolated Chrome profile copy', () => {
    expect(shouldTransferMasterSession('https://chatgpt.com/', 'chrome-profile')).toBe(false)
  })

  test('never transfers ChatGPT cookies to a different platform URL', () => {
    expect(shouldTransferMasterSession('https://gemini.google.com/', 'authenticated')).toBe(false)
  })
})

describe('Relay viewport capture', () => {
  test('captures one supported platform tab without issuing navigation or focus commands', async () => {
    const chrome = await startFakeChrome([
      { id: 'chat-page', url: 'https://chatgpt.com/' },
    ])
    try {
      const screenshot = await captureRelayScreenshot('relay-test', chrome.port, 'chatgpt')
      expect(screenshot).toMatchObject({
        agentId: 'relay-test',
        platformId: 'chatgpt',
        mimeType: 'image/jpeg',
        data: '/9j/2Q==',
      })
      expect(chrome.methods).toEqual(['Page.captureScreenshot'])
    } finally {
      await chrome.close()
    }
  })

  test('refuses to choose between multiple tabs for the selected platform', async () => {
    const chrome = await startFakeChrome([
      { id: 'chat-page-one', url: 'https://chatgpt.com/' },
      { id: 'chat-page-two', url: 'https://chat.openai.com/' },
    ])
    try {
      await expect(captureRelayScreenshot('relay-test', chrome.port, 'chatgpt'))
        .rejects.toThrow(/Multiple ChatGPT pages found/i)
      expect(chrome.methods).toEqual([])
    } finally {
      await chrome.close()
    }
  })
})
