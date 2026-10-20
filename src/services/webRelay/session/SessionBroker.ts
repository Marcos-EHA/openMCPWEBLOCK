/**
 * SessionBroker.ts
 *
 * Dedicated, isolated session transport between Master Session and agent relays.
 *
 * Strict architectural boundaries:
 * - Transport layer ONLY (CDP Network cookies in memory).
 * - NEVER writes cookie values to disk.
 * - NEVER prints cookie values to logs, console, or errors.
 * - NEVER exposes master-session as user-data-dir of an agent.
 * - Filters strictly to official domains for the selected platform.
 * - Distinguishes CSRF vs genuine session tokens (never accepts CSRF alone as auth).
 * - No DOM, SA, MCP, TUI, or WIR dependencies.
 */

import { WebSocket } from 'ws'
import { execFile, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  getMasterSessionProfilePath,
  getMasterSessionSource,
  type MasterSessionSource,
} from './MasterSessionRegistry.js'

export interface SessionCookieParam {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expires?: number
  priority?: 'Low' | 'Medium' | 'High'
  partitionKey?: string | { topLevelSite: string; hasCrossSiteAncestor: boolean }
}

export interface SessionTransferResult {
  ok: boolean
  count: number
  hasSessionToken: boolean
  reason?: string
}

export interface CookieClassification {
  csrfCookies: SessionCookieParam[]
  sessionCookies: SessionCookieParam[]
  auxiliaryCookies: SessionCookieParam[]
  hasValidSession: boolean
}

export interface MasterSessionStatus {
  active: boolean
  debugPort: number | null
  profileDir: string
  hasValidSession: boolean
  authenticationState: 'authenticated' | 'loginRequired' | 'unverified'
  cookieCount: number
  reason?: string
}

const DEFAULT_MASTER_SESSION_SOURCE = 'loco-verde'

const ALLOWED_COOKIE_DOMAINS = [
  'chatgpt.com',
  'openai.com',
  'oaistatic.com',
  'oaiusercontent.com',
]
const ALLOWED_COOKIE_DOMAINS_BY_PLATFORM = {
  chatgpt: ALLOWED_COOKIE_DOMAINS,
  claude: ['claude.ai'],
  zai: ['z.ai'],
  chatx: ['chatx.ai'],
} as const

type MasterSessionPlatformId = 'chatgpt' | 'claude' | 'zai' | 'chatx'

/**
 * Returns true if the domain belongs to ChatGPT / OpenAI.
 */
export function isAllowedDomain(domain: string): boolean {
  return isAllowedDomainForPlatform(domain, 'chatgpt')
}

export function isAllowedDomainForPlatform(domain: string, platformId: MasterSessionPlatformId): boolean {
  if (!domain) return false
  const normalized = domain.startsWith('.') ? domain.slice(1).toLowerCase() : domain.toLowerCase()
  return ALLOWED_COOKIE_DOMAINS_BY_PLATFORM[platformId]
    .some(allowed => normalized === allowed || normalized.endsWith('.' + allowed))
}

/**
 * Get the dedicated master session profile directory.
 */
export function getMasterProfileDir(sourceId = DEFAULT_MASTER_SESSION_SOURCE): string {
  return getMasterSessionProfilePath(getMasterSessionSource(sourceId))
}

/**
 * Locate Chrome binary.
 */
export function findChromePath(): string {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  const defaultWin = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const winX86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  if (fs.existsSync(defaultWin)) return defaultWin
  if (fs.existsSync(winX86)) return winX86
  return 'chrome'
}

/**
 * Classify cookies for a single platform without treating another platform's
 * cookies as authentication evidence.
 */
export function classifyCookies(cookies: SessionCookieParam[]): CookieClassification {
  return classifyCookiesForPlatform(cookies, 'chatgpt')
}

export function classifyCookiesForPlatform(
  cookies: SessionCookieParam[],
  platformId: MasterSessionPlatformId,
): CookieClassification {
  const csrfCookies: SessionCookieParam[] = []
  const sessionCookies: SessionCookieParam[] = []
  const auxiliaryCookies: SessionCookieParam[] = []

  const now = Date.now()

  for (const cookie of cookies) {
    if (!isAllowedDomainForPlatform(cookie.domain, platformId)) {
      continue
    }

    if (platformId === 'claude' && cookie.name === 'sessionKey') {
      sessionCookies.push(cookie)
    } else if (cookie.name.includes('csrf-token')) {
      csrfCookies.push(cookie)
    } else if (
      cookie.name === '__Secure-next-auth.session-token' ||
      cookie.name.startsWith('__Secure-next-auth.session-token.') ||
      cookie.name.includes('session-token')
    ) {
      sessionCookies.push(cookie)
    } else {
      auxiliaryCookies.push(cookie)
    }
  }

  const hasValidSession = sessionCookies.some(
    c => Boolean(c.value) && (!c.expires || c.expires <= 0 || c.expires * 1000 > now),
  )

  return {
    csrfCookies,
    sessionCookies,
    auxiliaryCookies,
    hasValidSession,
  }
}

/**
 * Helper to execute a single CDP command over WebSocket and close the connection.
 */
export async function sendCdpCommand<T>(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = 10000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let ws: WebSocket | null = null
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (ws) {
        try {
          ws.removeAllListeners()
          ws.close()
        } catch {}
        ws = null
      }
    }

    try {
      ws = new WebSocket(wsUrl)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reject(new Error(`WebSocket creation failed for ${method}: ${msg}`))
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    ws.on('open', () => {
      const payload = JSON.stringify({ id: 1, method, params })
      ws?.send(payload)
    })

    ws.on('message', (data: Buffer | string) => {
      try {
        const parsed = JSON.parse(data.toString())
        if (parsed.id === 1) {
          cleanup()
          if (parsed.error) {
            reject(new Error(`CDP ${method} error: ${parsed.error.message || JSON.stringify(parsed.error)}`))
          } else {
            resolve(parsed.result as T)
          }
        }
      } catch (e: unknown) {
        cleanup()
        reject(e)
      }
    })

    ws.on('error', (err: Error) => {
      cleanup()
      reject(new Error(`WebSocket error on ${method}: ${err.message}`))
    })
  })
}

/**
 * Get page WebSocket debugger URL for a given port.
 */
export async function getPageWsUrl(port: number, urlFilter?: string): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(4000),
  })
  if (!resp.ok) {
    throw new Error(`Failed to fetch /json from port ${port}: HTTP ${resp.status}`)
  }
  const targets = (await resp.json()) as Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>
  const pageTarget = targets.find(t => t.type === 'page' && (!urlFilter || (t.url && t.url.includes(urlFilter))))

  if (pageTarget?.webSocketDebuggerUrl) {
    return pageTarget.webSocketDebuggerUrl
  }

  const anyPage = targets.find(t => t.type === 'page' && Boolean(t.webSocketDebuggerUrl))
  if (anyPage?.webSocketDebuggerUrl) {
    return anyPage.webSocketDebuggerUrl
  }

  // Fallback to browser WebSocket if no page target is ready
  const verResp = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(3000),
  })
  const ver = (await verResp.json()) as { webSocketDebuggerUrl?: string }
  if (ver?.webSocketDebuggerUrl) {
    return ver.webSocketDebuggerUrl
  }

  throw new Error(`No CDP page target found on http://127.0.0.1:${port}/json`)
}

/**
 * Check if a debug port is currently answering CDP requests.
 */
export async function isPortActive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

export function chromeCommandLineMatchesProfile(
  commandLine: string,
  expectedProfileDir: string,
  port: number,
): boolean {
  const normalizedExpectedProfileDir = path.resolve(expectedProfileDir)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  const normalizedCommandLine = commandLine.replace(/\\/g, '/')
  const userDataMatch = normalizedCommandLine.match(
    /(?:^|\s)--user-data-dir=(?:"([^"]+)"|([^\s"]+))/i,
  )
  const debugPortMatch = normalizedCommandLine.match(/(?:^|\s)--remote-debugging-port=(\d+)(?:\s|$)/i)
  const actualProfileDir = (userDataMatch?.[1] ?? userDataMatch?.[2] ?? '')
    .replace(/\/+$/, '')
    .toLowerCase()
  return Number(debugPortMatch?.[1]) === port && actualProfileDir === normalizedExpectedProfileDir
}

export function masterSessionCommandLineMatches(
  commandLine: string,
  sourceId: string,
  port: number,
): boolean {
  return chromeCommandLineMatchesProfile(commandLine, getMasterProfileDir(sourceId), port)
}

function execFileOutput(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

async function getListeningProcessCommandLine(port: number): Promise<string> {
  if (process.platform === 'win32') {
    const netstatOutput = await execFileOutput('netstat.exe', ['-ano', '-p', 'tcp'], 5000)
    const ownerPid = getListeningPid(netstatOutput, port)
    if (!ownerPid) return ''

    const script =
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${ownerPid}"; ` +
      'if ($process) { $process.CommandLine }'
    return execFileOutput(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      15000,
    )
  }

  const pid = (await execFileOutput('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], 5000))
    .trim()
    .split(/\s+/)[0]
  if (!pid || !/^\d+$/.test(pid)) return ''
  return execFileOutput('ps', ['-p', pid, '-o', 'args='], 5000)
}

export function getListeningPid(netstatOutput: string, port: number): string | null {
  const owners = new Set<string>()
  for (const line of netstatOutput.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (
      columns[0]?.toUpperCase() !== 'TCP' ||
      Number(columns[1]?.match(/:(\d+)$/)?.[1]) !== port ||
      !['LISTENING', 'ESCUCHANDO'].includes(columns[3]?.toUpperCase() ?? '') ||
      !/^\d+$/.test(columns[4] ?? '')
    ) {
      continue
    }
    owners.add(columns[4]!)
  }
  return owners.size === 1 ? owners.values().next().value! : null
}

const masterSessionStarts = new Map<string, Promise<number>>()

export async function hasRestorableMasterPage(
  debugPort: number,
  platformId: MasterSessionSource['platformId'],
): Promise<boolean> {
  const platformUrl = new URL(getWebPlatformUrl(platformId))
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) {
    throw new Error(`Could not inspect Master Session tabs on port ${debugPort}: HTTP ${response.status}.`)
  }
  const targets = await response.json() as Array<{ type?: string; url?: string }>
  return targets.some(target => {
    if (target.type !== 'page' || typeof target.url !== 'string') return false
    try {
      const hostname = new URL(target.url).hostname
      return hostname === platformUrl.hostname || hostname.endsWith(`.${platformUrl.hostname}`)
    } catch {
      return false
    }
  })
}

/**
 * Find active Master Session port or return null.
 */
export async function findActiveMasterPort(sourceId = DEFAULT_MASTER_SESSION_SOURCE): Promise<number | null> {
  const source = getMasterSessionSource(sourceId)
  if (!(await isPortActive(source.debugPort))) return null

  let commandLine: string
  try {
    commandLine = await getListeningProcessCommandLine(source.debugPort)
  } catch (error) {
    throw new Error(
      `Could not verify the Chrome profile serving Master Session "${source.name}" on port ${source.debugPort}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!masterSessionCommandLineMatches(commandLine, sourceId, source.debugPort)) {
    throw new Error(
      `Port ${source.debugPort} is serving a Chrome process that does not use the registered profile for ` +
      `Master Session "${source.name}". Close that Chrome window and reopen the source with ` +
      `/mcp master-session open ${source.id}.`,
    )
  }
  return source.debugPort
}

/**
 * Launch or reuse the Master Session in a controlled manner.
 */
export function ensureMasterSessionRunning(
  sourceId = DEFAULT_MASTER_SESSION_SOURCE,
  options: { restorePreviousSession?: boolean } = {},
): Promise<number> {
  const restorePreviousSession = options.restorePreviousSession === true
  const pending = masterSessionStarts.get(sourceId)
  if (pending) return pending

  const start = startMasterSession(sourceId, restorePreviousSession).finally(() => {
    if (masterSessionStarts.get(sourceId) === start) masterSessionStarts.delete(sourceId)
  })
  masterSessionStarts.set(sourceId, start)
  return start
}

export async function closeMasterSession(sourceId = DEFAULT_MASTER_SESSION_SOURCE): Promise<void> {
  const port = await findActiveMasterPort(sourceId)
  if (port === null) return

  const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok) {
    throw new Error(`Could not inspect Master Session browser on port ${port}: HTTP ${response.status}.`)
  }
  const version = await response.json() as { webSocketDebuggerUrl?: string }
  const browserWsUrl = version.webSocketDebuggerUrl
  if (!browserWsUrl) {
    throw new Error(`Master Session browser on port ${port} did not expose a browser debugging endpoint.`)
  }
  const debuggerUrl = new URL(browserWsUrl)
  if (
    debuggerUrl.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(debuggerUrl.hostname) ||
    Number(debuggerUrl.port) !== port
  ) {
    throw new Error(`Master Session browser on port ${port} exposed an unexpected debugging endpoint.`)
  }

  let closeError: unknown
  try {
    await sendCdpCommand(debuggerUrl.toString(), 'Browser.close', {}, 4000)
  } catch (error) {
    closeError = error
  }

  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (!(await isPortActive(port))) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  if (closeError) {
    throw new Error(
      `Could not close Master Session "${getMasterSessionSource(sourceId).name}": ` +
      `${closeError instanceof Error ? closeError.message : String(closeError)}`,
    )
  }
  throw new Error(`Master Session "${getMasterSessionSource(sourceId).name}" did not close on port ${port}.`)
}

function getWebPlatformUrl(platformId: MasterSessionPlatformId): string {
  if (platformId === 'claude') return 'https://claude.ai/'
  if (platformId === 'zai') return 'https://chat.z.ai/'
  if (platformId === 'chatx') return 'https://chatx.ai/es/gpt'
  return 'https://chatgpt.com/'
}

export function buildMasterSessionLaunchArgs(
  source: MasterSessionSource,
  masterDir: string,
  restorePreviousSession = false,
): string[] {
  return [
    `--remote-debugging-port=${source.debugPort}`,
    `--user-data-dir=${masterDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    ...(restorePreviousSession
      ? ['--restore-last-session']
      : ['--new-window', getWebPlatformUrl(source.platformId)]),
  ]
}

async function startMasterSession(sourceId: string, restorePreviousSession = false): Promise<number> {
  const source = getMasterSessionSource(sourceId)
  const activePort = await findActiveMasterPort(sourceId)
  if (activePort !== null) {
    return activePort
  }

  const masterDir = getMasterProfileDir(sourceId)
  fs.mkdirSync(path.join(masterDir, 'Default'), { recursive: true })

  const chromePath = findChromePath()
  const port = source.debugPort

  const args = buildMasterSessionLaunchArgs(source, masterDir, restorePreviousSession)

  const proc = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
  })
  proc.unref()

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await isPortActive(port)) {
      return port
    }

    await new Promise(r => setTimeout(r, 500))
  }

  throw new Error(`Master Session Chrome failed to open on port ${port} within 20s.`)
}

export async function ensureMasterRunning(preferredPort = 9227): Promise<number> {
  const source = getMasterSessionSource(DEFAULT_MASTER_SESSION_SOURCE)
  if (preferredPort !== source.debugPort) {
    throw new Error('Master Session debug ports are assigned per registered account source.')
  }
  return ensureMasterSessionRunning(DEFAULT_MASTER_SESSION_SOURCE)
}

export class SessionBroker {
  private static instance: SessionBroker | null = null

  public static getInstance(): SessionBroker {
    if (!SessionBroker.instance) {
      SessionBroker.instance = new SessionBroker()
    }
    return SessionBroker.instance
  }

  /**
   * Check status of Master Session.
   */
  public async getMasterStatus(sourceId = DEFAULT_MASTER_SESSION_SOURCE): Promise<MasterSessionStatus> {
    const profileDir = getMasterProfileDir(sourceId)
    const activePort = await findActiveMasterPort(sourceId)

    if (activePort === null) {
      return {
        active: false,
        debugPort: null,
        profileDir,
        hasValidSession: false,
        authenticationState: 'unverified',
        cookieCount: 0,
        reason: 'Master session Chrome is not running',
      }
    }

    const source = getMasterSessionSource(sourceId)
    if (source.platformId === 'chatx') {
      try {
        const { verifyChatXAuth } = await import('./ChatXAuthVerifier.js')
        const result = await verifyChatXAuth(activePort)
        return {
          active: true,
          debugPort: activePort,
          profileDir,
          hasValidSession: result.hasValidSession,
          authenticationState: result.status,
          cookieCount: result.cookieCount,
          reason: result.reason,
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          active: true,
          debugPort: activePort,
          profileDir,
          hasValidSession: false,
          authenticationState: 'unverified',
          cookieCount: 0,
          reason: `Could not verify ChatX session: ${msg}`,
        }
      }
    }
    if (source.platformId === 'zai') {
      try {
        const { verifyZaiAuth } = await import('./ZaiAuthVerifier.js')
        const result = await verifyZaiAuth(activePort)
        return {
          active: true,
          debugPort: activePort,
          profileDir,
          hasValidSession: result.hasValidSession,
          authenticationState: result.status,
          cookieCount: result.cookieCount,
          reason: result.reason,
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          active: true,
          debugPort: activePort,
          profileDir,
          hasValidSession: false,
          authenticationState: 'unverified',
          cookieCount: 0,
          reason: `Could not verify Z.ai session: ${msg}`,
        }
      }
    }

    try {
      const cookies = await this.getMasterCookies(activePort, sourceId)
      const classification = classifyCookiesForPlatform(cookies, source.platformId)

      return {
        active: true,
        debugPort: activePort,
        profileDir,
        hasValidSession: classification.hasValidSession,
        authenticationState: classification.hasValidSession ? 'authenticated' : 'loginRequired',
        cookieCount: cookies.length,
        reason: classification.hasValidSession
          ? 'Authenticated session available'
          : `Master session active but requires login (no ${source.platformId === 'claude' ? 'Claude sessionKey' : 'ChatGPT session-token'} cookie)`,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        active: true,
        debugPort: activePort,
        profileDir,
        hasValidSession: false,
        authenticationState: 'unverified',
        cookieCount: 0,
        reason: `Error reading Master cookies: ${msg}`,
      }
    }
  }

  /**
   * Extract in-memory snapshot of cookies from the Master Session via CDP.
   */
  public async getMasterCookies(
    masterPort?: number,
    sourceId = DEFAULT_MASTER_SESSION_SOURCE,
  ): Promise<SessionCookieParam[]> {
    const port = masterPort ?? (await findActiveMasterPort(sourceId)) ?? (await ensureMasterSessionRunning(sourceId))
    const source = getMasterSessionSource(sourceId)
    const wsUrl = await getPageWsUrl(
      port,
      source.platformId === 'claude' ? 'claude.ai'
        : source.platformId === 'chatx' ? 'chatx.ai'
          : source.platformId === 'zai' ? 'chat.z.ai'
            : 'chatgpt.com',
    )

    await sendCdpCommand(wsUrl, 'Network.enable')
    const result = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(wsUrl, 'Network.getCookies', {
      urls: [
        ...(getMasterSessionSource(sourceId).platformId === 'claude'
          ? ['https://claude.ai']
          : getMasterSessionSource(sourceId).platformId === 'zai'
            ? ['https://chat.z.ai']
            : getMasterSessionSource(sourceId).platformId === 'chatx'
              ? ['https://chatx.ai']
              : ['https://chatgpt.com', 'https://openai.com', 'https://auth.openai.com', 'https://auth0.openai.com']),
      ],
    })

    const rawCookies = result?.cookies || []
    const platformId = getMasterSessionSource(sourceId).platformId
    return rawCookies.filter(c => isAllowedDomainForPlatform(c.domain, platformId))
  }

  /**
   * Transfer Master session cookies to a target relay via CDP Network.setCookies.
   */
  public async applySessionToRelay(
    relayPort: number,
    sourceId = DEFAULT_MASTER_SESSION_SOURCE,
    platformId: MasterSessionPlatformId = 'chatgpt',
  ): Promise<SessionTransferResult> {
    const source = getMasterSessionSource(sourceId)
    if (source.platformId === 'zai' || platformId === 'zai' ||
      source.platformId === 'chatx' || platformId === 'chatx') {
      return {
        ok: false,
        count: 0,
        hasSessionToken: false,
        reason: `${source.platformId === 'chatx' || platformId === 'chatx' ? 'ChatX' : 'Z.ai'} Master Session authentication transfer is not supported or verified.`,
      }
    }
    if (source.platformId !== platformId) {
      return {
        ok: false,
        count: 0,
        hasSessionToken: false,
        reason: `Master Session "${source.name}" is for ${source.platformId}, not ${platformId}.`,
      }
    }
    const masterStatus = await this.getMasterStatus(sourceId)
    if (!masterStatus.active) {
      return {
        ok: false,
        count: 0,
        hasSessionToken: false,
        reason: `Master Session "${source.name}" is not running. Open and authenticate that source first.`,
      }
    }
    const cookies = await this.getMasterCookies(masterStatus.debugPort ?? undefined, sourceId)
    const classification = classifyCookiesForPlatform(cookies, source.platformId)

    if (!classification.hasValidSession) {
      return {
        ok: false,
        count: 0,
        hasSessionToken: false,
        reason: `Master session has no active ${source.platformId} session cookie. Manual login required on Master.`,
      }
    }

    const relayWsUrl = await getPageWsUrl(relayPort)
    await sendCdpCommand(relayWsUrl, 'Network.enable')

    const cookiesToSet = cookies.map(c => {
      const p: SessionCookieParam = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
      }
      if (c.sameSite) p.sameSite = c.sameSite
      if (c.expires && c.expires > 0) p.expires = c.expires
      if (c.priority) p.priority = c.priority
      if (c.partitionKey) p.partitionKey = c.partitionKey
      return p
    })

    try {
      await sendCdpCommand(relayWsUrl, 'Network.setCookies', { cookies: cookiesToSet })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        count: 0,
        hasSessionToken: false,
        reason: `Network.setCookies failed on relay: ${msg}`,
      }
    }

    // Verify cookies in relay jar
    const verification = await this.verifyRelayCookies(relayPort, platformId)
    if (!verification.hasSessionToken) {
      return {
        ok: false,
        count: verification.count,
        hasSessionToken: false,
        reason: `Cookies transferred but no active ${platformId} session cookie was found in the Relay cookie jar.`,
      }
    }

    return {
      ok: true,
      count: verification.count,
      hasSessionToken: true,
    }
  }

  /**
   * Verify that expected session cookies exist in relay's network jar.
   */
  public async verifyRelayCookies(
    relayPort: number,
    platformId: MasterSessionPlatformId = 'chatgpt',
  ): Promise<{ ok: boolean; count: number; hasSessionToken: boolean }> {
    if (platformId === 'zai' || platformId === 'chatx') {
      return { ok: false, count: 0, hasSessionToken: false }
    }
    try {
      const relayWsUrl = await getPageWsUrl(relayPort)
      await sendCdpCommand(relayWsUrl, 'Network.enable')
      const result = await sendCdpCommand<{ cookies: SessionCookieParam[] }>(relayWsUrl, 'Network.getCookies', {
        urls: platformId === 'claude'
          ? ['https://claude.ai']
          : ['https://chatgpt.com', 'https://openai.com', 'https://auth.openai.com'],
      })
      const cookies = (result?.cookies || []).filter(c => isAllowedDomainForPlatform(c.domain, platformId))
      const classification = classifyCookiesForPlatform(cookies, platformId)

      return {
        ok: classification.hasValidSession,
        count: cookies.length,
        hasSessionToken: classification.hasValidSession,
      }
    } catch {
      return { ok: false, count: 0, hasSessionToken: false }
    }
  }
}
