import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CDPConnection } from '../webRelay/ChromeCDP.js'
import { hasAntigravityConversation } from './LocalConversationDetector.js'
import type { LocalInstance } from './LocalInstanceManager.js'

export const NEW_ANTIGRAVITY_CONVERSATION = 'new'
const MESSAGE_INPUT = '[aria-label="Message input"]'
const MODEL_SELECTOR = '[data-testid="model-selector-trigger"]'
const SEND_BUTTON = '[data-testid="send-button"]'
const AGENT_RESPONSE = '[aria-label="Agent response"]'

interface AntigravityTab {
  id: string
  url: string
}

export interface AntigravityCDPConnection {
  listTabs(): Promise<AntigravityTab[]>
  connect(tabId: string): Promise<void>
  send(method: string, params?: Record<string, unknown>): Promise<any>
  evaluate(expression: string): Promise<unknown>
  close(): void
}

export interface AntigravityControllerDependencies {
  readDevToolsPort(): number
  getPortOwner(port: number): Promise<number>
  createConnection(port: number): AntigravityCDPConnection
  hasConversation(conversationId: string): Promise<boolean>
  responseTimeoutMs: number
  responseStableMs: number
  responsePollIntervalMs: number
}

export interface AntigravityConversationState {
  conversationId: string
  model: string
}

export interface AntigravitySendResult extends AntigravityConversationState {
  delivery: 'submitted' | 'unknown'
  responseStatus: 'received' | 'pending'
  response?: string
  verificationError?: string
}

const dependencies: AntigravityControllerDependencies = {
  readDevToolsPort,
  getPortOwner: getWindowsPortOwner,
  createConnection: port => new CDPConnection(port),
  hasConversation: hasAntigravityConversation,
  responseTimeoutMs: 120000,
  responseStableMs: 1500,
  responsePollIntervalMs: 500,
}

function readDevToolsPort(): number {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set; Antigravity DevTools cannot be located.')
  const filePath = join(appData, 'Antigravity', 'DevToolsActivePort')
  if (!existsSync(filePath)) {
    throw new Error('Antigravity DevToolsActivePort is missing. Direct conversation control is unavailable.')
  }
  const value = readFileSync(filePath, 'utf8').split(/\r?\n/, 1)[0]?.trim()
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Antigravity DevToolsActivePort does not contain a valid local port.')
  }
  return port
}

function getWindowsPortOwner(port: number): Promise<number> {
  if (process.platform !== 'win32') {
    throw new Error('Antigravity process-to-DevTools verification is currently supported on Windows only.')
  }
  return new Promise((resolve, reject) => {
    const command =
      `$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | ` +
      'Select-Object -ExpandProperty OwningProcess -Unique); $owners -join \',\''
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: 5000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Could not verify the Antigravity DevTools process: ${stderr.trim() || error.message}`))
        return
      }
      const owners = stdout.trim().split(',').filter(Boolean).map(Number)
      if (owners.length !== 1 || !Number.isInteger(owners[0]) || owners[0] <= 0) {
        reject(new Error('Antigravity DevTools port is not owned by exactly one local process.'))
        return
      }
      resolve(owners[0])
    })
  })
}

async function withAntigravityPage<T>(
  instance: LocalInstance,
  action: (connection: AntigravityCDPConnection, origin: string) => Promise<T>,
  overrides: Partial<AntigravityControllerDependencies> = {},
): Promise<T> {
  const deps = { ...dependencies, ...overrides }
  if (instance.platformId !== 'antigravity' || instance.status !== 'ready' ||
    !Number.isInteger(instance.pid) || !instance.pid) {
    throw new Error('A ready Antigravity local instance with a known process ID is required.')
  }
  const port = deps.readDevToolsPort()
  const ownerPid = await deps.getPortOwner(port)
  if (ownerPid !== instance.pid) {
    throw new Error(
      `Antigravity DevTools belongs to process ${ownerPid}, not the selected instance ${instance.pid}; no action was taken.`,
    )
  }

  const connection = deps.createConnection(port)
  try {
    const tab = (await connection.listTabs()).find(candidate => {
      try {
        const url = new URL(candidate.url)
        return url.protocol === 'https:' && url.hostname === '127.0.0.1'
      } catch {
        return false
      }
    })
    if (!tab) throw new Error('The selected Antigravity process has no local application page open.')
    await connection.connect(tab.id)
    await connection.send('Page.enable')
    await connection.send('Runtime.enable')
    return await action(connection, new URL(tab.url).origin)
  } finally {
    connection.close()
  }
}

async function waitForPageState(
  connection: AntigravityCDPConnection,
  expression: string,
  description: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await connection.evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Antigravity did not reach the expected state: ${description}.`)
}

async function selectConversation(
  connection: AntigravityCDPConnection,
  origin: string,
  conversationId: string,
  hasConversation: (id: string) => Promise<boolean>,
): Promise<string> {
  if (conversationId === NEW_ANTIGRAVITY_CONVERSATION) {
    await connection.send('Page.navigate', { url: new URL('/', origin).toString() })
    await waitForPageState(
      connection,
      `location.pathname === '/' && Boolean(document.querySelector('${MESSAGE_INPUT}'))`,
      'new conversation route and message composer',
    )
    return ''
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) {
    throw new Error('Invalid Antigravity conversation ID.')
  }
  if (!(await hasConversation(conversationId))) {
    throw new Error('That conversation ID is not present in Antigravity history; refresh the list and choose a current chat.')
  }
  const targetUrl = new URL(`/c/${encodeURIComponent(conversationId)}`, origin).toString()
  await connection.send('Page.navigate', { url: targetUrl })
  const expectedPath = `/c/${encodeURIComponent(conversationId)}`
  await waitForPageState(
    connection,
    `location.pathname === ${JSON.stringify(expectedPath)} && ` +
      `Boolean(document.querySelector('${MESSAGE_INPUT}')?.isContentEditable)`,
    'the selected conversation and message composer',
  )
  return conversationId
}

async function readSelectedModel(connection: AntigravityCDPConnection): Promise<string> {
  const model = await connection.evaluate(
    `(()=>{const selector=document.querySelector('${MODEL_SELECTOR}');` +
      `return selector?.getAttribute('aria-label') || selector?.textContent || ''})()`,
  )
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('Antigravity did not expose its selected model; no prompt was sent.')
  }
  return model.replace(/^Select model, current:\s*/i, '').trim()
}

async function readAgentResponseState(
  connection: AntigravityCDPConnection,
): Promise<{ text: string; isGenerating: boolean }> {
  const state = await connection.evaluate(
    `(()=>{const nodes=[...document.querySelectorAll('${AGENT_RESPONSE}')];` +
      `const stopSelectors='[data-testid*="stop" i],[data-testid*="cancel" i],button[aria-label*="stop" i],button[title*="stop" i]';` +
      `const isGenerating=[...document.querySelectorAll(stopSelectors)].some(el=>{const r=el.getBoundingClientRect();` +
      `return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'});` +
      `return JSON.stringify({text:nodes.length?nodes[nodes.length-1].innerText.trim():'',isGenerating})})()`,
  )
  if (typeof state !== 'string') return { text: '', isGenerating: false }
  try {
    const parsed = JSON.parse(state) as { text?: unknown; isGenerating?: unknown }
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      isGenerating: parsed.isGenerating === true,
    }
  } catch {
    throw new Error('Antigravity returned invalid response state from its conversation view.')
  }
}

async function waitForAgentResponse(
  connection: AntigravityCDPConnection,
  previousResponse: string,
  timeoutMs: number,
  stableMs: number,
  pollIntervalMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let candidate = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    const state = await readAgentResponseState(connection)
    const response = state.text
    if (response && response !== previousResponse) {
      if (response !== candidate) {
        candidate = response
        stableSince = Date.now()
      } else if (!state.isGenerating && Date.now() - stableSince >= stableMs) {
        return response.length > 30000
          ? `${response.slice(0, 30000)}\n\n[Respuesta truncada en Workspace; la respuesta completa permanece en Antigravity.]`
          : response
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return undefined
}

export async function openAntigravityConversation(
  instance: LocalInstance,
  conversationId: string,
  overrides: Partial<AntigravityControllerDependencies> = {},
): Promise<AntigravityConversationState> {
  const deps = { ...dependencies, ...overrides }
  return withAntigravityPage(instance, async (connection, origin) => {
    const selectedId = await selectConversation(connection, origin, conversationId, deps.hasConversation)
    await waitForPageState(
      connection,
      `Boolean(document.querySelector('${MODEL_SELECTOR}'))`,
      'the model selector',
    )
    return { conversationId: selectedId, model: await readSelectedModel(connection) }
  }, overrides)
}

export async function sendAntigravityPrompt(
  instance: LocalInstance,
  conversationId: string,
  prompt: string,
  expectedModel: string,
  overrides: Partial<AntigravityControllerDependencies> = {},
): Promise<AntigravitySendResult> {
  if (!prompt.trim() || prompt.length > 8000) {
    throw new Error('Antigravity prompts must contain between 1 and 8,000 characters.')
  }
  if (!expectedModel.trim()) {
    throw new Error('The model must be verified by opening this conversation before sending.')
  }
  const deps = { ...dependencies, ...overrides }
  return withAntigravityPage(instance, async (connection, origin) => {
    const selectedId = await selectConversation(connection, origin, conversationId, deps.hasConversation)
    const model = await readSelectedModel(connection)
    if (expectedModel && model !== expectedModel) {
      throw new Error(
        `This conversation was last verified with "${expectedModel}", but Antigravity currently shows "${model}". ` +
        'Reload the conversation details before sending; no prompt was entered or sent.',
      )
    }
    const previousResponse = (await readAgentResponseState(connection)).text

    const editorReady = await connection.evaluate(
      `(()=>{const editor=document.querySelector('${MESSAGE_INPUT}');if(!editor?.isContentEditable)return false;` +
      `if(editor.textContent?.trim())return false;editor.focus();return document.activeElement===editor})()`,
    )
    if (!editorReady) {
      throw new Error('The Antigravity composer is not editable or contains an existing draft; clear it before sending.')
    }
    await connection.send('Input.insertText', { text: prompt })
    const exactPromptEntered = await connection.evaluate(
      `document.querySelector('${MESSAGE_INPUT}')?.textContent === ${JSON.stringify(prompt)}`,
    )
    if (!exactPromptEntered) {
      throw new Error('Antigravity did not accept the exact prompt text; no send action was taken. Check the composer before retrying.')
    }

    const readyToSend = await connection.evaluate(
      `(()=>{const button=document.querySelector('${SEND_BUTTON}');` +
      `return location.pathname === ${JSON.stringify(
        selectedId ? `/c/${encodeURIComponent(selectedId)}` : '/',
      )} && Boolean(button && !button.disabled)})()`,
    )
    if (!readyToSend) {
      throw new Error('Antigravity changed the target or disabled sending; no send action was taken. Check the composer before retrying.')
    }
    const expectedPath = selectedId ? `/c/${encodeURIComponent(selectedId)}` : '/'
    const clickResult = await connection.evaluate(
      `(()=>{const button=document.querySelector('${SEND_BUTTON}');` +
        `const editor=document.querySelector('${MESSAGE_INPUT}');` +
        `const selector=document.querySelector('${MODEL_SELECTOR}');` +
        `const model=selector?.getAttribute('aria-label') || selector?.textContent || '';` +
        `if(location.pathname!==${JSON.stringify(expectedPath)})return 'target-changed';` +
        `if(model.replace(/^Select model, current:\\s*/i,'').trim()!==${JSON.stringify(model)})return 'model-changed';` +
        `if(editor?.textContent!==${JSON.stringify(prompt)})return 'prompt-changed';` +
        `if(!button||button.disabled)return 'send-unavailable';button.click();return 'clicked'})()`,
    )
    if (clickResult !== 'clicked') {
      throw new Error(
        `Antigravity stopped the send because ${String(clickResult)}; no send action was taken. ` +
        'Check the selected chat, model, and composer before retrying.',
      )
    }

    try {
      await waitForPageState(
        connection,
        `document.querySelector('${MESSAGE_INPUT}')?.textContent?.trim() === ''`,
        'Antigravity to accept the message',
        5000,
      )
      const response = await waitForAgentResponse(
        connection,
        previousResponse,
        deps.responseTimeoutMs,
        deps.responseStableMs,
        deps.responsePollIntervalMs,
      )
      if (selectedId) {
        return {
          conversationId: selectedId,
          model,
          delivery: 'submitted',
          responseStatus: response ? 'received' : 'pending',
          ...(response ? { response } : {}),
          ...(!response ? { verificationError: 'The prompt was sent, but Antigravity did not show a stable agent response before the timeout.' } : {}),
        }
      }
      await waitForPageState(
        connection,
        `Boolean(location.pathname.match(/^\\/c\\/[a-zA-Z0-9_-]{1,128}$/))`,
        'Antigravity to assign an ID to the new conversation',
        5000,
      )
      const createdConversationId = await connection.evaluate(
        `(()=>{const match=location.pathname.match(/^\\/c\\/([a-zA-Z0-9_-]{1,128})$/);` +
          `return match ? decodeURIComponent(match[1]) : ''})()`,
      )
      if (typeof createdConversationId !== 'string' || !createdConversationId) {
        return {
          conversationId: '',
          model,
          delivery: 'unknown',
          responseStatus: 'pending',
          verificationError: 'Antigravity cleared the composer but did not expose the new conversation ID.',
        }
      }
      return {
        conversationId: createdConversationId,
        model,
        delivery: 'submitted',
        responseStatus: response ? 'received' : 'pending',
        ...(response ? { response } : {}),
        ...(!response ? { verificationError: 'The prompt was sent, but Antigravity did not show a stable agent response before the timeout.' } : {}),
      }
    } catch (error) {
      return {
        conversationId: selectedId,
        model,
        delivery: 'unknown',
        responseStatus: 'pending',
        verificationError: error instanceof Error ? error.message : String(error),
      }
    }
  }, overrides)
}
