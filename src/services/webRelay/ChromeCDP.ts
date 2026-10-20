/**
 * ChromeCDP — Chrome DevTools Protocol connection with multi-tab support.
 *
 * Capabilities:
 *   1. Launch Chrome with --remote-debugging-port for CDP operations
 *   2. Connect to Chrome debug port for ongoing CDP operations
 *   3. Multi-tab: list tabs, connect to specific tab by URL/id
 *   4. SA auto-install: load SuperAssistant via Extensions.loadUnpacked (CDP WebSocket)
 *   5. Login detection: check if user is logged in on AI platforms
 *
 * Architecture:
 *   - Chrome is launched with --remote-debugging-port (e.g. 9222)
 *   - After debug port is active, SA extension is loaded via
 *     Extensions.loadUnpacked over CDP WebSocket on the RUNNING Chrome
 *   - No temporary Chrome process is needed (unlike the old pipe approach)
 *   - The loaded extension persists across Chrome restarts of the same relay profile
 *
 * IMPORTANT: Chrome can only have ONE instance per user-data-dir.
 * If Chrome is already running without debug port, the user must close it first.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
// @ts-ignore — ws types not installed
import { WebSocket } from 'ws'
import { SessionBroker } from './session/SessionBroker.js'
import { copyChromeProfileToRelay, inspectChromeProfileCopy } from './session/ChromeProfileRegistry.js'
import { parseExecutionDiagnostics, type ExecutionDiagnosticEvent } from './ExecutionDiagnostics.js'
import { parseRelayConversationSnapshot } from './RelayConversationSnapshot.js'
import { getWebPlatformById } from '../../utils/webPlatforms.js'
import type { SentinelConversationSnapshot } from './orchestration/types.js'

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

const SA_EXTENSION_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_CHROME_PROFILE = 'guest'
const CHROME_USER_DATA = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Google', 'Chrome', 'User Data'
)
const DEBUG_PORT = 9222
const DEFAULT_RELAY_ROOT = path.join(
  process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-agents'
)

export function inspectRelayChromeProfileCopy(
  instanceId: string,
  profileId: string,
): ReturnType<typeof inspectChromeProfileCopy> {
  if (!/^web-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(instanceId)) {
    throw new Error('A valid Web Relay instance ID is required to inspect its Chrome profile copy.')
  }
  return inspectChromeProfileCopy(profileId, path.join(DEFAULT_RELAY_ROOT, instanceId))
}

// ─── Types ──────────────────────────────────────────────────────────

export interface ChromeProfileInfo {
  dirName: string
  profileName: string
  email: string
  hasSA: boolean
}

export interface TabInfo {
  id: string
  url: string
  title: string
  webSocketDebuggerUrl: string
  type: string
}

export async function waitForPlatformPageTarget(
  debugPort: number,
  platformId: string,
  timeoutMs = 15_000,
  pollIntervalMs = 250,
): Promise<TabInfo> {
  const platform = getWebPlatformById(platformId)
  if (!platform) {
    throw new Error(`Unknown web platform "${platformId}" while locating its Chrome page.`)
  }
  const platformHost = new URL(platform.url).hostname
  const deadline = Date.now() + timeoutMs
  let observedPageHosts: string[] = []

  do {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      throw new Error(`Could not inspect Chrome targets on port ${debugPort} (HTTP ${response.status}).`)
    }
    const targets = await response.json() as TabInfo[]
    const pages = targets.filter(target => target.type === 'page' && /^https?:\/\//.test(target.url))
    observedPageHosts = pages.flatMap(target => {
      try {
        return [new URL(target.url).hostname]
      } catch {
        return []
      }
    })
    const page = pages.find(target => {
      try {
        const hostname = new URL(target.url).hostname
        return hostname === platformHost ||
          hostname.endsWith(`.${platformHost}`) ||
          (platformId === 'chatgpt' &&
            (hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') ||
              hostname === 'chat.openai.com' || hostname.endsWith('.openai.com')))
      } catch {
        return false
      }
    })
    if (page) return page

    const remaining = deadline - Date.now()
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
    }
  } while (Date.now() < deadline)

  throw new Error(
    `No ${platformId} page found on Chrome port ${debugPort} within ${timeoutMs}ms; ` +
    `observed page hosts: ${observedPageHosts.length ? observedPageHosts.join(', ') : '(none)'}.`,
  )
}

interface CdpExecutionContext {
  id: number
  name?: string
  origin?: string
  auxData?: { isDefault?: boolean; frameId?: string }
}

export interface PageState {
  hasSA: boolean
  hasInput: boolean
  isLoggedIn: boolean
  platform: string | null
  isGenerating: boolean
  url: string
}

export type WebRelaySessionMode = 'authenticated' | 'clean' | 'chrome-profile'

export function shouldTransferMasterSession(
  url: string,
  sessionMode: WebRelaySessionMode = 'clean',
): boolean {
  return url.includes('chatgpt.com') && sessionMode === 'authenticated'
}

export function shouldStartChromeMinimized(
  sessionMode?: WebRelaySessionMode,
  preference?: boolean,
): boolean {
  return preference ?? sessionMode !== 'chrome-profile'
}

export function buildChromeLaunchArgs(
  debugPort: number,
  userDataDir: string,
  startMinimized = true,
): string[] {
  return [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=IntensiveWakeUpThrottling',
    ...(startMinimized ? ['--start-minimized'] : []),
  ]
}

// ─── Chrome Profile Listing + SA Detection ─────────────────────────

/**
 * List Chrome profiles and detect which ones have SA installed.
 * Scans each profile's Extensions directory for MCP-SuperAssistant manifests.
 */
export function listChromeProfiles(): ChromeProfileInfo[] {
  const profiles: ChromeProfileInfo[] = []
  try {
    const entries = fs.readdirSync(CHROME_USER_DATA, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name !== 'Default' && !entry.name.startsWith('Profile')) continue
      const prefsPath = path.join(CHROME_USER_DATA, entry.name, 'Preferences')
      if (!fs.existsSync(prefsPath)) continue
      try {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
        const hasSA = detectSAInProfile(path.join(CHROME_USER_DATA, entry.name))
        profiles.push({
          dirName: entry.name,
          profileName: prefs?.profile?.name ?? entry.name,
          email: prefs?.account_info?.[0]?.email ?? '',
          hasSA,
        })
      } catch { /* corrupt prefs */ }
    }
  } catch { /* can't read */ }
  return profiles
}

/**
 * Get the best profile to use: prefers Default, falls back to any with SA.
 */
export function getBestProfile(): ChromeProfileInfo | null {
  const profiles = listChromeProfiles()
  // Prefer Default if it has SA
  const defaultProfile = profiles.find(p => p.dirName === 'Default')
  if (defaultProfile?.hasSA) return defaultProfile
  // Any profile with SA
  const withSA = profiles.find(p => p.hasSA)
  if (withSA) return withSA
  // Fallback to Default
  return defaultProfile ?? profiles[0] ?? null
}

/**
 * Detect if SuperAssistant extension is installed in a profile.
 */
function detectSAInProfile(profilePath: string): boolean {
  const extDir = path.join(profilePath, 'Extensions')
  if (!fs.existsSync(extDir)) return false
  try {
    const extensions = fs.readdirSync(extDir, { withFileTypes: true })
    for (const ext of extensions) {
      if (!ext.isDirectory()) continue
      // Check manifest files within extension version subdirs
      const extPath = path.join(extDir, ext.name)
      try {
        const versions = fs.readdirSync(extPath, { withFileTypes: true })
        for (const ver of versions) {
          if (!ver.isDirectory()) continue
          const manifestPath = path.join(extPath, ver.name, 'manifest.json')
          if (!fs.existsSync(manifestPath)) continue
          try {
            const manifest = fs.readFileSync(manifestPath, 'utf-8')
            if (manifest.includes('MCP') || manifest.includes('SuperAssistant') || manifest.includes('mcp-superassistant')) {
              return true
            }
          } catch { /* unreadable manifest */ }
        }
      } catch { /* can't read versions */ }
    }
  } catch { /* can't read extensions */ }
  return false
}

// ─── Chrome Launcher ────────────────────────────────────────────────

function findChromePath(): string {
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return 'chrome'
}

let chromeProcess: ChildProcess | null = null

/**
 * Check if debug port is already active (Chrome running with --remote-debugging-port).
 */
export async function isDebugPortActive(port: number = DEBUG_PORT): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Launch Chrome with debug port enabled.
 * 
 * Chrome 148+ requires a non-default user-data-dir for remote debugging.
 * We use a dedicated relay directory and sync session data from the real profile.
 */
export async function launchChrome(
  url: string,
  profileDir?: string,
  options?: {
    instanceId?: string
    debugPort?: number
    guestMode?: boolean
    sessionMode?: WebRelaySessionMode
    chromeProfileDirectory?: string
    skipExtensionLoad?: boolean
    skipNavigation?: boolean
    startMinimized?: boolean
  },
): Promise<{ saExtensionId?: string }> {
  const debugPort = options?.debugPort ?? DEBUG_PORT
  const relayDataDir = options?.instanceId
    ? path.join(DEFAULT_RELAY_ROOT, options.instanceId)
    : path.join(process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-debug')

  // 1. Already running with this instance's debug port — verify page and reuse it
  if (await isDebugPortActive(debugPort)) {
    if (!options?.skipNavigation && url !== 'about:blank') {
      await verifyRelayPageReady(url, debugPort)
    }
    return {}
  }

  await ensureRelayProfileUnlocked(relayDataDir, debugPort)

  if (options?.sessionMode === 'chrome-profile') {
    if (!options.chromeProfileDirectory) {
      throw new Error('Selecciona un perfil local de Chrome para crear la copia aislada.')
    }
    await copyChromeProfileToRelay(options.chromeProfileDirectory, relayDataDir)
  }

  // Clean profile: ensure relayDir/Default exists. Zero personal profile files copied.
  fs.mkdirSync(path.join(relayDataDir, 'Default'), { recursive: true })

  // 2. Launch Chrome FINAL with about:blank
  const initialUrl = 'about:blank'
  await launchChromeInstance(
    initialUrl,
    relayDataDir,
    null,
    debugPort,
    shouldStartChromeMinimized(options?.sessionMode, options?.startMinimized),
  )

  if (options?.skipExtensionLoad) {
    return {}
  }

  // Session transfer is opt-in; clean relays must never inherit Master cookies.
  if (!options?.skipNavigation && url && url !== 'about:blank') {
    if (shouldTransferMasterSession(url, options?.sessionMode)) {
      try {
        const broker = SessionBroker.getInstance()
        const transfer = await broker.applySessionToRelay(debugPort)
        if (transfer.ok) {
          console.log(`[ChromeCDP] Transferred ${transfer.count} session cookies to relay port ${debugPort}`)
        } else {
          console.warn(`[ChromeCDP] Session transfer notice: ${transfer.reason}`)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[ChromeCDP] Could not apply session cookies: ${msg}`)
      }
    }
    await navigateRelayPage(debugPort, url)
  }

  // After Chrome is running, ensure SA is active before the provider configures its page context.
  let saExtensionId: string | undefined = undefined
  const saDir = prepareSAExtension()

  const saAlreadyActive = await isSAServiceWorkerActive(debugPort)

  if (saAlreadyActive) {
    console.log('[ChromeCDP] SA already active (CWS or previously loaded)')
    try {
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json`)
      const targets = (await resp.json()) as any[]
      const saSW = targets.find(
        (t: any) =>
          t.type === 'service_worker' &&
          (t.url?.includes(SA_EXTENSION_ID) || String(t.title || '').includes('SuperAssistant')),
      )
      if (saSW) {
        const match = saSW.url?.match(/chrome-extension:\/\/([^/]+)\//)
        if (match) saExtensionId = match[1]
      }
    } catch {
      /* non-critical */
    }
  } else if (saDir) {
    console.log('[ChromeCDP] SA not active — loading via CDP Extensions.loadUnpacked...')
    const loadedId = await loadSAViaCDP(debugPort, saDir)

    if (loadedId) {
      saExtensionId = loadedId
      const swReady = await waitForSAServiceWorker(20000, debugPort, loadedId)
      if (!swReady) {
        console.warn(
          `[ChromeCDP] SA service worker (ext: ${loadedId}) did not appear on port ${debugPort} within 20s.`,
        )
      }
    } else {
      console.warn('[ChromeCDP] loadSAViaCDP failed — SA will not be available for this instance')
    }
  }

  if (!options?.skipNavigation && url && url !== 'about:blank') {
    await verifyRelayPageReady(url, debugPort)
  }

  return { saExtensionId }
}

/**
 * Clear Chrome singleton locks so a new instance can use the relay user-data-dir.
 */
async function ensureRelayProfileUnlocked(userDataDir: string, debugPort: number = DEBUG_PORT): Promise<void> {
  if (await isDebugPortActive(debugPort)) {
    return
  }
  const lockNames = ['SingletonLock', 'SingletonCookie', 'lockfile']
  for (const name of lockNames) {
    for (const base of [userDataDir, path.join(userDataDir, 'Default')]) {
      const lockPath = path.join(base, name)
      try {
        if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true, recursive: true })
      } catch { /* still locked */ }
    }
  }
  await sleep(300)
}

async function launchChromeInstance(
  url: string,
  userDataDir: string,
  saDir: string | null,
  debugPort: number = DEBUG_PORT,
  startMinimized = false,
): Promise<void> {
  await ensureRelayProfileUnlocked(userDataDir, debugPort)
  const chromePath = findChromePath()

  const args = buildChromeLaunchArgs(debugPort, userDataDir, startMinimized)

  // SA extension is loaded AFTER Chrome starts via CDP Extensions.loadUnpacked.
  // No --load-extension / --disable-extensions-except needed (and Chrome 148+
  // blocks --load-extension for non-dev-mode anyway).

  args.push(url)

  if (process.platform === 'win32') {
    const fullCmd = `"${chromePath}" ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`
    const psScript = `
$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class DesktopLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(
    string a, string c, IntPtr pa, IntPtr ta, bool ih,
    uint f, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi
  );
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetThreadDesktop(IntPtr hDesktop);

  public static int Launch(string cmd, bool startMinimized) {
    int pid = 0;
    Thread t = new Thread(() => {
      IntPtr h = OpenDesktop("default", 0, false, 0x01FF);
      if (h != IntPtr.Zero) SetThreadDesktop(h);
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(si);
      si.lpDesktop = @"winsta0\\default";
      si.dwFlags = 1; // STARTF_USESHOWWINDOW
      si.wShowWindow = startMinimized ? (short)7 : (short)3; // SW_SHOWMINNOACTIVE / SW_MAXIMIZE
      PROCESS_INFORMATION pi;
      if (CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi)) {
        pid = pi.dwProcessId;
      }
    });
    t.Start();
    t.Join();
    return pid;
  }
}
'@
Add-Type -TypeDefinition $cs -ErrorAction SilentlyContinue
[DesktopLauncher]::Launch('${fullCmd.replace(/'/g, "''")}', ${startMinimized ? '$true' : '$false'})
`
    try {
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64')
      execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, { stdio: 'ignore' })
    } catch {
      chromeProcess = spawn(chromePath, args, { detached: true, stdio: 'ignore', shell: false })
      chromeProcess.unref()
    }
  } else {
    chromeProcess = spawn(chromePath, args, { detached: true, stdio: 'ignore', shell: false })
    chromeProcess.unref()
  }

  await waitForDebugPort(20000, debugPort)
}

/**
 * Check if SA's service worker is active via CDP /json endpoint.
 *
 * When extensionId is provided, checks for a SW target with that SPECIFIC ID.
 * When not provided, checks for the CWS SA ID or 'SuperAssistant' in the title.
 *
 * IMPORTANT: Does NOT use 'background.js' as a match criterion. Many extensions
 * (AdBlock, uBlock, etc.) use background.js — this caused false positives.
 */
async function isSAServiceWorkerActive(
  debugPort: number = DEBUG_PORT,
  extensionId?: string,
): Promise<boolean> {
  if (!extensionId) return (await findSAExtensionId(debugPort)) !== null
  try {
    const resp = await fetch(`http://127.0.0.1:${debugPort}/json`)
    const targets = await resp.json()
    return targets.some(
      (t: any) =>
        t.type === 'service_worker' &&
        t.url?.includes(`chrome-extension://${extensionId}/`),
    )
  } catch {
    return false
  }
}

export async function findSAExtensionId(debugPort: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    const targets = await response.json() as Array<{ type?: string; url?: string; title?: string }>
    const serviceWorker = targets.find(target =>
      target.type === 'service_worker' &&
      (
        target.url?.includes(SA_EXTENSION_ID) ||
        String(target.title ?? '').includes('SuperAssistant')
      ),
    )
    const knownExtensionId = serviceWorker?.url?.match(/chrome-extension:\/\/([^/]+)\//)?.[1]
    if (knownExtensionId) return knownExtensionId
    return await findSAExtensionIdFromManifest(debugPort)
  } catch {
    return null
  }
}

async function findSAExtensionIdFromManifest(debugPort: number): Promise<string | null> {
  let browserWebSocketUrl: string
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    const version = await response.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof version.webSocketDebuggerUrl !== 'string') return null
    browserWebSocketUrl = version.webSocketDebuggerUrl
  } catch {
    return null
  }

  const browserSocket: WebSocket = new WebSocket(browserWebSocketUrl)
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CDP connection timed out')), 3000)
      browserSocket.once('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      browserSocket.once('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    let nextMessageId = 1
    const pending = new Map<number, {
      resolve: (value: any) => void
      reject: (error: Error) => void
    }>()
    browserSocket.on('message', (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString())
        if (message.id && pending.has(message.id)) {
          const request = pending.get(message.id)!
          pending.delete(message.id)
          if (message.error) request.reject(new Error(JSON.stringify(message.error)))
          else request.resolve(message.result)
        }
      } catch {
        // Ignore unsolicited CDP notifications while waiting for a response.
      }
    })
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
      const id = nextMessageId++
      const payload: Record<string, unknown> = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        browserSocket.send(JSON.stringify(payload))
        const timeout = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`CDP call ${method} timed out`))
        }, 3000)
        pending.get(id)!.resolve = value => {
          clearTimeout(timeout)
          resolve(value)
        }
        pending.get(id)!.reject = error => {
          clearTimeout(timeout)
          reject(error)
        }
      })
    }

    const { targetInfos } = await send('Target.getTargets') as {
      targetInfos?: Array<{ targetId?: string; type?: string; url?: string; title?: string }>
    }
    for (const target of targetInfos ?? []) {
      if (target.type !== 'service_worker' || !target.targetId) continue
      const extensionId = target.url?.match(/^chrome-extension:\/\/([a-p]{32})\//u)?.[1]
      if (!extensionId) continue
      if (
        extensionId === SA_EXTENSION_ID ||
        String(target.title ?? '').includes('SuperAssistant') ||
        target.url?.includes('mcpsuperassistant')
      ) {
        return extensionId
      }

      let sessionId: string | undefined
      try {
        const attached = await send('Target.attachToTarget', {
          targetId: target.targetId,
          flatten: true,
        }) as { sessionId?: string }
        sessionId = attached.sessionId
        if (!sessionId) continue
        const evaluated = await send('Runtime.evaluate', {
          expression: `JSON.stringify({id:chrome.runtime.id,name:chrome.runtime.getManifest().name})`,
          returnByValue: true,
        }, sessionId) as { result?: { value?: unknown } }
        if (typeof evaluated.result?.value !== 'string') continue
        const manifest = JSON.parse(evaluated.result.value) as { id?: unknown; name?: unknown }
        if (
          manifest.id === extensionId &&
          typeof manifest.name === 'string' &&
          /^(?:mcp\s+)?superassistant$/iu.test(manifest.name.trim())
        ) {
          return extensionId
        }
      } catch {
        // Other extension service workers can reject inspection; keep searching.
      } finally {
        if (sessionId) {
          try {
            await send('Target.detachFromTarget', { sessionId })
          } catch {
            // Closing the browser-level CDP socket also releases any remaining attachments.
          }
        }
      }
    }
    return null
  } catch {
    return null
  } finally {
    browserSocket.close()
  }
}

export interface ExistingSAExtensionContext {
  extensionId: string
  requiresPageReload: boolean
}

export async function findExistingSAExtensionContext(
  debugPort: number,
  platformId?: string,
): Promise<ExistingSAExtensionContext | null> {
  const platform = platformId ? getWebPlatformById(platformId) : undefined
  if (platformId && !platform) {
    throw new Error(`Unknown web platform "${platformId}" while checking SuperAssistant.`)
  }
  let page: TabInfo | undefined
  if (platformId) {
    page = await waitForPlatformPageTarget(debugPort, platformId)
  } else {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      throw new Error(`Could not inspect Chrome targets on port ${debugPort} (HTTP ${response.status}).`)
    }
    const targets = await response.json() as TabInfo[]
    page = targets.find(target => target.type === 'page' && /^https?:\/\//.test(target.url))
  }
  if (!page) {
    return null
  }

  const cdp = new CDPConnection(debugPort)
  try {
    await cdp.connect(page.id)
    const contexts = (await cdp.listExecutionContexts()).filter(context => {
      if (!context.origin?.startsWith('chrome-extension://')) return false
      const extensionId = context.origin.slice('chrome-extension://'.length).split('/')[0]
      return /^[a-p]{32}$/.test(extensionId) &&
        (extensionId === SA_EXTENSION_ID || context.name?.toLowerCase().includes('superassistant'))
    })
    const extensionIds = new Set(contexts.map(context =>
      context.origin!.slice('chrome-extension://'.length).split('/')[0]!,
    ))
    if (extensionIds.size > 1) {
      throw new Error(
        `Multiple SuperAssistant extensions are present in the page context on Chrome port ${debugPort}; ` +
        'refusing to select one automatically.',
      )
    }

    let requiresPageReload = false

    for (const context of contexts) {
      const extensionId = context.origin!
        .slice('chrome-extension://'.length)
        .split('/')[0]!
      const probe = await cdp.evaluate(`new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => finish({ available: false }), 2000);
        try {
          chrome.runtime.sendMessage(
            { type: 'mcp:get-server-config', payload: {} },
            response => finish({
              available: !chrome.runtime.lastError &&
                response?.success === true &&
                typeof response?.payload?.uri === 'string',
            }),
          );
        } catch {
          finish({ available: false });
        }
      })`, context.id) as { available?: boolean } | null

      if (probe?.available === true) {
        return { extensionId, requiresPageReload: false }
      }
      requiresPageReload = true
    }

    if (requiresPageReload) {
      return { extensionId: [...extensionIds][0]!, requiresPageReload: true }
    }
    return null
  } finally {
    cdp.close()
  }
}

async function waitForSAServiceWorker(
  timeoutMs: number,
  debugPort: number = DEBUG_PORT,
  extensionId?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isSAServiceWorkerActive(debugPort, extensionId)) return true
    await sleep(1000)
  }
  return false
}

/**
 * Load local unpacked SA extension on the ALREADY RUNNING Chrome via CDP
 * WebSocket + Extensions.loadUnpacked.
 *
 * This replaces the former loadUnpackedViaPipe() which used puppeteer-core
 * to launch a TEMPORARY Chrome process with --remote-debugging-pipe.
 * That approach was fundamentally broken: Chrome's ProcessSingleton prevents
 * launching a second Chrome process from the same binary when the user's
 * Chrome is already running (verified empirically — fails 100% of the time
 * when user Chrome is open, which is the normal case).
 *
 * The new approach:
 *   1. Chrome FINAL is already running with --remote-debugging-port
 *   2. Connect via WebSocket using /json/version → webSocketDebuggerUrl
 *   3. Send Extensions.loadUnpacked({ path: saDir })
 *   4. Chrome assigns a dynamic extension ID (NOT the CWS ID)
 *   5. The extension persists in the relay profile across restarts
 *
 * The dynamic ID is specific to this relay profile and stable across
 * restarts of the same relay dir with the same SA source path.
 *
 * Returns the extension ID on success, null on failure.
 */
export async function loadSAViaCDP(
  debugPort: number,
  saDir: string,
): Promise<string | null> {
  try {
    // Step 1: Get WebSocket URL from the running Chrome
    const verResp = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
      signal: AbortSignal.timeout(5000),
    })
    const ver = await verResp.json() as any
    const wsUrl = ver?.webSocketDebuggerUrl
    if (!wsUrl) {
      console.warn('[ChromeCDP] No webSocketDebuggerUrl from /json/version')
      return null
    }

    // Step 2: Connect WebSocket
    const ws = new WebSocket(wsUrl)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('WS connect timeout')), 10000)
    })

    // Step 3: Send Extensions.loadUnpacked
    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Extensions.loadUnpacked timeout (15s)')), 15000)
      const handler = (data: any) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id === 1) {
            ws.off('message', handler)
            clearTimeout(timeout)
            if (msg.error) reject(new Error(msg.error.message))
            else resolve(msg.result)
          }
        } catch {}
      }
      ws.on('message', handler)
      ws.send(JSON.stringify({
        id: 1,
        method: 'Extensions.loadUnpacked',
        params: { path: saDir },
      }))
    })

    ws.close()

    const extensionId = result?.id ?? null
    if (extensionId) {
      console.log(`[ChromeCDP] SA loaded via CDP WebSocket — ID: ${extensionId}`)
    } else {
      console.warn('[ChromeCDP] Extensions.loadUnpacked returned no ID')
    }
    return extensionId
  } catch (err: any) {
    console.warn(`[ChromeCDP] loadSAViaCDP failed: ${err.message}`)
    return null
  }
}

export async function ensureSAExtensionLoaded(
  debugPort: number,
  platformId?: string,
): Promise<ExistingSAExtensionContext> {
  const existingContext = await findExistingSAExtensionContext(debugPort, platformId)
  if (existingContext) return existingContext

  if (await isSAServiceWorkerActive(debugPort)) {
    const extensionId = await findSAExtensionId(debugPort)
    if (extensionId) return { extensionId, requiresPageReload: true }
  }

  const saDir = prepareSAExtension()
  if (!saDir) {
    throw new Error(
      'SuperAssistant is not active in this Chrome profile and no local extension build is available to load.',
    )
  }

  const extensionId = await loadSAViaCDP(debugPort, saDir)
  if (!extensionId) {
    throw new Error(`Could not load the SuperAssistant extension into Chrome port ${debugPort}.`)
  }
  if (!(await waitForSAServiceWorker(20_000, debugPort, extensionId))) {
    throw new Error(
      `SuperAssistant service worker ${extensionId} did not start on Chrome port ${debugPort}.`,
    )
  }
  return { extensionId, requiresPageReload: true }
}

/**
 * @deprecated Use loadSAViaCDP() instead. This is kept only for backward
 * compatibility with any callers that reference it by name.
 *
 * The old warning stating that Extensions.loadUnpacked "does not work" over
 * WebSocket was empirically disproven: the extension loads correctly, persists
 * across restarts, and the Service Worker activates. See loadSAViaCDP docs.
 */
export async function loadUnpackedViaBrowserCDP(
  debugPort: number,
  saDir: string,
): Promise<string | null> {
  return loadSAViaCDP(debugPort, saDir)
}

/**
 * Navigate the active page target on debugPort to a destination URL via CDP.
 */
export async function navigateRelayPage(
  debugPort: number,
  url: string,
): Promise<void> {
  const cdp = new CDPConnection(debugPort)
  try {
    await cdp.connect()
    await cdp.navigate(url)
  } finally {
    cdp.close()
  }
}

/**
 * After launch: ensure we're on the platform URL and SA is injecting (sidebar / popover).
 */
export async function verifyRelayPageReady(
  platformUrl: string,
  debugPort: number = DEBUG_PORT,
): Promise<void> {
  const hostname = new URL(platformUrl).hostname
  const cdp = new CDPConnection(debugPort)
  try {
    await cdp.connectToUrl(hostname)
    let current = ''
    try {
      current = String((await cdp.evaluate('window.location.href')) ?? '')
    } catch {
      /* page still loading */
    }
    if (!current.includes(hostname)) {
      try {
        await cdp.navigate(platformUrl)
      } catch {
        /* proceeding to wait loop */
      }
    }
    await sleep(2000)

    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try {
        const state = await cdp.checkPageState()
        if (state.hasSA) {
          console.log(
            `[ChromeCDP] Ready: SA active on ${state.platform ?? hostname}` +
              (state.isLoggedIn ? ' (logged in)' : ' (login may be required)'),
          )
          return
        }
        if (state.hasInput || state.isLoggedIn) {
          console.log(
            `[ChromeCDP] Platform ready on ${state.platform ?? hostname} (proceeding)`,
          )
          return
        }
      } catch {
        /* page may be navigating */
      }
      await sleep(2000)
    }

    console.warn(
      '[ChromeCDP] Notice: SuperAssistant UI not yet visible in DOM, proceeding.',
    )
    return
  } finally {
    cdp.close()
  }
}

// findSAExtensionPaths removed: --load-extension is blocked in Chrome 148+.
// SA is now loaded via Extensions.loadUnpacked through CDP WebSocket on the running Chrome.

// SA_EXTENSION_ID defined at top of file

async function isChromeRunning(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process')
    const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return result.includes('chrome.exe')
  } catch { return false }
}

async function waitForDebugPort(timeoutMs: number, debugPort: number = DEBUG_PORT): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDebugPortActive(debugPort)) return
    await sleep(500)
  }
  throw new Error(
    `Chrome debug port ${debugPort} not available after ${timeoutMs}ms. ` +
    `Close Chrome and relaunch, or run: chrome.exe --remote-debugging-port=${debugPort}`
  )
}

// ─── CDP Connection (multi-tab) ─────────────────────────────────────

export class CDPConnection {
  private ws: WebSocket | null = null
  private readonly debugPort: number
  private msgId = 1

  constructor(debugPort: number = DEBUG_PORT) {
    this.debugPort = debugPort
  }

  getDebugPort(): number {
    return this.debugPort
  }
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
  }>()
  private currentTabId: string | null = null

  /**
   * List all open tabs.
   */
  async listTabs(): Promise<TabInfo[]> {
    const resp = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, {
      signal: AbortSignal.timeout(3000),
    })
    const raw: any[] = await resp.json()
    return raw
      .filter((t: any) => t.type === 'page')
      .map((t: any) => ({
        id: t.id,
        url: t.url || '',
        title: t.title || '',
        webSocketDebuggerUrl: t.webSocketDebuggerUrl || '',
        type: t.type,
      }))
  }

  /**
   * Find a tab whose URL contains the given substring.
   */
  async findTabByUrl(urlSubstring: string): Promise<TabInfo | null> {
    const tabs = await this.listTabs()
    return tabs.find(t => t.url.includes(urlSubstring)) ?? null
  }

  /**
   * Connect to a specific tab by ID, or to the first page tab.
   */
  async connect(tabId?: string): Promise<void> {
    const tabs = await this.listTabs()
    let target: TabInfo | undefined

    if (tabId) {
      target = tabs.find(t => t.id === tabId)
    }
    if (!target) {
      target = tabs[0]
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('No debuggable page found')
    }

    this.currentTabId = target.id
    return this.connectToWebSocket(target.webSocketDebuggerUrl)
  }

  /**
   * Connect to a tab by URL substring (e.g., 'chatgpt.com').
   * If not found, connects to the first available tab.
   */
  async connectToUrl(urlSubstring: string): Promise<TabInfo | null> {
    const tab = await this.findTabByUrl(urlSubstring)
    if (tab) {
      await this.connectToWebSocket(tab.webSocketDebuggerUrl)
      this.currentTabId = tab.id
      return tab
    }
    // Fallback: connect to first tab
    await this.connect()
    return null
  }

  private connectToWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) this.ws.close()
      this.ws = new WebSocket(wsUrl)
      this.ws.on('open', () => resolve())
      this.ws.on('error', (err: any) => reject(err))
      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!
            this.pending.delete(msg.id)
            if (msg.error) p.reject(new Error(msg.error.message))
            else p.resolve(msg.result)
          }
        } catch { /* ignore */ }
      })
    })
  }

  getCurrentTabId(): string | null {
    return this.currentTabId
  }

  // ─── CDP Commands ───────────────────────────────────────────────

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected')
    }
    const id = this.msgId++
    const timeoutMs = method === 'Page.navigate' ? 60_000 : 30_000
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP call ${method} timed out`))
        }
      }, timeoutMs)
    })
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    await sleep(4000)
  }

  async evaluate(expression: string, contextId?: number): Promise<any> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    })
    if (result?.exceptionDetails) return null
    return result?.result?.value ?? null
  }

  async listExecutionContexts(): Promise<CdpExecutionContext[]> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected')
    }
    const contexts = new Map<number, CdpExecutionContext>()
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const message = JSON.parse(data.toString()) as {
          method?: string
          params?: { context?: CdpExecutionContext }
        }
        const context = message.params?.context
        if (
          message.method === 'Runtime.executionContextCreated' &&
          typeof context?.id === 'number'
        ) {
          contexts.set(context.id, context)
        }
      } catch {
        // Ignore non-JSON WebSocket frames.
      }
    }
    this.ws.on('message', onMessage)
    try {
      await this.send('Runtime.enable')
      return [...contexts.values()]
    } finally {
      this.ws.off('message', onMessage)
    }
  }

  /**
   * Check the full state of the current page.
   */
  async checkPageState(): Promise<PageState> {
    const url = String(await this.evaluate('window.location.href') ?? '')

    // Detect SA
    const hasSA = (await this.evaluate(`
      !!(document.getElementById('mcp-popover-container') ||
         document.querySelector('[data-mcp-sidebar]') ||
         document.querySelector('.mcp-sidebar-host') ||
         document.querySelector('#mcp-sidebar-shadow-host'))
    `)) === true

    // Detect platform and login
    let platform: string | null = null
    let isLoggedIn = false

    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      platform = 'chatgpt'
      isLoggedIn = (await this.evaluate(`
        !!(document.querySelector('#prompt-textarea') ||
           document.querySelector('[data-testid="model-switcher-dropdown-button"]') ||
           document.querySelector('[data-testid="conversation-options-button"]') ||
           window.location.pathname.startsWith('/c/'))
      `)) === true
    } else if (url.includes('gemini.google.com')) {
      platform = 'gemini'
      isLoggedIn = true // Auto-login via Google
    } else if (url.includes('claude.ai')) {
      platform = 'claude'
      isLoggedIn = (await this.evaluate(`
        !!document.querySelector('[data-testid="composer-input"]')
      `)) === true
    } else if (url.includes('arena.ai')) {
      platform = 'arena'
      isLoggedIn = (await this.evaluate(`
        location.pathname.replace(/\\/+$/, '') === '/text/direct' &&
          !!document.querySelector('form textarea[name="message"][placeholder="Ask anything…"]')
      `)) === true
    } else if (url.includes('chat.z.ai')) {
      platform = 'zai'
      // The composer is available before sign-in, so it is not an authentication signal.
      isLoggedIn = false
    } else if (url.includes('grok.com')) {
      platform = 'grok'
      // The composer is visible before sign-in and does not prove authentication.
      isLoggedIn = false
    } else if (url.includes('aistudio.google.com')) {
      platform = 'aistudio'
      // AI Studio redirects unsigned profiles to Google sign-in.
      isLoggedIn = false
    } else if (url.includes('perplexity.ai')) {
      platform = 'perplexity'
      // Perplexity exposes its anonymous composer without proving account sign-in.
      isLoggedIn = false
    } else if (url.includes('chat.deepseek.com')) {
      platform = 'deepseek'
      // The inspected clean profile redirects to sign-in; do not infer authentication from URL alone.
      isLoggedIn = false
    } else if (url.includes('app.chathub.gg')) {
      platform = 'chathub'
      // ChatHub displays its composer behind a sign-in overlay; this does not prove authentication.
      isLoggedIn = false
    } else if (url.includes('kimi.com')) {
      platform = 'kimi'
      // Kimi can show a composer before sign-in; account status needs an explicit check.
      isLoggedIn = false
    } else if (url.includes('chat.qwen.ai')) {
      platform = 'qwen'
      // Qwen exposes its composer before sign-in; this is not an authentication signal.
      isLoggedIn = false
    }

    // Detect if AI is generating
    const isGenerating = (await this.evaluate(`
      !!(document.querySelector('[data-testid="stop-button"]') ||
         document.querySelector('button[aria-label="Stop generating"]') ||
         document.querySelector('.result-streaming'))
    `)) === true

    // Cualquier area de texto/editable real visible en la pagina, sin importar
    // la plataforma -- senal generica de "la pagina ya cargo su UI", usada por
    // verifyRelayPageReady() como fallback cuando SA aun no inyecto su propia UI.
    const hasInput = (await this.evaluate(`
      !!(document.querySelector('textarea') ||
         document.querySelector('[contenteditable="true"]') ||
         document.querySelector('#prompt-textarea'))
    `)) === true

    return { hasSA, hasInput, isLoggedIn, platform, isGenerating, url }
  }

  close(): void {
    if (this.ws) { this.ws.close(); this.ws = null }
    this.pending.clear()
    this.currentTabId = null
  }
}

// ─── Utility ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function killChrome(): void {
  if (chromeProcess && !chromeProcess.killed) {
    try { chromeProcess.kill() } catch { /* ok */ }
  }
  chromeProcess = null
}

/**
 * Close ALL Chrome processes (not just ones we launched).
 * Returns true if Chrome was running.
 */
export async function closeChrome(): Promise<boolean> {
  const wasRunning = await isChromeRunning()
  if (!wasRunning) return false
  try {
    const { execSync } = await import('child_process')
    execSync('taskkill /IM chrome.exe /F', { stdio: 'ignore' })
  } catch { /* may not be running */ }
  // Wait for all processes to exit
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    if (!(await isChromeRunning())) break
  }
  chromeProcess = null
  return wasRunning
}

/**
 * Close Chrome and relaunch with debug port + specified profile.
 * Uses relay directory strategy (Chrome 148+ requires non-default user-data-dir).
 */
export async function restartChromeWithDebugPort(
  url: string,
  profileDir?: string,
): Promise<void> {
  // launchChrome handles close + relay dir + sync + launch
  return launchChrome(url, profileDir)
}

export { DEBUG_PORT }

// ─── SA Extension Management ────────────────────────────────────────

const SA_RELAY_DIR = path.join(
  process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'sa-extension'
)

/**
 * Prepare SA extension for loading: copy from real profile, strip Web Store
 * metadata (key, update_url, _metadata/) so Chrome treats it as unpacked.
 * Only copies once — skips if already prepared.
 */
export function prepareSAExtension(): string | null {
  // Find SA source (prioritizes local chrome-extension/source/dist)
  const saSource = findSASourcePath()
  if (!saSource) return null

  // If saSource is already a local repo build directory, use it directly!
  if (saSource.includes('chrome-extension') || saSource.includes('MCP-SuperAssistant')) {
    return saSource
  }

  // Fallback for CWS extensions: copy to relay dir and strip metadata
  const manifestDst = path.join(SA_RELAY_DIR, 'manifest.json')
  if (fs.existsSync(manifestDst)) return SA_RELAY_DIR

  copyDirRecursive(saSource, SA_RELAY_DIR)

  const metaDir = path.join(SA_RELAY_DIR, '_metadata')
  if (fs.existsSync(metaDir)) {
    fs.rmSync(metaDir, { recursive: true, force: true })
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestDst, 'utf-8'))
    delete manifest.key
    delete manifest.update_url
    fs.writeFileSync(manifestDst, JSON.stringify(manifest, null, 2), 'utf-8')
  } catch { /* manifest parse error */ }

  return SA_RELAY_DIR
}

/** Find the SA extension source directory (local build, env, or Chrome profile). */
function findSASourcePath(): string | null {
  const envPath = process.env.OPENMCP_SA_PATH
  if (envPath && fs.existsSync(path.join(envPath, 'manifest.json'))) {
    return envPath
  }

  const localCandidates = [
    // Prefer source/dist (current build output) over legacy dist
    path.join(process.cwd(), 'chrome-extension', 'source', 'dist'),
    path.resolve(MODULE_DIR, '..', '..', '..', 'chrome-extension', 'source', 'dist'),
    path.join(process.cwd(), 'chrome-extension', 'dist'),
    path.resolve(MODULE_DIR, '..', '..', '..', 'chrome-extension', 'dist'),
    path.join(process.cwd(), '..', 'MCP-SuperAssistant', 'dist'),
    path.join(process.cwd(), 'MCP-SuperAssistant', 'dist'),
    path.join(MODULE_DIR, '..', '..', '..', '..', 'MCP-SuperAssistant', 'dist'),
  ]
  for (const candidate of localCandidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate
    }
  }

  const profiles = [DEFAULT_CHROME_PROFILE, ...Array.from({ length: 10 }, (_, i) => `Profile ${i + 1}`)]
  for (const profile of profiles) {
    const extDir = path.join(CHROME_USER_DATA, profile, 'Extensions')
    if (!fs.existsSync(extDir)) continue
    try {
      for (const ext of fs.readdirSync(extDir, { withFileTypes: true })) {
        if (!ext.isDirectory()) continue
        const versions = fs.readdirSync(path.join(extDir, ext.name), { withFileTypes: true })
        for (const ver of versions) {
          if (!ver.isDirectory()) continue
          const mPath = path.join(extDir, ext.name, ver.name, 'manifest.json')
          if (!fs.existsSync(mPath)) continue
          try {
            const content = fs.readFileSync(mPath, 'utf-8')
            if (content.includes('"MCP SuperAssistant"') || content.includes('mcpsuperassistant')) {
              return path.join(extDir, ext.name, ver.name)
            }
          } catch { /* unreadable */ }
        }
      }
    } catch { /* can't read */ }
  }
  return null
}

// ─── Instance Identity Stamp ──────────────────────────────────────

/**
 * Identity written into chrome.storage.local['mcp:instance-identity'] of the
 * SA service worker for a given instance. This — not the debug port, and not
 * WebInstance.agentId as passed around the CLI — is the value ExecutionRegistry
 * reads to scope executions. A port is a transport; it can be recycled by an
 * unrelated Chrome. This is the identity check that must pass before anyone
 * trusts what answers on that port (see WebInstanceRegistry.verifyInstanceIdentity).
 */
export interface InstanceIdentity {
  schema: 1
  instanceId: string
  agentId?: string
  role?: string
  platformId?: string
  profileDir?: string
  sessionMode?: 'authenticated' | 'clean' | 'chrome-profile'
  masterSessionSourceId?: string
  chromeProfileDirectory?: string
  stampedAt: number
}

const INSTANCE_IDENTITY_STORAGE_KEY = 'mcp:instance-identity'

/**
 * Locate SA's service worker target on an already-active debug port via the
 * BROWSER-level CDP connection (Target.getTargets), attach to it
 * (Target.attachToTarget, flatten:true — this also keeps an MV3 worker that
 * would otherwise idle-timeout at ~30s alive for the life of the session), and
 * run Runtime.evaluate against that session. Returns null if no SA service
 * worker is found within the timeout.
 *
 * Verified empirically against this exact code path: browser-level ws connect
 * → Target.getTargets → Target.attachToTarget → Runtime.evaluate →
 * chrome.storage.local.set/get round-trip, all under plain Node (the runtime
 * this CLI actually ships under), using the `ws` package already imported at
 * the top of this file.
 */
async function withSAServiceWorkerSession<T>(
  debugPort: number,
  fn: (send: (method: string, params?: Record<string, unknown>) => Promise<any>) => Promise<T>,
  timeoutMs = 20000,
  saExtensionId?: string | null,
): Promise<T | null> {
  const verInfo = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json())
  const bws: WebSocket = new WebSocket(verInfo.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    bws.on('open', () => resolve())
    bws.on('error', reject)
  })

  let msgId = 1
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  bws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
    } catch { /* ignore */ }
  })
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => {
    const id = msgId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      bws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP call ${method} timed out`)) }
      }, 15000)
    })
  }

  try {
    let sessionId: string | null = null
    const discoveredSAExtensionId = saExtensionId ?? await findSAExtensionId(debugPort)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { targetInfos } = await send('Target.getTargets')
      const sw = (targetInfos as any[]).find(t => {
        if (t.type !== 'service_worker') return false
        const url = String(t.url || '')
        if (discoveredSAExtensionId) {
          return url.startsWith(`chrome-extension://${discoveredSAExtensionId}/`)
        }
        return url.includes(SA_EXTENSION_ID) ||
          String(t.title || '').includes('SuperAssistant') ||
          url.includes('mcpsuperassistant')
      })
      if (sw) {
        const att = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })
        sessionId = att.sessionId
        break
      }
      await sleep(500)
    }
    if (!sessionId) return null

    const scopedSend = (method: string, params: Record<string, unknown> = {}) =>
      send(method, params, sessionId!)
    return await fn(scopedSend)
  } finally {
    bws.close()
  }
}

/**
 * Read only the allow-listed execution lifecycle metadata for one known SA
 * extension. Conversation text, tool arguments, and response bodies are never
 * returned to the caller.
 */
export async function readRecentExecutionDiagnostics(
  debugPort: number,
  saExtensionId: string,
  limit = 100,
): Promise<ExecutionDiagnosticEvent[] | null> {
  if (!/^[a-p]{32}$/.test(saExtensionId)) {
    throw new Error('A valid SuperAssistant extension ID is required to read relay diagnostics.')
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Execution diagnostic limit must be between 1 and 100.')
  }

  const expression = `new Promise(resolve => chrome.storage.local.get(null, data => {
    const prefix = 'mcp:execution-diagnostic:v1:';
    const events = Object.entries(data || {})
      .filter(([key, value]) => key.startsWith(prefix) && value && typeof value === 'object' &&
        typeof value.timestamp === 'string' && value.timestamp.length <= 64 &&
        Number.isFinite(Date.parse(value.timestamp)) && typeof value.event === 'string' &&
        /^(?:OBSERVER_MONITORING_STARTED|STREAM_MONITORING_STOPPED|JSONL_PARSER_OUTPUT|AUTO_EXECUTION_|START_EXECUTION_|GET_EXECUTION_|HANDLE_EMPTY$|EXECUTION_|RESULT_COMPLETION_|RESULT_DISPLAY$|RESULT_INSERTION_|AUTO_SUBMIT_|DELIVERY_)/u.test(value.event))
      .map(([, value]) => ({
        timestamp: value.timestamp,
        event: value.event.slice(0, 128),
        callId: typeof value.callId === 'string' ? value.callId.slice(0, 256) : undefined,
        toolName: typeof value.toolName === 'string' ? value.toolName.slice(0, 256) : undefined,
        success: typeof value.success === 'boolean' ? value.success : undefined,
        executionIdPresent: typeof value.executionIdPresent === 'boolean' ? value.executionIdPresent : undefined,
        executionKeyPresent: typeof value.executionKeyPresent === 'boolean' ? value.executionKeyPresent : undefined,
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 256) : undefined,
        resultStatus: typeof value.resultStatus === 'string' ? value.resultStatus.slice(0, 256) : undefined,
        pageVisibility: ['visible', 'hidden', 'unknown'].includes(value.pageVisibility)
          ? value.pageVisibility : undefined,
        pageHasFocus: typeof value.pageHasFocus === 'boolean' || value.pageHasFocus === null
          ? value.pageHasFocus : undefined,
        buildMarker: typeof value.buildMarker === 'string' ? value.buildMarker.slice(0, 256) : undefined,
        targetSelectors: Array.isArray(value.targetSelectors) &&
          value.targetSelectors.length <= 20 &&
          value.targetSelectors.every((item: unknown) => typeof item === 'string' && item.length <= 128)
          ? value.targetSelectors
          : undefined,
        streamingContainerSelectors: Array.isArray(value.streamingContainerSelectors) &&
          value.streamingContainerSelectors.length <= 20 &&
          value.streamingContainerSelectors.every((item: unknown) => typeof item === 'string' && item.length <= 128)
          ? value.streamingContainerSelectors
          : undefined,
        monitoringEnabled: typeof value.monitoringEnabled === 'boolean'
          ? value.monitoringEnabled
          : undefined,
        activeStreamIntervals: Number.isInteger(value.activeStreamIntervals) &&
          value.activeStreamIntervals >= 0
          ? value.activeStreamIntervals
          : undefined,
      }))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-${limit});
    resolve(JSON.stringify(events));
  }))`

  const serialized = await withSAServiceWorkerSession(
    debugPort,
    async send => {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
      if (response?.exceptionDetails) {
        throw new Error('Could not read execution diagnostics from the relay extension.')
      }
      if (typeof response?.result?.value !== 'string') {
        throw new Error('Relay returned an invalid execution diagnostic snapshot.')
      }
      return response.result.value as string
    },
    3000,
    saExtensionId,
  )

  if (serialized === null) return null
  let storage: unknown
  try {
    storage = JSON.parse(serialized)
  } catch (error) {
    throw new Error('Relay returned malformed execution diagnostic JSON.', { cause: error })
  }
  return parseExecutionDiagnostics(
    Object.fromEntries(
      (Array.isArray(storage) ? storage : []).map((event, index) => [
        `mcp:execution-diagnostic:v1:${index}`,
        event,
      ]),
    ),
    limit,
  )
}

export interface ConversationFlowSurface {
  available: boolean
  reason?: string
  platformTabCount: number
  preElementCount?: number
  codeElementCount?: number
  completeFunctionCallCandidateCount?: number
  renderedFunctionCallCount?: number
  executableFunctionCallCount?: number
  unrenderedFunctionCallCount?: number
  candidateTags?: string[]
}

/**
 * Read structural conversation-rendering signals only. No page text or call
 * parameters are returned; string inspection stays inside the page context.
 */
export async function inspectConversationFlowSurface(
  debugPort: number,
  platformId: string,
): Promise<ConversationFlowSurface> {
  const platform = getWebPlatformById(platformId)
  if (!platform) throw new Error(`Unknown web platform "${platformId}" while inspecting conversation flow.`)
  const hostname = new URL(platform.url).hostname
  const connection = new CDPConnection(debugPort)
  try {
    const tabs = await withTimeout(connection.listTabs(), 4000, 'conversation flow tab discovery')
    const platformTabs = tabs.filter(tab => isPlatformPage(tab.url, hostname, platformId))
    if (platformTabs.length !== 1) {
      return {
        available: false,
        reason: platformTabs.length === 0
          ? `No ${platformId} page is open.`
          : `Found ${platformTabs.length} ${platformId} pages; refusing to inspect an arbitrary tab.`,
        platformTabCount: platformTabs.length,
      }
    }
    const target = platformTabs[0]!
    await withTimeout(connection.connect(target.id), 4000, 'conversation flow page connection')
    const snapshot = await withTimeout(connection.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('pre, code'));
      const candidates = nodes.filter(node => {
        const text = node.textContent || '';
        return /"type"\\s*:\\s*"function_call_start"/u.test(text) &&
          /"type"\\s*:\\s*"function_call_end"/u.test(text);
      });
      const rows = candidates.map(node => {
        const block = node.closest('.function-block') ||
          node.parentElement?.closest('.function-block') ||
          node.parentElement?.querySelector('.function-block');
        return {
          tag: node.tagName,
          rendered: Boolean(block),
          executable: Boolean(block?.querySelector('.execute-button')),
        };
      });
      return {
        preElementCount: document.querySelectorAll('pre').length,
        codeElementCount: document.querySelectorAll('code').length,
        completeFunctionCallCandidateCount: candidates.length,
        renderedFunctionCallCount: rows.filter(row => row.rendered).length,
        executableFunctionCallCount: rows.filter(row => row.executable).length,
        unrenderedFunctionCallCount: rows.filter(row => !row.rendered).length,
        candidateTags: [...new Set(rows.map(row => row.tag))],
      };
    })()`), 4000, 'conversation flow DOM inspection') as
      Omit<ConversationFlowSurface, 'available' | 'platformTabCount'>
    return { available: true, platformTabCount: 1, ...snapshot }
  } finally {
    connection.close()
  }
}

/**
 * Read a bounded, in-memory snapshot of the rendered ChatGPT conversation in
 * one explicitly selected Relay. This function never persists or forwards text.
 */
export async function readRelayConversation(
  agentId: string,
  debugPort: number,
  platformId: string,
): Promise<SentinelConversationSnapshot> {
  if (platformId !== 'chatgpt') {
    return {
      agentId,
      available: false,
      unavailableReason: 'unsupported-platform',
      messages: [],
      truncated: false,
    }
  }

  const platform = getWebPlatformById(platformId)
  if (!platform) {
    throw new Error(`Unknown web platform "${platformId}" while reading Relay conversation.`)
  }
  const expectedHost = new URL(platform.url).hostname
  const connection = new CDPConnection(debugPort)
  try {
    const tabs = await connection.listTabs()
    const matchingTabs = tabs.filter(tab => {
      try {
        const hostname = new URL(tab.url).hostname
        return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`) ||
          hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') ||
          hostname === 'chat.openai.com' || hostname.endsWith('.openai.com')
      } catch {
        return false
      }
    })
    if (matchingTabs.length === 0) {
      return {
        agentId,
        available: false,
        unavailableReason: 'no-platform-tab',
        messages: [],
        truncated: false,
      }
    }
    if (matchingTabs.length !== 1) {
      return {
        agentId,
        available: false,
        unavailableReason: 'multiple-platform-tabs',
        messages: [],
        truncated: false,
      }
    }

    await connection.connect(matchingTabs[0]!.id)
    const result: unknown = await connection.evaluate(`(() => {
      const limit = 30;
      const maxCharactersPerMessage = 2000;
      const nodes = Array.from(document.querySelectorAll(
        '[data-message-author-role="user"], [data-message-author-role="assistant"]'
      ));
      const messages = nodes.map(node => ({
        role: node.getAttribute('data-message-author-role'),
        text: (node.innerText || node.textContent || '').trim()
      })).filter(message =>
        (message.role === 'user' || message.role === 'assistant') && message.text.length > 0
      );
      const truncated = messages.length > limit ||
        messages.slice(-limit).some(message => message.text.length > maxCharactersPerMessage);
      return {
        capturedAt: new Date().toISOString(),
        pageVisibility: document.visibilityState,
        pageHasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        messages: messages.slice(-limit).map(message => ({
          role: message.role,
          text: message.text.slice(0, maxCharactersPerMessage)
        })),
        truncated
      };
    })()`)
    return parseRelayConversationSnapshot(agentId, result)
  } finally {
    connection.close()
  }
}

export interface RelayScreenshot {
  agentId: string
  platformId: string
  capturedAt: string
  mimeType: 'image/jpeg'
  data: string
}

/**
 * Capture one viewport from the selected Relay without changing page focus or
 * navigating tabs. The screenshot remains in memory and is returned to the
 * caller for an explicitly requested MCP image response.
 */
export async function captureRelayScreenshot(
  agentId: string,
  debugPort: number,
  platformId: string,
): Promise<RelayScreenshot> {
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) {
    throw new RangeError('Relay debug port must be a valid TCP port.')
  }
  const platform = getWebPlatformById(platformId)
  if (!platform) {
    throw new Error(`Unknown web platform "${platformId}" while capturing Relay screenshot.`)
  }
  const expectedHost = new URL(platform.url).hostname
  const connection = new CDPConnection(debugPort)
  try {
    const tabs = await connection.listTabs()
    const matchingTabs = tabs.filter(tab => {
      try {
        const hostname = new URL(tab.url).hostname
        return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`) ||
          (platformId === 'chatgpt' && (
            hostname === 'chatgpt.com' ||
            hostname.endsWith('.chatgpt.com') ||
            hostname === 'chat.openai.com' ||
            hostname.endsWith('.openai.com')
          ))
      } catch {
        return false
      }
    })
    if (matchingTabs.length === 0) {
      throw new Error(`No ${platform.name} page found in Relay "${agentId}".`)
    }
    if (matchingTabs.length !== 1) {
      throw new Error(`Multiple ${platform.name} pages found in Relay "${agentId}"; close unrelated platform tabs and retry.`)
    }

    await connection.connect(matchingTabs[0]!.id)
    const result = await connection.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 65,
      fromSurface: true,
      captureBeyondViewport: false,
    }) as { data?: unknown }
    const maxImageBytes = 5 * 1024 * 1024
    const maxBase64Length = 4 * Math.ceil(maxImageBytes / 3)
    if (
      typeof result.data !== 'string' ||
      result.data.length === 0 ||
      result.data.length > maxBase64Length ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)
    ) {
      throw new Error(`Chrome returned an invalid screenshot for Relay "${agentId}".`)
    }
    const imageBytes = Buffer.from(result.data, 'base64')
    if (imageBytes.length === 0 || imageBytes.length > maxImageBytes) {
      throw new Error(`Screenshot for Relay "${agentId}" is empty or exceeds the 5 MiB limit.`)
    }
    if (imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8) {
      throw new Error(`Chrome returned an invalid JPEG screenshot for Relay "${agentId}".`)
    }
    return {
      agentId,
      platformId,
      capturedAt: new Date().toISOString(),
      mimeType: 'image/jpeg',
      data: imageBytes.toString('base64'),
    }
  } finally {
    connection.close()
  }
}

/**
 * Stamp durable identity into SA's service worker for one instance, verified
 * by an immediate read-back. This is the piece ExecutionRegistry currently has
 * no way to obtain on its own: instanceId/agentId arriving in a message payload
 * originate in the content script, which per design must never be the source
 * of an agent's identity. Cross-agent isolation today accidentally rides on
 * each instance's Service Worker having its own BOOT_ID (separate Chrome
 * process, separate worker) — real, but it does not survive that worker's own
 * restarts (MV3 kills it after ~30s idle) and is useless for anything —
 * Sentinel included — that needs to address THIS agent again later.
 *
 * Idempotent: safe to call again after a worker restart, since the storage
 * write simply overwrites the same key with the same value.
 */
export async function stampInstanceIdentity(
  debugPort: number,
  identity: Omit<InstanceIdentity, 'schema' | 'stampedAt'>,
  saExtensionId?: string | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const payload: InstanceIdentity = { schema: 1, stampedAt: Date.now(), ...identity }

  const result = await withSAServiceWorkerSession(debugPort, async send => {
    const ctx = await send('Runtime.evaluate', {
      expression: `JSON.stringify({chrome: typeof chrome, local: (typeof chrome!=='undefined'&&chrome.storage&&chrome.storage.local)?'yes':'no'})`,
      returnByValue: true,
    })
    if (ctx.exceptionDetails) return { ok: false as const, reason: `Runtime.evaluate failed: ${ctx.exceptionDetails.text}` }
    const parsed = JSON.parse(ctx.result?.value ?? '{}')
    if (parsed.local !== 'yes') return { ok: false as const, reason: 'chrome.storage.local not accessible from SA service worker context' }

    const setRes = await send('Runtime.evaluate', {
      expression: `(async()=>{await chrome.storage.local.set({'${INSTANCE_IDENTITY_STORAGE_KEY}':${JSON.stringify(payload)}});return 'SET_OK';})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (setRes.exceptionDetails || setRes.result?.value !== 'SET_OK') {
      return { ok: false as const, reason: `chrome.storage.local.set failed: ${setRes.exceptionDetails?.text ?? 'unexpected result'}` }
    }

    const getRes = await send('Runtime.evaluate', {
      expression: `(async()=>{const r=await chrome.storage.local.get('${INSTANCE_IDENTITY_STORAGE_KEY}');return JSON.stringify(r['${INSTANCE_IDENTITY_STORAGE_KEY}']||null);})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    const readBack = getRes.result?.value ? JSON.parse(getRes.result.value) : null
    // NOTA: comparar por igualdad de campos, no por JSON.stringify() bruto --
    // chrome.storage.local puede (y en la practica lo hace) reordenar las
    // claves del objeto en el round-trip de serializacion. El orden de claves
    // no es parte de la identidad; los VALORES si lo son.
    const fieldsMatch = readBack !== null && (['schema', 'instanceId', 'agentId', 'role', 'platformId', 'profileDir', 'sessionMode', 'masterSessionSourceId', 'chromeProfileDirectory', 'stampedAt'] as const)
      .every(k => JSON.stringify((readBack as any)[k]) === JSON.stringify((payload as any)[k]))
    if (!fieldsMatch) {
      return { ok: false as const, reason: `Read-back mismatch: wrote ${JSON.stringify(payload)}, read ${JSON.stringify(readBack)}` }
    }

    return { ok: true as const }
  }, 20000, saExtensionId)

  if (result === null) return { ok: false, reason: 'SA service worker not found on this debug port within timeout' }
  return result
}

/**
 * Read the stamped identity from SA's service worker storage over CDP.
 */
export async function getInstanceIdentity(
  debugPort: number,
  saExtensionId?: string | null,
): Promise<InstanceIdentity | null> {
  return withSAServiceWorkerSession(debugPort, async send => {
    const getRes = await send('Runtime.evaluate', {
      expression: `(async()=>{const r=await chrome.storage.local.get('${INSTANCE_IDENTITY_STORAGE_KEY}');return JSON.stringify(r['${INSTANCE_IDENTITY_STORAGE_KEY}']||null);})()`,
      awaitPromise: true,
      returnByValue: true,
    })
    return getRes.result?.value ? JSON.parse(getRes.result.value) : null
  }, 10000, saExtensionId)
}

/**
 * Check if SA is installed in the relay Chrome via CDP.
 * Must be connected to a chrome://extensions tab.
 */
export async function checkSAInstalled(cdp: CDPConnection): Promise<{ installed: boolean; id?: string }> {
  try {
    const result = await cdp.evaluate(`
      new Promise(resolve => {
        if (typeof chrome !== 'undefined' && chrome.developerPrivate) {
          chrome.developerPrivate.getExtensionsInfo(function(exts) {
            const sa = exts.find(e => e.name.includes('MCP') || e.name.includes('SuperAssistant'));
            resolve(sa ? JSON.stringify({ installed: true, id: sa.id, state: sa.state }) : '{"installed":false}');
          });
        } else {
          resolve('{"installed":false}');
        }
      })
    `)
    return JSON.parse(result as string)
  } catch {
    return { installed: false }
  }
}

/**
 * Install SA extension in relay Chrome. Navigates to chrome://extensions,
 * enables dev mode, clicks "Load unpacked", and waits for user to select folder.
 *
 * After first install, Chrome remembers the extension for future sessions.
 *
 * Returns the extension ID if installed, or null if timeout.
 */
export async function installSAExtension(cdp: CDPConnection): Promise<string | null> {
  // Navigate to chrome://extensions
  await cdp.send('Page.navigate', { url: 'chrome://extensions' })
  await sleep(3000)

  // Check if already installed
  const existing = await checkSAInstalled(cdp)
  if (existing.installed) return existing.id ?? null

  // Enable developer mode
  await cdp.evaluate(`
    (function() {
      const mgr = document.querySelector('extensions-manager');
      const toolbar = mgr?.shadowRoot?.querySelector('extensions-toolbar');
      const toggle = toolbar?.shadowRoot?.querySelector('#devMode');
      if (toggle && !toggle.checked) toggle.click();
    })()
  `)
  await sleep(1000)

  // Click "Load unpacked"
  await cdp.evaluate(`
    (function() {
      const mgr = document.querySelector('extensions-manager');
      const toolbar = mgr?.shadowRoot?.querySelector('extensions-toolbar');
      const loadBtn = toolbar?.shadowRoot?.querySelector('#loadUnpacked');
      if (loadBtn) loadBtn.click();
    })()
  `)

  // Poll for SA to appear (user selects folder in the file picker)
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    try {
      const check = await checkSAInstalled(cdp)
      if (check.installed && check.id) {
        // Grant all host permissions
        await cdp.evaluate(`
          new Promise(resolve => {
            chrome.developerPrivate.updateExtensionConfiguration({
              extensionId: '${check.id}',
              hostAccess: 'ON_ALL_SITES',
            }, () => resolve('ok'));
          })
        `)
        return check.id
      }
    } catch { /* page might be refreshing */ }
  }

  return null
}
