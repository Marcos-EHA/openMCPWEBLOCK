import fs from 'fs'
import os from 'os'
import path from 'path'

export interface MasterSessionSource {
  id: string
  name: string
  profileDir: string
  debugPort: number
  platformId: 'chatgpt' | 'claude' | 'zai' | 'chatx'
}

interface MasterSessionRegistry {
  version: 1
  sources: MasterSessionSource[]
}

const DEFAULT_SOURCE: MasterSessionSource = {
  id: 'loco-verde',
  name: 'Loco Verde',
  profileDir: 'master-session',
  debugPort: 9227,
  platformId: 'chatgpt',
}

function getDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, 'openMCPWEBLOCK')
}

function getRegistryPath(): string {
  return path.join(getDataDir(), 'master-sessions.json')
}

function validateRegistry(value: unknown): MasterSessionRegistry {
  if (!value || typeof value !== 'object') {
    throw new Error('Master Session registry is invalid.')
  }
  const registry = value as Partial<MasterSessionRegistry>
  if (registry.version !== 1 || !Array.isArray(registry.sources)) {
    throw new Error('Master Session registry has an unsupported format.')
  }

  const ids = new Set<string>()
  const ports = new Set<number>()
  for (const source of registry.sources) {
    const platformId = source && typeof source === 'object'
      ? (source as Partial<MasterSessionSource>).platformId ?? 'chatgpt'
      : undefined
    if (
      !source ||
      typeof source !== 'object' ||
      typeof source.id !== 'string' ||
      typeof source.name !== 'string' ||
      typeof source.profileDir !== 'string' ||
      typeof source.debugPort !== 'number' ||
      (platformId !== 'chatgpt' && platformId !== 'claude' && platformId !== 'zai' && platformId !== 'chatx') ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source.id) ||
      !source.name.trim() ||
      path.isAbsolute(source.profileDir) ||
      source.profileDir.split(/[\\/]/).includes('..') ||
      !Number.isInteger(source.debugPort) ||
      source.debugPort < 1 ||
      source.debugPort > 65535 ||
      ids.has(source.id) ||
      ports.has(source.debugPort)
    ) {
      throw new Error('Master Session registry contains an invalid or duplicate source.')
    }
    source.platformId = platformId
    ids.add(source.id)
    ports.add(source.debugPort)
  }
  return registry as MasterSessionRegistry
}

function saveRegistry(registry: MasterSessionRegistry): void {
  fs.mkdirSync(getDataDir(), { recursive: true })
  const tempPath = `${getRegistryPath()}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tempPath, getRegistryPath())
}

export function listMasterSessionSources(): MasterSessionSource[] {
  const registryPath = getRegistryPath()
  if (!fs.existsSync(registryPath)) {
    const initial: MasterSessionRegistry = { version: 1, sources: [{ ...DEFAULT_SOURCE }] }
    saveRegistry(initial)
    return initial.sources
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Could not read Master Session registry: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return validateRegistry(parsed).sources
}

export function getMasterSessionSource(sourceId: string): MasterSessionSource {
  const source = listMasterSessionSources().find(candidate => candidate.id === sourceId)
  if (!source) {
    throw new Error(`Unknown Master Session source "${sourceId}". Choose a registered account source.`)
  }
  return source
}

export function createMasterSessionSource(
  name: string,
  platformId: MasterSessionSource['platformId'] = 'chatgpt',
): MasterSessionSource {
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  if (!normalizedName) throw new Error('Enter a name for the Master Session source.')

  const sources = listMasterSessionSources()
  if (sources.some(source => source.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    throw new Error(`A Master Session source named "${normalizedName}" already exists.`)
  }

  const baseId = normalizedName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (!baseId) throw new Error('The Master Session name must contain at least one letter or number.')
  let id = baseId
  let suffix = 2
  while (sources.some(source => source.id === id)) {
    id = `${baseId}-${suffix++}`
  }

  const profileDir = path.join('master-sessions', id)
  const debugPort = Math.max(9399, ...sources.map(source => source.debugPort)) + 1
  if (debugPort > 9499) throw new Error('The Master Session debug-port range is full.')

  const source: MasterSessionSource = { id, name: normalizedName, profileDir, debugPort, platformId }
  const dataDir = getDataDir()
  fs.mkdirSync(path.join(dataDir, profileDir, 'Default'), { recursive: true })
  saveRegistry({ version: 1, sources: [...sources, source] })
  return source
}

export function getMasterSessionProfilePath(source: MasterSessionSource): string {
  return path.join(getDataDir(), source.profileDir)
}
