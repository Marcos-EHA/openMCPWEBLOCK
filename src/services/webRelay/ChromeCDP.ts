/**
 * ChromeCDP — Chrome DevTools Protocol connection with multi-tab support.
 *
 * Capabilities:
 *   1. Launch Chrome via Puppeteer pipe transport for SA extension loading
 *   2. Connect to Chrome debug port for ongoing CDP operations
 *   3. Multi-tab: list tabs, connect to specific tab by URL/id
 *   4. SA auto-install: load SuperAssistant via Extensions.loadUnpacked (CDP pipe)
 *   5. Login detection: check if user is logged in on AI platforms
 *
 * Architecture:
 *   - Chrome is launched with --remote-debugging-pipe via Puppeteer
 *   - SA extension is loaded via Extensions.loadUnpacked (requires pipe transport)
 *   - --remote-debugging-port=9222 is also passed so CDPConnection can use WebSocket
 *   - After SA is loaded, Puppeteer disconnects (browser stays alive)
 *   - CDPConnection uses port 9222 for all subsequent operations
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

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

const SA_EXTENSION_ID = 'kngiafgkdnlkgmefdafaibkibegkcaef'

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_CHROME_PROFILE = 'Default'
const CHROME_USER_DATA = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Google', 'Chrome', 'User Data'
)
const DEBUG_PORT = 9222

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

export interface PageState {
  hasSA: boolean
  isLoggedIn: boolean
  platform: string | null
  isGenerating: boolean
  url: string
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
export async function isDebugPortActive(): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
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
export async function launchChrome(url: string, profileDir?: string): Promise<void> {
  const profile = profileDir ?? DEFAULT_CHROME_PROFILE

  // 1. Already running with debug port — verify SA + platform page, then done
  if (await isDebugPortActive()) {
    await verifyRelayPageReady(url)
    return
  }

  const relayDataDir = path.join(
    process.env.LOCALAPPDATA ?? '', 'openMCPWEBLOCK', 'chrome-debug'
  )

  await ensureRelayProfileUnlocked(relayDataDir)

  const saDir = prepareSAExtension()
  if (!saDir) {
    console.warn(
      '[ChromeCDP] SuperAssistant not found in Chrome profiles. ' +
        'Install SA in normal Chrome or set OPENMCP_SA_PATH to MCP-SuperAssistant/dist',
    )
  }
  syncProfileToRelay(profile, relayDataDir)

  return launchChromeInstance(url, relayDataDir, saDir)
}

/**
 * Sync key files from the user's real Chrome profile to the relay directory.
 * This preserves login sessions, preferences, and extensions (including SA).
 */
function syncProfileToRelay(profileName: string, relayDir: string): void {
  const srcProfile = path.join(CHROME_USER_DATA, profileName)
  const dstProfile = path.join(relayDir, 'Default')
  fs.mkdirSync(dstProfile, { recursive: true })

  // Files to sync from profile dir
  const profileFiles = ['Preferences', 'Secure Preferences', 'Login Data', 'Web Data']
  for (const file of profileFiles) {
    try {
      const src = path.join(srcProfile, file)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstProfile, file))
    } catch { /* locked or missing */ }
  }

  // Try to copy Cookies (may be locked if Chrome was just running)
  try {
    const src = path.join(srcProfile, 'Cookies')
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstProfile, 'Cookies'))
  } catch { /* locked */ }

  // Sync Local State (contains crypto keys for encrypted data)
  try {
    const src = path.join(CHROME_USER_DATA, 'Local State')
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(relayDir, 'Local State'))
  } catch { /* locked */ }

  // Always refresh Extensions from the real profile (SA + session must match normal Chrome)
  const srcExt = path.join(srcProfile, 'Extensions')
  const dstExt = path.join(dstProfile, 'Extensions')
  if (fs.existsSync(srcExt)) {
    try {
      if (fs.existsSync(dstExt)) {
        fs.rmSync(dstExt, { recursive: true, force: true })
      }
      copyDirRecursive(srcExt, dstExt)
    } catch { /* can't copy extensions */ }
  }
}

/**
 * Wipe relay dir and sync from the user's real Chrome profile (clean SA install via pipe).
 */
function resetRelayProfile(relayDir: string, profileName: string): void {
  try {
    if (fs.existsSync(relayDir)) {
      fs.rmSync(relayDir, { recursive: true, force: true })
    }
  } catch { /* locked */ }
  syncProfileToRelay(profileName, relayDir)
}

/** Recursively copy a directory. */
function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath)
    } else {
      try { fs.copyFileSync(srcPath, dstPath) } catch { /* locked */ }
    }
  }
}

/**
 * Clear Chrome singleton locks so a new instance can use the relay user-data-dir.
 */
async function ensureRelayProfileUnlocked(userDataDir: string): Promise<void> {
  if (await isChromeRunning()) {
    await closeChrome()
    await sleep(1500)
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
  await sleep(500)
}

async function launchChromeInstance(
  url: string,
  userDataDir: string,
  saDir: string | null,
): Promise<void> {
  await ensureRelayProfileUnlocked(userDataDir)
  const chromePath = findChromePath()

  // Always load SA via pipe when we have an unpacked copy — reliable vs stale Secure Preferences
  if (saDir) {
    try {
      await launchWithPipeAndLoadSA(chromePath, userDataDir, saDir, url)
      await waitForSAServiceWorker(45000)
      await verifyRelayPageReady(url)
      return
    } catch (e: any) {
      console.warn('[ChromeCDP] Pipe launch failed:', e?.message ?? e)
      await ensureRelayProfileUnlocked(userDataDir)
      throw new Error(
        `Could not load SuperAssistant. Close all Chrome windows and retry. (${e?.message ?? e})`,
      )
    }
  }

  // No SA package found — open platform URL only (CDP fallback, no extension tools)
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    url,
  ]

  chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  chromeProcess.unref()
  chromeProcess.on('error', () => { chromeProcess = null })
  chromeProcess.on('exit', () => { chromeProcess = null })

  await waitForDebugPort(20000)
}

/**
 * Check if SA's service worker is active via CDP /json endpoint.
 */
async function isSAServiceWorkerActive(): Promise<boolean> {
  try {
    const resp = await fetch('http://127.0.0.1:9222/json')
    const targets = await resp.json()
    return targets.some((t: any) => t.url?.includes(SA_EXTENSION_ID) && t.type === 'service_worker')
  } catch {
    return false
  }
}

async function waitForSAServiceWorker(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isSAServiceWorkerActive()) return true
    await sleep(1000)
  }
  return false
}

/**
 * Launch Chrome via Puppeteer pipe transport, load SA extension via
 * Extensions.loadUnpacked, then disconnect pipe.
 * Port 9222 remains active for CDPConnection to use.
 *
 * This is the only way to load unpacked extensions in Chrome 148+ branded
 * builds, which block --load-extension and require pipe transport for
 * the Extensions CDP domain.
 */
async function launchWithPipeAndLoadSA(
  chromePath: string,
  userDataDir: string,
  saDir: string,
  url: string,
): Promise<void> {
  await ensureRelayProfileUnlocked(userDataDir)
  await sleep(1000)

  // Dynamic import puppeteer-core (it's a devDependency)
  let puppeteer: any
  try {
    puppeteer = await import('puppeteer-core')
    if (puppeteer.default) puppeteer = puppeteer.default
  } catch {
    throw new Error('puppeteer-core not installed. Run: npm install puppeteer-core')
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    pipe: true,
    userDataDir,
    args: [
      '--enable-unsafe-extension-debugging',
      // NOTE: Do NOT pass --remote-debugging-port here.
      // Pipe + port conflict for the Extensions CDP domain.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
    ],
    headless: false,
    timeout: 30000,
  })

  try {
    // Load SA via CDP Extensions domain (only available via pipe)
    const cdp = await browser.target().createCDPSession()
    const result = await cdp.send('Extensions.loadUnpacked', { path: saDir })
    console.log(`[ChromeCDP] SA loaded via pipe — ID: ${result.id}`)
  } catch (e: any) {
    console.warn(`[ChromeCDP] SA load via pipe failed: ${e.message}`)
  }

  // Close Chrome gracefully — SA registration is written to Secure Preferences
  await browser.close()
  await sleep(2000)

  // Relaunch Chrome with port for CDPConnection (SA is registered in prefs)
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    url,
  ]

  chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  chromeProcess.unref()
  chromeProcess.on('error', () => { chromeProcess = null })
  chromeProcess.on('exit', () => { chromeProcess = null })

  await waitForDebugPort(20000)
  await waitForSAServiceWorker(45000)
  await verifyRelayPageReady(url)
}

/**
 * After launch: ensure we're on the platform URL and SA is injecting (sidebar / popover).
 */
export async function verifyRelayPageReady(platformUrl: string): Promise<void> {
  const hostname = new URL(platformUrl).hostname
  const cdp = new CDPConnection()
  try {
    await cdp.connectToUrl(hostname)
    const current = String(await cdp.evaluate('window.location.href') ?? '')
    if (!current.includes(hostname)) {
      await cdp.navigate(platformUrl)
    }
    await sleep(3000)

    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const state = await cdp.checkPageState()
      if (state.hasSA) {
        console.log(
          `[ChromeCDP] Ready: SA active on ${state.platform ?? hostname}` +
            (state.isLoggedIn ? ' (logged in)' : ' (login may be required)'),
        )
        return
      }
      await sleep(2000)
    }

    throw new Error(
      'SuperAssistant did not appear on the page. Install MCP-SuperAssistant in Chrome or set OPENMCP_SA_PATH.',
    )
  } finally {
    cdp.close()
  }
}

// findSAExtensionPaths removed: --load-extension is blocked in Chrome 148+.
// SA is now loaded via Extensions.loadUnpacked through pipe transport.

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

async function waitForDebugPort(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isDebugPortActive()) return
    await sleep(500)
  }
  throw new Error(
    `Chrome debug port ${DEBUG_PORT} not available after ${timeoutMs}ms. ` +
    `Close Chrome and relaunch, or run: chrome.exe --remote-debugging-port=${DEBUG_PORT}`
  )
}

// ─── CDP Connection (multi-tab) ─────────────────────────────────────

export class CDPConnection {
  private ws: WebSocket | null = null
  private msgId = 1
  private pending = new Map<number, {
    resolve: (v: any) => void
    reject: (e: Error) => void
  }>()
  private currentTabId: string | null = null

  /**
   * List all open tabs.
   */
  async listTabs(): Promise<TabInfo[]> {
    const resp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, {
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws!.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP call ${method} timed out`))
        }
      }, 30000)
    })
  }

  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url })
    await sleep(4000)
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result?.exceptionDetails) return null
    return result?.result?.value ?? null
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
    }

    // Detect if AI is generating
    const isGenerating = (await this.evaluate(`
      !!(document.querySelector('[data-testid="stop-button"]') ||
         document.querySelector('button[aria-label="Stop generating"]') ||
         document.querySelector('.result-streaming'))
    `)) === true

    return { hasSA, isLoggedIn, platform, isGenerating, url }
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
  // Already prepared?
  const manifestDst = path.join(SA_RELAY_DIR, 'manifest.json')
  if (fs.existsSync(manifestDst)) return SA_RELAY_DIR

  // Find SA in real Chrome profile
  const saSource = findSASourcePath()
  if (!saSource) return null

  // Copy extension files
  copyDirRecursive(saSource, SA_RELAY_DIR)

  // Remove _metadata (Web Store verification — blocks unpacked loading)
  const metaDir = path.join(SA_RELAY_DIR, '_metadata')
  if (fs.existsSync(metaDir)) {
    fs.rmSync(metaDir, { recursive: true, force: true })
  }

  // Strip 'key' and 'update_url' from manifest
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
