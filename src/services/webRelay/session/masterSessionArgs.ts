import type { MasterSessionSource } from './MasterSessionRegistry.js'

export type MasterSessionPlatformId = MasterSessionSource['platformId']

export interface MasterSessionAddArgs {
  platformId: MasterSessionPlatformId
  name: string
}

export function parseMasterSessionAddArgs(
  input: string,
  existingSources: Pick<MasterSessionSource, 'name'>[],
): MasterSessionAddArgs {
  let remaining = input.trim()
  let platformId: MasterSessionPlatformId = 'chatgpt'

  if (remaining.startsWith('--')) {
    const platformOption = remaining.match(/^--platform(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i)
    if (!platformOption) {
      throw new Error('Usage: /mcp master-session add --platform <chatgpt|claude|zai|chatx> [name].')
    }
    const requestedPlatform = platformOption[1]?.toLowerCase()
    if (!requestedPlatform) {
      throw new Error('Usage: /mcp master-session add --platform <chatgpt|claude|zai|chatx> [name].')
    }
    if (requestedPlatform !== 'chatgpt' && requestedPlatform !== 'claude' &&
      requestedPlatform !== 'zai' && requestedPlatform !== 'chatx') {
      throw new Error('Platform must be "chatgpt", "claude", "zai", or "chatx".')
    }
    platformId = requestedPlatform
    remaining = (platformOption[2] ?? '').trim()
  }

  if (
    (remaining.startsWith('"') && !remaining.endsWith('"')) ||
    (remaining.startsWith("'") && !remaining.endsWith("'"))
  ) {
    throw new Error('Close the quote around the Master Session name.')
  }
  if (
    (remaining.startsWith('"') && remaining.endsWith('"')) ||
    (remaining.startsWith("'") && remaining.endsWith("'"))
  ) {
    remaining = remaining.slice(1, -1).trim()
  }

  if (!remaining) {
    const baseName = platformId === 'claude' ? 'Claude'
      : platformId === 'zai' ? 'Z.ai'
        : platformId === 'chatx' ? 'ChatX'
          : 'ChatGPT'
    const existingNames = new Set(existingSources.map(source => source.name.toLocaleLowerCase()))
    let name = baseName
    let suffix = 2
    while (existingNames.has(name.toLocaleLowerCase())) {
      name = `${baseName} ${suffix++}`
    }
    remaining = name
  }

  return { platformId, name: remaining }
}
