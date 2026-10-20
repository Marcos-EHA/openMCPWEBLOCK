/**
 * LocalInstanceDetector — Discovers locally installed AI platforms.
 *
 * Scans the system for known local AI tools (Antigravity, Claude Desktop, VS Code, Claude Code)
 * by checking PATH, well-known installation directories, MSIX packages, and config files.
 * Only performs read-only detection; does not modify or launch anything.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { LOCAL_PLATFORMS, type DetectedLocalPlatform, type LocalPlatform } from '../../utils/localPlatforms.js'

function expandEnvPath(template: string): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, envName: string) => {
    return process.env[envName] ?? ''
  })
}

async function whichExecutable(name: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('where.exe', [name], { timeout: 5000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(undefined)
        return
      }
      const firstLine = stdout.trim().split(/\r?\n/)[0]
      resolve(firstLine || undefined)
    })
  })
}

/**
 * Detect MSIX/Store app via PowerShell Get-AppxPackage.
 * Returns the install location and version if found.
 */
async function detectMsixPackage(packageName: string): Promise<{
  installed: boolean
  installLocation?: string
  version?: string
}> {
  return new Promise(resolve => {
    const ps = `Get-AppxPackage -Name "${packageName}" | ConvertTo-Json -Compress`
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], {
      timeout: 10000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve({ installed: false })
        return
      }
      try {
        const pkg = JSON.parse(stdout.trim())
        resolve({
          installed: true,
          installLocation: pkg.InstallLocation,
          version: pkg.Version,
        })
      } catch {
        resolve({ installed: false })
      }
    })
  })
}

/**
 * Detect whether a single local platform is installed.
 */
export async function detectLocalPlatform(platform: LocalPlatform): Promise<DetectedLocalPlatform> {
  const detection = platform.detection
  let executablePath: string | undefined
  let configFilePath: string | undefined
  let version: string | undefined

  // ── MSIX detection (Claude Desktop) ──
  if (detection.detectCommand && platform.launchMethod === 'msix') {
    // Extract the package name from the command (e.g. "Claude" from Get-AppxPackage -Name "Claude")
    const match = detection.detectCommand.match(/-Name\s+"([^"]+)"/)
    if (match) {
      const msix = await detectMsixPackage(match[1])
      if (msix.installed) {
        // For MSIX apps, we store the install location as the "executable path"
        // even though we can't spawn it directly. The launchMethod handles the rest.
        executablePath = msix.installLocation
        version = msix.version
      }
    }
  }

  // ── Standard detection: check well-known Windows paths ──
  if (!executablePath && detection.windowsPaths) {
    for (const template of detection.windowsPaths) {
      const resolved = expandEnvPath(template)
      if (resolved && existsSync(resolved)) {
        executablePath = resolved
        break
      }
    }
  }

  // ── Fall back to PATH lookup ──
  if (!executablePath && detection.executableName) {
    executablePath = await whichExecutable(detection.executableName)
  }

  // ── Check config file ──
  if (detection.configPath) {
    const resolved = expandEnvPath(detection.configPath)
    if (resolved && existsSync(resolved)) {
      configFilePath = resolved
    }
  }

  return {
    ...platform,
    installed: Boolean(executablePath) || Boolean(configFilePath),
    executablePath,
    configFilePath,
    version,
  }
}

export interface RunningProcess {
  pid: number
  name: string
  executablePath?: string
}

/**
 * Find running processes that match known local AI platform executables.
 * Returns PID + executable path for each match so we can attach without re-launching.
 *
 * Uses the platform's `processName` field (which may differ from the detection
 * executable name — e.g. Claude Desktop runs as "claude.exe" but is detected
 * via AppxPackage, not by file path).
 */
export async function findRunningLocalProcess(platform: LocalPlatform): Promise<RunningProcess | undefined> {
  // Prefer processName (the actual running process image name) over detection executable
  const exeName = platform.processName || platform.detection.executableName
  if (!exeName) return undefined

  return new Promise(resolve => {
    // Use tasklist with image name filter — fast, no admin needed
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/FO', 'CSV', '/NH'], {
      timeout: 5000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(undefined)
        return
      }
      // CSV format: "Name","PID","Session Name","Session#","Mem Usage"
      const lines = stdout.trim().split(/\r?\n/).filter(line => line.includes(exeName))
      if (!lines.length) {
        resolve(undefined)
        return
      }
      const parts = lines[0].split(',').map(s => s.replace(/"/g, '').trim())
      const pid = parseInt(parts[1], 10)
      if (!Number.isFinite(pid) || pid <= 0) {
        resolve(undefined)
        return
      }
      resolve({ pid, name: parts[0] || exeName })
    })
  })
}

export async function waitForRunningLocalProcess(
  platform: LocalPlatform,
  retryDelaysMs: readonly number[],
  findProcess: (target: LocalPlatform) => Promise<RunningProcess | undefined> = findRunningLocalProcess,
): Promise<RunningProcess> {
  for (const delayMs of retryDelaysMs) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const running = await findProcess(platform)
    if (running) return running
  }
  throw new Error(
    `${platform.name} did not start: no running application process was detected after ` +
    `${retryDelaysMs.length} checks (${retryDelaysMs.reduce((total, delay) => total + delay, 0)}ms).`,
  )
}

/**
 * Detect all registered local platforms and return their installation status.
 */
export async function detectAllLocalPlatforms(): Promise<DetectedLocalPlatform[]> {
  return Promise.all(LOCAL_PLATFORMS.map(detectLocalPlatform))
}

/**
 * Return only the platforms that are detected as installed.
 */
export async function getInstalledLocalPlatforms(): Promise<DetectedLocalPlatform[]> {
  const all = await detectAllLocalPlatforms()
  return all.filter(platform => platform.installed)
}
