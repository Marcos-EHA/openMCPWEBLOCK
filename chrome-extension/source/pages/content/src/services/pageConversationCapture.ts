import { mcpClient } from '../core/mcp-client'
import { logMessage } from '../utils/helpers'

type MessageRole = 'user' | 'assistant'

const CAPTURE_STATUS_INTERVAL_MS = 15_000
const CONVERSATION_CHECK_INTERVAL_MS = 1_000
const USER_SETTLE_DELAY_MS = 700
const ASSISTANT_SETTLE_DELAY_MS = 1_800

const MESSAGE_SELECTORS: Array<{ selector: string; role: MessageRole }> = [
  { selector: 'main [data-message-author-role="user"]', role: 'user' },
  { selector: 'main [data-message-author-role="assistant"]', role: 'assistant' },
  { selector: 'main [data-testid="user-message"]', role: 'user' },
  { selector: 'main [data-testid="assistant-message"]', role: 'assistant' },
  { selector: 'main [data-test-id="user-query"]', role: 'user' },
  { selector: 'main [data-test-id="model-response"]', role: 'assistant' },
]

interface PendingMessage {
  role: MessageRole
  text: string
  signature: string
  timer?: ReturnType<typeof setTimeout>
}

let observer: MutationObserver | undefined
let statusTimer: ReturnType<typeof setInterval> | undefined
let conversationTimer: ReturnType<typeof setInterval> | undefined
let captureEnabled = false
let sentinelReviewEnabled = false
let lastReportedError = ''
let lastConversationId = ''
let stopped = true
const pendingMessages = new Map<Element, PendingMessage>()
const capturedSignatures = new Set<string>()
const reviewedSignatures = new Set<string>()

function getVisibleMessageNodes(): Array<{ element: Element; role: MessageRole }> {
  const found = new Map<Element, MessageRole>()
  for (const { selector, role } of MESSAGE_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (element.closest('textarea, input, [contenteditable="true"]')) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) continue
      found.set(element, role)
    }
  }
  return [...found.entries()]
    .map(([element, role]) => ({ element, role }))
    .sort((left, right) => {
      const relation = left.element.compareDocumentPosition(right.element)
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
}

function getMessageText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('button, svg, input, textarea, [aria-hidden="true"]').forEach(node => node.remove())
  return (copy as HTMLElement).innerText?.trim() || copy.textContent?.trim() || ''
}

function hashMessage(role: MessageRole, position: number, text: string): string {
  const value = `${location.pathname}\u0000${role}\u0000${position}\u0000${text}`
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${first >>> 0}-${second >>> 0}`
}

function hasBusyAncestor(element: Element): boolean {
  return element.closest('[aria-busy="true"]') !== null
}

function baselineVisibleMessagesForSentinel(): void {
  getVisibleMessageNodes().forEach(({ element, role }, position) => {
    const text = getMessageText(element)
    if (text) reviewedSignatures.add(hashMessage(role, position, text))
  })
}

function scheduleCapture(element: Element, role: MessageRole, text: string, position: number): void {
  const previous = pendingMessages.get(element)
  if (previous?.role === role && previous.text === text) return
  if (previous) clearTimeout(previous.timer)

  const signature = hashMessage(role, position, text)
  const delay = role === 'assistant' ? ASSISTANT_SETTLE_DELAY_MS : USER_SETTLE_DELAY_MS
  const pending: PendingMessage = { role, text, signature }
  const attemptCapture = () => {
    const current = pendingMessages.get(element)
    if (current !== pending || (!captureEnabled && !sentinelReviewEnabled) || stopped) return
    if (hasBusyAncestor(element)) {
      pending.timer = setTimeout(attemptCapture, 1_000)
      return
    }
    const captureThisMessage = captureEnabled && !capturedSignatures.has(signature)
    const reviewThisMessage = sentinelReviewEnabled && !reviewedSignatures.has(signature)
    if (!captureThisMessage && !reviewThisMessage) {
      pendingMessages.delete(element)
      return
    }
    const actions: Array<{ kind: 'capture' | 'review'; promise: Promise<void> }> = []
    if (captureThisMessage) {
      capturedSignatures.add(signature)
      actions.push({ kind: 'capture', promise: mcpClient.sendWorkspaceContextCapture({
        action: 'capture',
        role,
        text,
        platformId: location.hostname,
        conversationId: lastConversationId,
      }).then(response => {
        if (response.isError) throw new Error(response.content?.map(item => item.text ?? '').join('\n') || 'MCP capture tool returned an error.')
        const result = parseToolResponse(response)
        if (result.omitted === true && result.reason === 'sensitive-content-omitted') return
        if (result.stored !== true) captureEnabled = false
      }) })
    }
    if (reviewThisMessage) {
      reviewedSignatures.add(signature)
      actions.push({ kind: 'review', promise: mcpClient.sendWorkspaceContextCapture({
        action: 'sentinel-review',
        role,
        text: text.slice(0, 6000),
        platformId: location.hostname,
        conversationId: lastConversationId,
      }).then(response => {
        if (response.isError) throw new Error(response.content?.map(item => item.text ?? '').join('\n') || 'Sentinel review returned an error.')
        const result = parseToolResponse(response)
        if (result.reason === 'instance-not-authorized') {
          sentinelReviewEnabled = false
        }
      }) })
    }
    void Promise.allSettled(actions.map(action => action.promise)).then(results => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const kind = actions[index]!.kind
          if (kind === 'capture') capturedSignatures.delete(signature)
          else reviewedSignatures.delete(signature)
          reportError(result.reason)
        }
      })
    }).finally(() => {
      if (pendingMessages.get(element) === pending) pendingMessages.delete(element)
    })
  }
  pending.timer = setTimeout(attemptCapture, delay)
  pendingMessages.set(element, pending)
}

function scanMessages(): void {
  if ((!captureEnabled && !sentinelReviewEnabled) || stopped) return
  getVisibleMessageNodes().forEach(({ element, role }, position) => {
    const text = getMessageText(element)
    if (text) scheduleCapture(element, role, text, position)
  })
}

function cancelPendingCaptures(): void {
  for (const pending of pendingMessages.values()) {
    if (pending.timer) clearTimeout(pending.timer)
  }
  pendingMessages.clear()
}

function checkConversation(): void {
  const conversationId = location.pathname
  if (conversationId === lastConversationId) return
  lastConversationId = conversationId
  cancelPendingCaptures()
  scanMessages()
}

function parseToolResponse(response: unknown): Record<string, unknown> {
  if (typeof response === 'string') {
    const parsed: unknown = JSON.parse(response)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  }
  if (response && typeof response === 'object') {
    const object = response as Record<string, unknown>
    if (typeof object.result === 'string') return parseToolResponse(object.result)
    if (Array.isArray(object.content)) {
      const text = object.content.find((item): item is { text: string } =>
        Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'),
      )?.text
      if (text) return parseToolResponse(text)
    }
    return object
  }
  throw new Error('Workspace capture status returned an unsupported MCP response.')
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (message !== lastReportedError) logMessage(`[PageConversationCapture] ${message}`)
  lastReportedError = message
}

async function refreshCaptureStatus(): Promise<void> {
  try {
    const conversationId = location.pathname
    if (conversationId !== lastConversationId) {
      lastConversationId = conversationId
      cancelPendingCaptures()
    }
    const response = await mcpClient.sendWorkspaceContextCapture({ action: 'status' })
    if (response.isError) throw new Error(response.content?.map(item => item.text ?? '').join('\n') || 'MCP status tool returned an error.')
    const status = parseToolResponse(response)
    const captureWasEnabled = captureEnabled
    const reviewWasEnabled = sentinelReviewEnabled
    captureEnabled = status.captureEnabled === true ||
      (status.captureEnabled === undefined && status.enabled === true)
    sentinelReviewEnabled = status.sentinelReviewEnabled === true
    if (sentinelReviewEnabled && !reviewWasEnabled) baselineVisibleMessagesForSentinel()
    lastReportedError = ''
    if (!captureEnabled && !sentinelReviewEnabled) cancelPendingCaptures()
    if ((captureEnabled && !captureWasEnabled) || (sentinelReviewEnabled && !reviewWasEnabled)) scanMessages()
  } catch (error) {
    captureEnabled = false
    sentinelReviewEnabled = false
    cancelPendingCaptures()
    reportError(error)
  }
}

export function startPageConversationCapture(): void {
  if (!stopped) return
  stopped = false
  lastConversationId = location.pathname
  observer = new MutationObserver(scanMessages)
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true })
  void refreshCaptureStatus()
  statusTimer = setInterval(() => void refreshCaptureStatus(), CAPTURE_STATUS_INTERVAL_MS)
  conversationTimer = setInterval(checkConversation, CONVERSATION_CHECK_INTERVAL_MS)
}

export function stopPageConversationCapture(): void {
  stopped = true
  captureEnabled = false
  sentinelReviewEnabled = false
  cancelPendingCaptures()
  observer?.disconnect()
  observer = undefined
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = undefined
  if (conversationTimer) clearInterval(conversationTimer)
  conversationTimer = undefined
}
