import { execFile as execFileCallback } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'

const execFile = promisify(execFileCallback)

export interface ChromeProfileSource {
  id: string
  name: string
}

export interface ChromeLocalState {
  os_crypt?: Record<string, unknown>
  profile?: {
    info_cache?: Record<string, ChromeProfileInfo>
    last_used?: string
    last_active_profiles?: string[]
  }
}

interface ChromeProfileInfo {
  name?: string
  gaia_name?: string
  [key: string]: unknown
}

export interface ChromeProfileCopyDiagnostics {
  copied: boolean
  profileMatches: boolean | null
  copiedAt: number | null
  cookieDatabase: 'unchanged' | 'changed' | 'missing' | 'not-recorded' | 'unavailable'
  cookieDatabaseReadIssue?: string
}

interface ChromeProfileCopyMarker {
  profileId?: string
  copiedAt?: number
  cookieDatabasePath?: 'Default/Network/Cookies' | 'Default/Cookies'
  cookieDatabaseSha256?: string
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function compareChromeProfileCookieDatabaseSnapshot(
  marker: ChromeProfileCopyMarker,
  cookieDatabaseExists: boolean,
  currentSha256?: string,
): ChromeProfileCopyDiagnostics['cookieDatabase'] {
  if (!marker.cookieDatabasePath || !marker.cookieDatabaseSha256) return 'not-recorded'
  if (!cookieDatabaseExists) return 'missing'
  if (!currentSha256) return 'unavailable'
  return currentSha256 === marker.cookieDatabaseSha256 ? 'unchanged' : 'changed'
}

export function describeChromeProfileCookieDatabaseReadIssue(error: unknown): string | undefined {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined
  if (code === 'EBUSY') {
    return 'Chrome currently locks the cookie database; retry this diagnostic after it is available.'
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'The cookie database is not readable for this diagnostic.'
  }
  return undefined
}

export function getChromeUserDataDirectory(): string {
  if (process.platform !== 'win32') {
    throw new Error('La selección de perfiles locales de Chrome está disponible por ahora en Windows.')
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'Google', 'Chrome', 'User Data')
}

export function parseChromeProfileSources(state: ChromeLocalState): ChromeProfileSource[] {
  const profileInfo = state.profile?.info_cache
  if (!profileInfo || typeof profileInfo !== 'object' || Array.isArray(profileInfo)) return []

  return Object.entries(profileInfo)
    .filter(([id, value]) =>
      (id === 'Default' || /^Profile \d+$/u.test(id)) &&
      value !== null && typeof value === 'object',
    )
    .map(([id, value]) => ({
      id,
      name: typeof value.gaia_name === 'string' && value.gaia_name.trim()
        ? value.gaia_name.trim()
        : typeof value.name === 'string' && value.name.trim()
          ? value.name.trim()
          : id,
    }))
    .sort((left, right) => left.id === 'Default' ? -1 : right.id === 'Default' ? 1 : left.id.localeCompare(right.id))
}

export function listChromeProfileSources(): ChromeProfileSource[] {
  if (process.platform !== 'win32') return []
  const localStatePath = path.join(getChromeUserDataDirectory(), 'Local State')
  if (!fs.existsSync(localStatePath)) return []

  let state: ChromeLocalState
  try {
    state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as ChromeLocalState
  } catch (error) {
    throw new Error(
      `No se pudo leer el registro de perfiles de Chrome: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseChromeProfileSources(state)
}

export function getBlockingChromeProfileProcessIds(
  processes: unknown,
  userDataDirectory: string,
): number[] {
  const processList = Array.isArray(processes) ? processes : [processes]
  const normalizedUserDataDirectory = path.resolve(userDataDirectory).replace(/\\/g, '/').toLowerCase()
  const blockingProcessIds: number[] = []
  for (const processInfo of processList) {
    if (processInfo === null || typeof processInfo !== 'object') {
      throw new Error('No se pudo confirmar que Chrome esté cerrado; no se copiará el perfil.')
    }
    const processRecord = processInfo as Record<string, unknown>
    const processId = processRecord.processId
    const commandLine = processRecord.commandLine
    if (
      typeof processId !== 'number' ||
      (commandLine !== null && commandLine !== undefined && typeof commandLine !== 'string')
    ) {
      throw new Error('No se pudo confirmar que Chrome esté cerrado; no se copiará el perfil.')
    }
    const command = typeof commandLine === 'string' ? commandLine : ''
    const normalizedCommand = command.replace(/\\/g, '/').toLowerCase()
    const userDataArgument = normalizedCommand.match(/--user-data-dir=(?:"([^"]+)"|([^\s"]+))/u)
    const processUserDataDirectory = userDataArgument?.[1] ?? userDataArgument?.[2]
    if (
      !processUserDataDirectory ||
      path.resolve(processUserDataDirectory).replace(/\\/g, '/').toLowerCase() === normalizedUserDataDirectory
    ) {
      blockingProcessIds.push(processId)
    }
  }
  return blockingProcessIds
}

async function listBlockingDefaultChromeProcessIds(userDataDirectory: string): Promise<number[]> {
  let stdout: string
  try {
    const result = await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; " +
        "$p=Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | " +
        "Where-Object { !$_.CommandLine -or $_.CommandLine -notmatch '--type=' } | " +
        "Select-Object @{Name='processId';Expression={$_.ProcessId}}, @{Name='commandLine';Expression={$_.CommandLine}}; " +
        "if ($null -eq $p) { '[]' } else { ConvertTo-Json -InputObject @($p) -Compress }",
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    stdout = result.stdout
  } catch (error) {
    throw new Error(
      `No se pudo comprobar si Chrome está usando el perfil normal; no se copiará por seguridad. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let processes: unknown
  try {
    processes = JSON.parse(stdout.trim() || '[]')
  } catch (error) {
    throw new Error(
      `No se pudo interpretar el estado de Chrome; no se copiará el perfil por seguridad. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const blockingProcessIds = getBlockingChromeProfileProcessIds(processes, userDataDirectory)
  return blockingProcessIds
}

function formatBlockingChromeMessage(blockingProcessIds: number[]): string {
  const processLabel = blockingProcessIds.length === 1
    ? `PID ${blockingProcessIds[0]}`
    : `PIDs ${blockingProcessIds.join(', ')}`
  return (
    `Chrome sigue usando el perfil normal (${processLabel}), posiblemente en segundo plano. ` +
    `Guarda tu trabajo y cierra Chrome por completo. Si persiste, abre chrome://settings/system y desactiva ` +
    `«Seguir ejecutando aplicaciones en segundo plano al cerrar Google Chrome». ` +
    `No se copió el perfil.`
  )
}

async function assertDefaultChromeIsClosed(userDataDirectory: string): Promise<void> {
  const blockingProcessIds = await listBlockingDefaultChromeProcessIds(userDataDirectory)
  if (blockingProcessIds.length > 0) {
    throw new Error(formatBlockingChromeMessage(blockingProcessIds))
  }
}

export async function closeChromeBeforeProfileCopy(profileId: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('La copia aislada de perfiles locales de Chrome está disponible por ahora en Windows.')
  }
  if (profileId !== 'Default' && !/^Profile \d+$/u.test(profileId)) {
    throw new Error('El perfil local de Chrome seleccionado no es válido.')
  }
  if (!listChromeProfileSources().some(profile => profile.id === profileId)) {
    throw new Error('El perfil de Chrome seleccionado ya no está disponible.')
  }

  const userDataDirectory = getChromeUserDataDirectory()
  const blockingProcessIds = await listBlockingDefaultChromeProcessIds(userDataDirectory)
  if (blockingProcessIds.length === 0) return

  const escapedUserDataDirectory = userDataDirectory.replace(/'/g, "''")
  const requestGracefulClose =
    "$ErrorActionPreference='Stop'; " +
    `$blockingIds=@(${blockingProcessIds.join(',')}); ` +
    "$processes=Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | " +
    "Where-Object { $blockingIds -contains $_.ProcessId -and (!$_.CommandLine -or $_.CommandLine -notmatch '--type=') }; " +
    "if ($null -eq $processes) { exit 0 }; " +
    "$executable=($processes | Select-Object -First 1).ExecutablePath; " +
    "if (!$executable) { throw 'Chrome executable path is unavailable.' }; " +
    `$userDataDirectory='${escapedUserDataDirectory}'; ` +
    "$arguments='--user-data-dir=\"' + $userDataDirectory + '\" chrome://quit'; " +
    "Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden | Out-Null"
  try {
    await execFile('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      requestGracefulClose,
    ], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  } catch (error) {
    throw new Error(
      `OpenMCP no pudo solicitar a Chrome un cierre normal; no se copiará el perfil. ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if ((await listBlockingDefaultChromeProcessIds(userDataDirectory)).length === 0) return
  }

  const remainingProcessIds = await listBlockingDefaultChromeProcessIds(userDataDirectory)
  throw new Error(
    `OpenMCP solicitó el cierre normal de Chrome, pero el proceso sigue activo. ` +
    `${formatBlockingChromeMessage(remainingProcessIds)} No se forzó ni terminó ningún proceso.`,
  )
}

export async function assertChromeProfileCopyAllowed(profileId: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('La copia aislada de perfiles locales de Chrome está disponible por ahora en Windows.')
  }
  if (profileId !== 'Default' && !/^Profile \d+$/u.test(profileId)) {
    throw new Error('El perfil local de Chrome seleccionado no es válido.')
  }
  const profileSource = listChromeProfileSources().find(profile => profile.id === profileId)
  if (!profileSource) throw new Error('El perfil de Chrome seleccionado ya no está disponible.')
  await assertDefaultChromeIsClosed(getChromeUserDataDirectory())
}

export function inspectChromeProfileCopy(
  profileId: string,
  relayUserDataDirectory: string,
): ChromeProfileCopyDiagnostics {
  if (profileId !== 'Default' && !/^Profile \d+$/u.test(profileId)) {
    throw new Error('El perfil local de Chrome seleccionado no es válido.')
  }
  const markerPath = path.join(relayUserDataDirectory, '.openmcp-chrome-profile-copy.json')
  if (!fs.existsSync(markerPath)) {
    return {
      copied: false,
      profileMatches: null,
      copiedAt: null,
      cookieDatabase: 'not-recorded',
    }
  }

  let marker: ChromeProfileCopyMarker
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ChromeProfileCopyMarker
  } catch (error) {
    throw new Error(`No se pudo leer el marcador de copia del perfil Chrome: ${String(error)}`)
  }
  const profileMatches = marker.profileId === profileId
  if (!profileMatches) {
    return {
      copied: true,
      profileMatches: false,
      copiedAt: typeof marker.copiedAt === 'number' ? marker.copiedAt : null,
      cookieDatabase: 'not-recorded',
    }
  }

  if (!marker.cookieDatabasePath || !marker.cookieDatabaseSha256) {
    return {
      copied: true,
      profileMatches: true,
      copiedAt: typeof marker.copiedAt === 'number' ? marker.copiedAt : null,
      cookieDatabase: 'not-recorded',
    }
  }
  const cookieDatabasePath = path.join(relayUserDataDirectory, ...marker.cookieDatabasePath.split('/'))
  const exists = fs.existsSync(cookieDatabasePath)
  let currentSha256: string | undefined
  let cookieDatabaseReadIssue: string | undefined
  if (exists) {
    try {
      currentSha256 = sha256File(cookieDatabasePath)
    } catch (error) {
      cookieDatabaseReadIssue = describeChromeProfileCookieDatabaseReadIssue(error)
      if (!cookieDatabaseReadIssue) {
        throw new Error(
          `Could not read the copied Chrome cookie database for diagnostics: ${String(error)}`,
        )
      }
    }
  }
  return {
    copied: true,
    profileMatches: true,
    copiedAt: typeof marker.copiedAt === 'number' ? marker.copiedAt : null,
    cookieDatabase: cookieDatabaseReadIssue
      ? 'unavailable'
      : compareChromeProfileCookieDatabaseSnapshot(marker, exists, currentSha256),
    ...(cookieDatabaseReadIssue ? { cookieDatabaseReadIssue } : {}),
  }
}

function remapCopiedLocalState(localStatePath: string, profileInfo: ChromeProfileInfo): void {
  const state = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as ChromeLocalState
  const safeProfileInfo: ChromeProfileInfo = {
    ...(typeof profileInfo.name === 'string' ? { name: profileInfo.name } : {}),
    ...(typeof profileInfo.gaia_name === 'string' ? { gaia_name: profileInfo.gaia_name } : {}),
  }
  const sanitizedState: ChromeLocalState = {
    ...(state.os_crypt ? { os_crypt: state.os_crypt } : {}),
    profile: {
      info_cache: { Default: safeProfileInfo },
      last_used: 'Default',
      last_active_profiles: ['Default'],
    },
  }
  fs.writeFileSync(localStatePath, JSON.stringify(sanitizedState), { encoding: 'utf8', mode: 0o600 })
}

export async function copyChromeProfileToRelay(
  profileId: string,
  relayUserDataDirectory: string,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('La copia aislada de perfiles locales de Chrome está disponible por ahora en Windows.')
  }
  if (profileId !== 'Default' && !/^Profile \d+$/u.test(profileId)) {
    throw new Error('El perfil local de Chrome seleccionado no es válido.')
  }

  const userDataDirectory = getChromeUserDataDirectory()
  const markerPath = path.join(relayUserDataDirectory, '.openmcp-chrome-profile-copy.json')
  if (fs.existsSync(markerPath)) {
    let marker: { profileId?: string } | undefined
    try {
      marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { profileId?: string }
    } catch (error) {
      throw new Error(`No se pudo verificar la copia previa del perfil Chrome: ${String(error)}`)
    }
    if (marker?.profileId !== profileId) {
      throw new Error('Este Relay ya contiene una copia de otro perfil Chrome; no se sobrescribirá.')
    }
    return
  }

  await assertChromeProfileCopyAllowed(profileId)
  const profileSource = listChromeProfileSources().find(profile => profile.id === profileId)
  if (!profileSource) throw new Error('El perfil de Chrome seleccionado ya no está disponible.')

  const sourceProfileDirectory = path.join(userDataDirectory, profileId)
  if (!fs.existsSync(path.join(sourceProfileDirectory, 'Preferences'))) {
    throw new Error(`El perfil Chrome "${profileSource.name}" no contiene una configuración completa.`)
  }

  const copiedProfileDirectory = path.join(relayUserDataDirectory, 'Default')
  const sourceLocalState = path.join(userDataDirectory, 'Local State')
  if (fs.existsSync(copiedProfileDirectory) || fs.existsSync(path.join(relayUserDataDirectory, 'Local State'))) {
    throw new Error('El directorio Relay ya contiene datos Chrome sin una marca de copia verificable; no se sobrescribirá.')
  }
  const relayDirectoryExisted = fs.existsSync(relayUserDataDirectory)
  const profileDataEntries = [
    'Preferences',
    'Secure Preferences',
    'Cookies',
    'Network',
    'Local Storage',
    'IndexedDB',
    'Session Storage',
    'Storage',
    'Databases',
  ]
  try {
    await fs.promises.mkdir(relayUserDataDirectory, { recursive: true })
    await fs.promises.mkdir(copiedProfileDirectory, { recursive: true })
    for (const entry of profileDataEntries) {
      const source = path.join(sourceProfileDirectory, entry)
      if (!fs.existsSync(source)) continue
      await fs.promises.cp(source, path.join(copiedProfileDirectory, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
    }
    await fs.promises.copyFile(sourceLocalState, path.join(relayUserDataDirectory, 'Local State'))
    const localState = JSON.parse(fs.readFileSync(sourceLocalState, 'utf8')) as ChromeLocalState
    const info = localState.profile?.info_cache?.[profileId]
    if (!info) throw new Error('Chrome ya no tiene metadatos para el perfil seleccionado.')
    remapCopiedLocalState(path.join(relayUserDataDirectory, 'Local State'), info)
    const cookieDatabaseCandidates = [
      'Default/Network/Cookies',
      'Default/Cookies',
    ] as const
    const cookieDatabasePath = cookieDatabaseCandidates.find(relativePath =>
      fs.existsSync(path.join(relayUserDataDirectory, ...relativePath.split('/'))),
    )
    const marker: ChromeProfileCopyMarker = {
      profileId,
      copiedAt: Date.now(),
      ...(cookieDatabasePath ? {
        cookieDatabasePath,
        cookieDatabaseSha256: sha256File(path.join(relayUserDataDirectory, ...cookieDatabasePath.split('/'))),
      } : {}),
    }
    fs.writeFileSync(markerPath, JSON.stringify(marker), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    if (!relayDirectoryExisted) {
      await fs.promises.rm(relayUserDataDirectory, { recursive: true, force: true })
    } else {
      await fs.promises.rm(copiedProfileDirectory, { recursive: true, force: true })
      await fs.promises.rm(path.join(relayUserDataDirectory, 'Local State'), { force: true })
      await fs.promises.rm(markerPath, { force: true })
    }
    throw new Error(
      `No se pudo crear una copia aislada del perfil Chrome "${profileSource.name}": ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
