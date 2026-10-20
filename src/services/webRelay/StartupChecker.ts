/**
 * StartupChecker — Verifies the environment when Web Relay mode starts.
 *
 * Checks:
 *  1. Chrome running with debug port (9333)?
 *  2. Which profile is active?
 *  3. SA extension detected?
 *  4. User logged in to AI platform?
 *  5. MCP SSE Server port available?
 *  6. Available tabs/platforms
 *
 * Returns a structured result that WebRelayProvider uses to decide
 * the operating mode (SA mode vs CDP fallback).
 */

import { CDPConnection } from './ChromeCDP.js'
import type { IncomingMessage } from 'http'
import { MCP_PORT } from '../mcpServer/mcpPort.js'
import { verifyClaudeAuth } from './session/ClaudeAuthVerifier.js'

export interface StartupCheckResult {
  chrome: {
    running: boolean
    debugPortActive: boolean
    port: number
  }
  profile: {
    detected: boolean
    name: string | null
  }
  superAssistant: {
    installed: boolean
    mcpConnected: boolean
  }
  login: {
    detected: boolean
    platform: string | null
  }
  mcpServer: {
    portAvailable: boolean
    port: number
  }
  tabs: Array<{
    id: string
    url: string
    title: string
  }>
  recommendation: 'sa_mode' | 'cdp_fallback' | 'needs_chrome' | 'needs_login' | 'login_unknown'
  messages: string[]
}

const CDP_PORT = 9222
export async function runStartupCheck(port: number = CDP_PORT): Promise<StartupCheckResult> {
  let loginStateUnknown = false
  const result: StartupCheckResult = {
    chrome: { running: false, debugPortActive: false, port },
    profile: { detected: false, name: null },
    superAssistant: { installed: false, mcpConnected: false },
    login: { detected: false, platform: null },
    mcpServer: { portAvailable: false, port: MCP_PORT },
    tabs: [],
    recommendation: 'needs_chrome',
    messages: [],
  }

  // 1. Check if Chrome debug port is active
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    if (resp.ok) {
      result.chrome.running = true
      result.chrome.debugPortActive = true
      result.messages.push('✓ Chrome debug port active')
    }
  } catch {
    // Check if Chrome process is running at all
    try {
      const { execSync } = await import('child_process')
      const ps = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
        encoding: 'utf-8',
        timeout: 3000,
      })
      if (ps.includes('chrome.exe')) {
        result.chrome.running = true
        result.messages.push('⚠ Chrome running but WITHOUT debug port')
        result.messages.push(`  → Close Chrome and relaunch with: --remote-debugging-port=${port}`)
        result.messages.push('  → Or let openMCPWEBLOCK launch Chrome automatically')
      } else {
        result.messages.push('✗ Chrome not running')
        result.messages.push(`  → Launch Chrome with: --remote-debugging-port=${port}`)
      }
    } catch {
      result.messages.push('✗ Cannot detect Chrome')
    }
  }

  // 2. List tabs if debug port is active
  if (result.chrome.debugPortActive) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
      const tabs: any[] = await resp.json()
      result.tabs = tabs
        .filter((t: any) => t.type === 'page')
        .map((t: any) => ({
          id: t.id,
          url: t.url,
          title: t.title || '',
        }))
      result.messages.push(`✓ ${result.tabs.length} tab(s) detected`)
    } catch {
      result.messages.push('⚠ Could not list tabs')
    }
  }

  // 3. Check profile & SA & login via CDP
  if (result.chrome.debugPortActive) {
    let cdp: CDPConnection | null = null
    try {
      cdp = new CDPConnection(port)
      await cdp.connect()

      // Check profile name
      const profileName = await cdp.evaluate(
        `navigator.userAgent.match(/Chrome\\/[\\d.]+/) ? 'detected' : null`
      )
      if (profileName) {
        result.profile.detected = true
        result.profile.name = 'Default' // CDP doesn't expose profile name easily
        result.messages.push('✓ Profile detected')
      }

      // Check for SA extension via CDP targets (service worker) — most reliable
      try {
        const targetsResp = await fetch(`http://127.0.0.1:${port}/json`, {
          signal: AbortSignal.timeout(2000),
        })
        const allTargets: any[] = await targetsResp.json()
        const saTarget = allTargets.find((t: any) =>
          t.url?.includes('kngiafgkdnlkgmefdafaibkibegkcaef') ||
          (t.type === 'service_worker' && (t.title?.includes('SuperAssistant') || t.url?.includes('background.js')))
        )
        if (saTarget) {
          result.superAssistant.installed = true
          result.messages.push('✓ SuperAssistant extension active (service worker)')
        }
      } catch { /* ignore */ }

      // Also check current page DOM for SA UI (confirms SA is injecting into the page)
      if (!result.superAssistant.installed) {
        const hasSA = await cdp.evaluate(
          `!!(document.getElementById('mcp-popover-container') || document.querySelector('[data-mcp-sidebar]') || document.querySelector('.mcp-sidebar-host') || document.querySelector('#mcp-sidebar-shadow-host'))`
        )
        if (hasSA === true) {
          result.superAssistant.installed = true
          result.messages.push('✓ SuperAssistant extension detected on page')
        } else {
          result.messages.push('⚠ SuperAssistant not detected (may not be on an AI page)')
        }
      }

      // Check login status based on current page
      const url = await cdp.evaluate('window.location.href')
      const urlStr = String(url)

      if (urlStr.includes('chatgpt.com')) {
        result.login.platform = 'chatgpt'
        const readyOrLoggedIn = await cdp.evaluate(
          `!!(document.querySelector('[data-testid="profile-button"], [data-testid="accounts-profile-button"], nav button img[alt], #prompt-textarea, #mobile-composer-prompt, textarea, [data-message-role="assistant"]'))`
        )
        result.login.detected = readyOrLoggedIn === true
        result.messages.push(
          readyOrLoggedIn ? '✓ ChatGPT interface ready' : '⚠ ChatGPT not ready'
        )
      } else if (urlStr.includes('gemini.google.com')) {
        result.login.platform = 'gemini'
        result.login.detected = true // Gemini usually auto-logs in
        result.messages.push('✓ On Gemini (auto-login via Google)')
      } else if (urlStr.includes('claude.ai')) {
        result.login.platform = 'claude'
        const auth = await verifyClaudeAuth(port, { timeoutMs: 1_000, pollIntervalMs: 250 })
        result.login.detected = auth.status === 'authenticated'
        loginStateUnknown = auth.status === 'unknown'
        result.messages.push(
          auth.status === 'authenticated'
            ? `✓ Claude session verified: ${auth.reason}`
            : auth.status === 'loginRequired'
              ? `⚠ Claude login required: ${auth.reason}`
              : `⚠ Claude login state unknown: ${auth.reason}`,
        )
      } else if (urlStr.includes('arena.ai')) {
        result.login.platform = 'arena'
        const directChatReady = await cdp.evaluate(
          `location.pathname.replace(/\\/+$/, '') === '/text/direct' &&
            !!document.querySelector('form textarea[name="message"][placeholder="Ask anything…"]')`
        )
        result.login.detected = directChatReady === true
        result.messages.push(
          directChatReady ? '✓ Arena Direct Chat interface ready' : '⚠ Arena Direct Chat is not ready'
        )
      } else if (urlStr.includes('chat.z.ai')) {
        result.login.platform = 'zai'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('textarea#chat-input')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ Z.ai composer ready; sign-in status is not verified'
            : '⚠ Z.ai composer is not ready'
        )
      } else if (urlStr.includes('grok.com')) {
        result.login.platform = 'grok'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('textarea[aria-label*="Grok"], textarea[placeholder*="Grok"]')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ Grok composer ready; sign-in status is not verified'
            : '⚠ Grok composer is not ready'
        )
      } else if (urlStr.includes('aistudio.google.com')) {
        result.login.platform = 'aistudio'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('textarea.textarea[placeholder="Start typing a prompt"], textarea.textarea[aria-label="Enter a prompt"], .prompt-box-container textarea.textarea')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ Google AI Studio composer ready; sign-in status is not verified'
            : '⚠ Google AI Studio composer is not ready; sign-in may be required'
        )
      } else if (urlStr.includes('perplexity.ai')) {
        result.login.platform = 'perplexity'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('#ask-input[contenteditable="true"], #ask-input[role="textbox"]')`
        )
        result.login.detected = composerReady === true
        result.messages.push(
          composerReady
            ? '✓ Perplexity composer ready; account sign-in status is not verified'
            : '⚠ Perplexity composer is not ready'
        )
      } else if (urlStr.includes('chat.deepseek.com')) {
        result.login.platform = 'deepseek'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('textarea#chat-input, textarea[spellcheck="false"], textarea[placeholder*="DeepSeek"], div[contenteditable="true"][role="textbox"]')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ DeepSeek composer ready; account sign-in status is not verified'
            : '⚠ DeepSeek composer is not ready; sign-in may be required'
        )
      } else if (urlStr.includes('app.chathub.gg')) {
        result.login.platform = 'chathub'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('form textarea')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ ChatHub composer ready; account sign-in status is not verified'
            : '⚠ ChatHub composer is not ready; sign-in may be required'
        )
      } else if (urlStr.includes('kimi.com')) {
        result.login.platform = 'kimi'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('.chat-input-editor[contenteditable="true"], [role="textbox"].chat-input-editor')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ Kimi composer ready; account sign-in status is not verified'
            : '⚠ Kimi composer is not ready; sign-in may be required'
        )
      } else if (urlStr.includes('chat.qwen.ai')) {
        result.login.platform = 'qwen'
        const composerReady = await cdp.evaluate(
          `!!document.querySelector('textarea.message-input-textarea, textarea[placeholder="Preguntar a Qwen"]')`
        )
        result.login.detected = false
        result.messages.push(
          composerReady
            ? '✓ Qwen composer ready; account sign-in status is not verified'
            : '⚠ Qwen composer is not ready; sign-in may be required'
        )
      } else {
        result.messages.push(`ℹ Current page: ${urlStr.substring(0, 60)}`)
      }
    } catch (err: any) {
      result.messages.push(`⚠ CDP check error: ${err.message}`)
    } finally {
      if (cdp) cdp.close()
    }
  }

  // 4. Check MCP server port
  try {
    const net = await import('net')
    result.mcpServer.portAvailable = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close()
        resolve(true)
      })
      server.listen(MCP_PORT, '127.0.0.1')
    })
    result.messages.push(
      result.mcpServer.portAvailable
        ? `✓ MCP port ${MCP_PORT} available`
        : `⚠ MCP port ${MCP_PORT} in use`
    )
  } catch {
    result.messages.push(`⚠ Could not check port ${MCP_PORT}`)
  }

  // 5. Determine recommendation
  if (!result.chrome.debugPortActive) {
    result.recommendation = 'needs_chrome'
  } else if (result.superAssistant.installed && result.login.detected) {
    result.recommendation = 'sa_mode'
  } else if (loginStateUnknown) {
    result.recommendation = 'login_unknown'
  } else if (result.chrome.debugPortActive && !result.login.detected) {
    result.recommendation = 'needs_login'
  } else {
    result.recommendation = 'cdp_fallback'
  }

  result.messages.push('')
  result.messages.push(`→ Recommendation: ${result.recommendation}`)

  return result
}

/**
 * Format the check result for display in the TUI.
 */
export function formatCheckResult(result: StartupCheckResult): string {
  const lines = [
    '╔══════════════════════════════════════════════════════════╗',
    '║  [Web Relay] Startup Check                              ║',
    '╠══════════════════════════════════════════════════════════╣',
  ]

  for (const msg of result.messages) {
    lines.push(`║  ${msg.padEnd(56)}║`)
  }

  lines.push('╚══════════════════════════════════════════════════════════╝')
  return lines.join('\n')
}
