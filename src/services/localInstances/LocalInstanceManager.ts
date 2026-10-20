/**
 * LocalInstanceManager — Manages the lifecycle of local AI instances.
 *
 * Responsible for:
 * - Spawning local AI processes (Antigravity, Claude Desktop, VS Code, Claude Code)
 * - Tracking their lifecycle state (created → starting → ready → stopped)
 * - Health checking running instances
 * - Stopping and cleaning up instances
 * - Broadcasting state changes for the Workspace UI
 *
 * Each local instance gets a unique ID and is tracked in an in-memory registry.
 * Instances can participate in the Workspace as workers via the participant system.
 */

import { spawn, type ChildProcess, execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { detectLocalPlatform, waitForRunningLocalProcess } from './LocalInstanceDetector.js'
import { getLocalPlatformById, type LocalPlatform } from '../../utils/localPlatforms.js'

const APP_PROCESS_RETRY_DELAYS_MS = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
const MSIX_PROCESS_RETRY_DELAYS_MS = [1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500]

export type LocalInstanceStatus =
  | 'created'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopped'
  | 'not-installed'

export interface LocalInstance {
  id: string
  platformId: string
  platformName: string
  status: LocalInstanceStatus
  pid?: number
  executablePath?: string
  /** Working directory passed to the instance */
  workingDirectory?: string
  /** MCP server URL if the instance exposes one */
  mcpUrl?: string
  createdAt: number
  startedAt?: number
  stoppedAt?: number
  error?: string
  /** Whether this instance is registered as a Workspace participant */
  workspaceWorker: boolean
  /** Whether this instance was attached (already running) vs spawned by us */
  attached: boolean
  /** Active account/profile label (user-facing, e.g. "elias@gmail.com") */
  accountLabel?: string
  /** Internal account/profile identifier (e.g. profile path, account id) */
  accountId?: string
  /** Active conversation/project identifier in the local app */
  conversationId?: string
}

export type LocalInstanceEvent =
  | { type: 'instance-created'; instance: LocalInstance }
  | { type: 'instance-updated'; instance: LocalInstance }
  | { type: 'instance-removed'; instanceId: string }

const MAX_INSTANCES = 10

export class LocalInstanceManager {
  private instances = new Map<string, LocalInstance>()
  private processes = new Map<string, ChildProcess>()
  private listeners = new Set<(event: LocalInstanceEvent) => void>()

  subscribe(listener: (event: LocalInstanceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: LocalInstanceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* ignore */ }
    }
  }

  listInstances(): LocalInstance[] {
    return [...this.instances.values()]
  }

  getInstance(id: string): LocalInstance | undefined {
    return this.instances.get(id)
  }

  /**
   * Update the active account/profile for a local instance.
   * This is a metadata-only update — the actual account switching
   * happens inside the app itself. The Workspace tracks which
   * account is in use for display and routing purposes.
   */
  updateAccount(
    id: string,
    account: { accountLabel?: string; accountId?: string; conversationId?: string },
  ): LocalInstance | undefined {
    const instance = this.instances.get(id)
    if (!instance) return undefined
    if (account.accountLabel !== undefined) instance.accountLabel = account.accountLabel
    if (account.accountId !== undefined) instance.accountId = account.accountId
    if (account.conversationId !== undefined) instance.conversationId = account.conversationId
    this.emit({ type: 'instance-updated', instance: { ...instance } })
    return { ...instance }
  }

  /**
   * Launch or attach to a local AI instance.
   *
   * Design principle: **zero re-login**.
   * 1. First checks if the app is already running → attaches to the existing PID.
   * 2. If not running, launches it with its default profile (preserving saved session).
   * 3. Never creates isolated/clean profiles for local apps — they use their own auth.
   *
   * @param platformId - Which platform (antigravity, claude-desktop, vscode, claude-code)
   * @param options - Launch configuration
   * @returns The instance record (attached or newly launched)
   */
  async launch(
    platformId: string,
    options: {
      workingDirectory?: string
      registerAsWorker?: boolean
      /** Extra args to pass to the executable */
      extraArgs?: string[]
    } = {},
  ): Promise<LocalInstance> {
    if (this.instances.size >= MAX_INSTANCES) {
      throw new Error(`Maximum of ${MAX_INSTANCES} local instances reached. Stop an existing instance first.`)
    }

    const platform = getLocalPlatformById(platformId)
    if (!platform) {
      throw new Error(`Unknown local platform: "${platformId}". Available: antigravity, claude-desktop, vscode, claude-code.`)
    }

    // Check if we already track an instance of this platform that is alive
    const existing = [...this.instances.values()].find(
      instance => instance.platformId === platformId &&
        (instance.status === 'ready' || instance.status === 'starting'),
    )
    if (existing) {
      return existing
    }

    const detected = await detectLocalPlatform(platform)
    if (!detected.installed) {
      const instance = this.createInstance(platform, options)
      instance.status = 'not-installed'
      instance.error = `${platform.name} is not installed or could not be found on this system.`
      this.instances.set(instance.id, instance)
      this.emit({ type: 'instance-created', instance })
      return instance
    }

    // ── Key: detect if the app is already running and ATTACH (no re-login) ──
    const { findRunningLocalProcess } = await import('./LocalInstanceDetector.js')
    const runningProcess = await findRunningLocalProcess(platform)

    if (runningProcess) {
      // App is already open with the user's session → just register it
      const instance = this.createInstance(platform, options)
      instance.executablePath = detected.executablePath
      instance.pid = runningProcess.pid
      instance.status = 'ready'
      instance.startedAt = Date.now()
      instance.attached = true
      this.instances.set(instance.id, instance)
      this.emit({ type: 'instance-created', instance })
      return instance
    }

    // App is NOT running → launch it
    const instance = this.createInstance(platform, options)
    instance.executablePath = detected.executablePath
    this.instances.set(instance.id, instance)
    this.emit({ type: 'instance-created', instance })

    try {
      await this.spawnProcess(instance, platform, detected, options)
    } catch (error) {
      instance.status = 'error'
      instance.error = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'instance-updated', instance })
    }

    return instance
  }

  /**
   * Stop a running local instance.
   *
   * IMPORTANT: If the instance was attached (already running before we registered it),
   * we ONLY unregister it — we do NOT kill the user's application.
   * Only instances that we spawned ourselves get terminated.
   */
  async stop(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId)
    if (!instance) throw new Error(`Local instance "${instanceId}" not found.`)

    const proc = this.processes.get(instanceId)
    if (proc && !proc.killed) {
      // This instance was spawned by OpenMCP → terminate it
      if (process.platform === 'win32' && proc.pid) {
        // On Windows, use taskkill to kill the full process tree (Electron/Chromium children)
        try {
          await new Promise<void>((resolve, reject) => {
            execFile('taskkill', ['/F', '/T', '/PID', String(proc.pid)], (error) => {
              if (error) reject(error)
              else resolve()
            })
          })
        } catch {
          // Fallback: try direct kill
          if (!proc.killed) proc.kill('SIGTERM')
        }
      } else {
        // Non-Windows: graceful SIGTERM then force SIGKILL after 5s
        proc.kill('SIGTERM')
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL')
            resolve()
          }, 5000)
          proc.on('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    }
    // If no proc in this.processes → this was an attached (already-running) process.
    // Do NOT kill the user's app; just unregister it from the workspace.

    instance.status = 'stopped'
    instance.stoppedAt = Date.now()
    this.processes.delete(instanceId)
    this.emit({ type: 'instance-updated', instance })
  }

  /**
   * Remove a stopped instance from the registry.
   */
  remove(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance) throw new Error(`Local instance "${instanceId}" not found.`)
    if (instance.status !== 'stopped' && instance.status !== 'error' && instance.status !== 'not-installed') {
      throw new Error(`Cannot remove instance "${instanceId}" while it is ${instance.status}. Stop it first.`)
    }
    this.instances.delete(instanceId)
    this.processes.delete(instanceId)
    this.emit({ type: 'instance-removed', instanceId })
  }

  /**
   * Clean up all instances (for shutdown).
   */
  async stopAll(): Promise<void> {
    const running = [...this.instances.values()].filter(instance =>
      instance.status === 'ready' || instance.status === 'starting',
    )
    await Promise.allSettled(running.map(instance => this.stop(instance.id)))
  }

  // ── Private helpers ──

  private createInstance(
    platform: LocalPlatform,
    options: { workingDirectory?: string; registerAsWorker?: boolean },
  ): LocalInstance {
    return {
      id: `local-${platform.id}-${randomUUID().slice(0, 8)}`,
      platformId: platform.id,
      platformName: platform.name,
      status: 'created',
      workingDirectory: options.workingDirectory,
      workspaceWorker: options.registerAsWorker ?? false,
      createdAt: Date.now(),
      attached: false,
    }
  }

  private async spawnProcess(
    instance: LocalInstance,
    platform: LocalPlatform,
    detected: { executablePath?: string; configFilePath?: string },
    options: { workingDirectory?: string; extraArgs?: string[] },
  ): Promise<void> {
    instance.status = 'starting'
    this.emit({ type: 'instance-updated', instance })

    const cwd = options.workingDirectory || process.cwd()

    switch (platform.launchMethod) {
      case 'msix':
        await this.launchMsixApp(instance, platform, cwd)
        break

      case 'spawn':
        await this.launchSpawnProcess(instance, detected, platform, options)
        break

      case 'cli-command':
        await this.launchSpawnProcess(instance, detected, platform, options)
        break

      default:
        throw new Error(`Unknown launch method "${platform.launchMethod}" for ${platform.name}.`)
    }
  }

  /**
   * Launch an MSIX/Store app (e.g. Claude Desktop) using the shell:AppsFolder protocol.
   * This is the correct way to start Store/MSIX apps on Windows — you cannot spawn their
   * executable directly because it lives inside the protected WindowsApps directory.
   */
  private async launchMsixApp(
    instance: LocalInstance,
    platform: LocalPlatform,
    _cwd: string,
  ): Promise<void> {
    const appId = platform.msixAppId
    if (!appId) {
      throw new Error(`No MSIX AppId configured for ${platform.name}.`)
    }

    // Launch via explorer.exe shell:AppsFolder\<AppId>
    const proc = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    let spawnError: Error | undefined
    proc.once('error', error => { spawnError = error })
    proc.unref()

    // explorer.exe exits immediately after launching the app.
    // MSIX apps can take several seconds to initialize, so wait for the real process.
    let running
    try {
      running = await waitForRunningLocalProcess(platform, MSIX_PROCESS_RETRY_DELAYS_MS)
    } catch (error) {
      if (spawnError) throw new Error(`Could not open ${platform.name} from AppsFolder: ${spawnError.message}`)
      throw error
    }
    instance.pid = running.pid
    instance.startedAt = Date.now()
    instance.status = 'ready'
    instance.attached = true
    this.emit({ type: 'instance-updated', instance })
  }

  /**
   * Launch a standard executable (Antigravity, VS Code, Claude Code).
   *
   * VS Code and Antigravity launchers (code.cmd, Antigravity.exe) spawn a child
   * process and exit immediately. For these, we use a retry-PID pattern like
   * MSIX apps: launch, then detect the real running process.
   * Claude Code CLI stays alive as a foreground process, so we track it directly.
   */
  private async launchSpawnProcess(
    instance: LocalInstance,
    detected: { executablePath?: string; configFilePath?: string },
    platform: LocalPlatform,
    options: { workingDirectory?: string; extraArgs?: string[] },
  ): Promise<void> {
    if (!detected.executablePath) {
      throw new Error(`No executable found for ${instance.platformName}.`)
    }

    const args = this.buildLaunchArgs(platform.id, options)

    // VS Code and Antigravity launchers exit immediately after spawning the
    // real Electron/Node process. We use fire-and-detect instead of tracking
    // the child process directly.
    const isLauncherExitsImmediately = platform.id === 'vscode' || platform.id === 'antigravity'

    const proc = spawn(detected.executablePath, args, {
      cwd: options.workingDirectory || process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    let spawnError: Error | undefined
    proc.once('error', error => { spawnError = error })

    proc.unref()

    if (isLauncherExitsImmediately) {
      // The launcher will exit on its own — don't track it as the instance process.
      // Instead, retry PID detection like MSIX apps.
      let running
      try {
        running = await waitForRunningLocalProcess(platform, APP_PROCESS_RETRY_DELAYS_MS)
      } catch (error) {
        if (spawnError) throw new Error(`Could not launch ${platform.name}: ${spawnError.message}`)
        throw error
      }
      instance.pid = running.pid
      instance.startedAt = Date.now()
      instance.status = 'ready'
      instance.attached = true
      this.emit({ type: 'instance-updated', instance })
      return
    }

    // Claude Code CLI: stays alive, track it directly
    if (!proc.pid) {
      throw new Error(`Failed to start ${instance.platformName}: no PID returned.`)
    }

    instance.pid = proc.pid
    instance.startedAt = Date.now()
    instance.status = 'ready'
    this.processes.set(instance.id, proc)

    proc.on('exit', (code) => {
      const current = this.instances.get(instance.id)
      if (current && current.status !== 'stopped') {
        current.status = code === 0 ? 'stopped' : 'error'
        current.stoppedAt = Date.now()
        if (code !== 0 && code !== null) {
          current.error = `Process exited with code ${code}.`
        }
        this.emit({ type: 'instance-updated', instance: current })
      }
      this.processes.delete(instance.id)
    })

    proc.on('error', (error) => {
      const current = this.instances.get(instance.id)
      if (current) {
        current.status = 'error'
        current.error = error.message
        this.emit({ type: 'instance-updated', instance: current })
      }
    })

    this.emit({ type: 'instance-updated', instance })
  }

  private buildLaunchArgs(platformId: string, options: { workingDirectory?: string; extraArgs?: string[] }): string[] {
    const extra = options.extraArgs ?? []

    switch (platformId) {
      case 'antigravity':
        // Antigravity.exe launches the Electron app directly
        return [...extra]

      case 'vscode':
        // VS Code: open the working directory as a workspace folder
        if (options.workingDirectory) {
          return [options.workingDirectory, ...extra]
        }
        return [...extra]

      case 'claude-code':
        // Claude Code CLI — could be launched with specific flags
        return [...extra]

      default:
        return [...extra]
    }
  }
}

// Singleton instance
let manager: LocalInstanceManager | null = null

export function getLocalInstanceManager(): LocalInstanceManager {
  if (!manager) manager = new LocalInstanceManager()
  return manager
}
