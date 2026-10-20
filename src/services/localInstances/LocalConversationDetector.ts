// LocalConversationDetector -- Discovers conversations in local AI instances.
//
// Each platform stores conversations differently:
// - Antigravity: ~/.gemini/antigravity/brain/{uuid}/ with transcript.jsonl
// - Claude Desktop: AppData/Packages/Claude_{id}/LocalCache/Roaming/Claude/local-agent-mode-sessions/{uuid}/
// - VS Code: Recent workspaces from AppData/Roaming/Code/
// - Claude Code: CLI sessions (via `claude conversations list` if available)
//
// This module discovers local IDs and workspace metadata; short title excerpts may
// be read from local transcripts when Antigravity has not saved a title.

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

export interface LocalConversation {
  /** Unique conversation identifier (UUID or similar) */
  id: string
  /** Platform this conversation belongs to */
  platformId: string
  /** Human-readable title or first message excerpt */
  title: string
  /** When this conversation was last active */
  lastActiveAt: number
  /** When this conversation was created */
  createdAt?: number
  /** Associated project/workspace path if known */
  projectPath?: string
  /** Number of messages/steps if easily available */
  messageCount?: number
  /** Whether this conversation appears to be for the current project */
  isCurrentProject?: boolean
  /** Antigravity reports the conversation as currently processing */
  isActive?: boolean
  /** Antigravity exposes the active model after the conversation is loaded in the app. */
  model?: string
  /** Whether model metadata is available for this conversation without loading it. */
  modelStatus?: 'unverified' | 'verified'
}

export interface ConversationScanResult {
  platformId: string
  platformName: string
  conversations: LocalConversation[]
  error?: string
  scannedAt: number
}

/**
 * Scan all known platforms for conversations.
 * @param currentProjectPath - Path to the current project (for relevance matching)
 * @param limit - Max conversations per platform (default 20)
 */
export async function scanAllConversations(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult[]> {
  const results: ConversationScanResult[] = []

  results.push(await scanAntigravityConversations(currentProjectPath, limit))
  results.push(await scanClaudeDesktopSessions(currentProjectPath, limit))
  results.push(await scanVSCodeWorkspaces(currentProjectPath, limit))
  results.push(await scanClaudeCodeSessions(currentProjectPath, limit))

  return results
}

/**
 * Scan conversations for a specific platform.
 */
export async function scanPlatformConversations(
  platformId: string,
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  switch (platformId) {
    case 'antigravity': return scanAntigravityConversations(currentProjectPath, limit)
    case 'claude-desktop': return scanClaudeDesktopSessions(currentProjectPath, limit)
    case 'vscode': return scanVSCodeWorkspaces(currentProjectPath, limit)
    case 'claude-code': return scanClaudeCodeSessions(currentProjectPath, limit)
    default:
      return {
        platformId,
        platformName: platformId,
        conversations: [],
        error: `Platform "${platformId}" not supported for conversation scanning.`,
        scannedAt: Date.now(),
      }
  }
}

// ════════════════════════════════════════════════════════════════
// Antigravity -- ~/.gemini/antigravity/brain/{uuid}/
// ════════════════════════════════════════════════════════════════

interface AntigravitySummaryRow {
  conversation_id: string
  title: string
  preview: string
  step_count: number
  last_modified_time: string | number
  workspace_uris: string
  not_fully_idle: number | boolean
  killed: number | boolean
}

interface AntigravitySummaries {
  rows: AntigravitySummaryRow[]
  indexedTitles: Map<string, string>
}

interface ReadOnlySqliteDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(): unknown[]
    finalize?(): void
  }
  close(): void
}

async function openReadOnlySqlite(databasePath: string): Promise<ReadOnlySqliteDatabase | null> {
  if (process.versions.bun) {
    const { Database } = await import('bun:sqlite')
    return new Database(databasePath, { readonly: true, create: false })
  }
  if (hasNativeSqliteSupport()) {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(databasePath, { readOnly: true })
  }
  return null
}

function getSqliteRow(database: ReadOnlySqliteDatabase, sql: string, params: unknown[] = []): unknown {
  const statement = database.prepare(sql)
  try {
    return statement.get(...params)
  } finally {
    statement.finalize?.()
  }
}

function getSqliteRows(database: ReadOnlySqliteDatabase, sql: string): unknown[] {
  const statement = database.prepare(sql)
  try {
    return statement.all()
  } finally {
    statement.finalize?.()
  }
}

export function getAntigravityProjectPath(workspaceUris: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(workspaceUris)
  } catch {
    return undefined
  }

  const uris = Array.isArray(parsed) ? parsed : [parsed]
  for (const value of uris) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      if (/^file:/i.test(value)) return fileURLToPath(new URL(value))
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue
      return resolve(value)
    } catch {
      continue
    }
  }
  return undefined
}

export function isSameLocalProject(left: string, right: string): boolean {
  const normalize = (value: string) => resolve(value).replace(/[\\/]+$/, '')
  const leftPath = normalize(left)
  const rightPath = normalize(right)
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath
}

export async function hasAntigravityConversation(conversationId: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) return false
  const databasePath = join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.gemini', 'antigravity', 'conversation_summaries.db',
  )
  if (!existsSync(databasePath)) return false
  const database = await openReadOnlySqlite(databasePath)
  if (!database) {
    throw new Error('Read-only SQLite access is unavailable for Antigravity conversation history.')
  }
  try {
    return Boolean(getSqliteRow(
      database,
      'SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
      [conversationId],
    ))
  } finally {
    database.close()
  }
}

function resolveVSCodeWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return fileURLToPath(url)
    return undefined
  } catch {
    if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return resolve(value)
    return undefined
  }
}

function readFirstFileLine(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(16 * 1024)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    const content = buffer.toString('utf8', 0, bytesRead)
    return content.split(/\r?\n/, 1)[0]?.trim() || undefined
  } finally {
    closeSync(fd)
  }
}

function hasNativeSqliteSupport(): boolean {
  if (process.versions.bun) return false
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 5)
}

async function readAntigravitySummaries(databasePath: string): Promise<AntigravitySummaries | null> {
  const database = await openReadOnlySqlite(databasePath)
  if (!database) return null

  try {
    const table = getSqliteRow(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'",
    )
    if (!table) return null
    const rawRows = getSqliteRows(database, `
      SELECT conversation_id, title, preview, step_count, last_modified_time,
             workspace_uris, not_fully_idle, killed
      FROM conversation_summaries
      ORDER BY last_modified_time DESC
    `)
    const rows: AntigravitySummaryRow[] = rawRows.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Antigravity conversation summary contained an unexpected SQLite row.')
      }
      const row = value as Record<string, unknown>
      const conversationId = row.conversation_id
      const title = row.title
      const preview = row.preview
      const stepCount = row.step_count
      const lastModifiedTime = row.last_modified_time
      const workspaceUris = row.workspace_uris
      const notFullyIdle = row.not_fully_idle
      const killed = row.killed
      const numericStepCount = typeof stepCount === 'bigint' ? Number(stepCount) : stepCount
      if (
        typeof conversationId !== 'string' ||
        typeof title !== 'string' ||
        (typeof preview !== 'string' && preview !== null) ||
        typeof numericStepCount !== 'number' ||
        !Number.isSafeInteger(numericStepCount) ||
        (typeof lastModifiedTime !== 'string' && typeof lastModifiedTime !== 'number') ||
        typeof workspaceUris !== 'string' ||
        (typeof notFullyIdle !== 'number' && typeof notFullyIdle !== 'bigint') ||
        (typeof killed !== 'number' && typeof killed !== 'bigint')
      ) {
        throw new Error('Antigravity conversation summary contained an unexpected SQLite value.')
      }
      return {
        conversation_id: conversationId,
        title,
        preview: typeof preview === 'string' ? preview : '',
        step_count: numericStepCount,
        last_modified_time: lastModifiedTime,
        workspace_uris: workspaceUris,
        not_fully_idle: notFullyIdle === 1 || notFullyIdle === 1n,
        killed: killed === 1 || killed === 1n,
      }
    })
    const ftsTable = getSqliteRow(database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations_fts'",
    )
    const indexedTitles = new Map<string, string>()
    if (ftsTable) {
      const indexedRows = getSqliteRows(database, `
        SELECT conversation_id, title
        FROM conversations_fts
        WHERE title != ''
        ORDER BY rowid DESC
      `)
      for (const value of indexedRows) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Antigravity conversation title index contained an unexpected SQLite row.')
        }
        const row = value as Record<string, unknown>
        if (typeof row.conversation_id !== 'string' || typeof row.title !== 'string') {
          throw new Error('Antigravity conversation title index contained an unexpected SQLite value.')
        }
        if (!indexedTitles.has(row.conversation_id)) indexedTitles.set(row.conversation_id, row.title)
      }
    }
    return { rows, indexedTitles }
  } finally {
    database.close()
  }
}

async function readAntigravityTranscriptMetadata(conversationId: string): Promise<{
  title: string
  createdAt?: number
  projectPath?: string
}> {
  const result: { title: string; createdAt?: number; projectPath?: string } = {
    title: `Chat ${conversationId.slice(0, 8)}`,
  }
  const transcriptPath = join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.gemini', 'antigravity', 'brain', conversationId,
    '.system_generated', 'logs', 'transcript.jsonl',
  )
  if (!existsSync(transcriptPath)) return result

  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n').slice(0, 30)
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (!result.createdAt && parsed.created_at) {
          const createdAt = new Date(parsed.created_at).getTime()
          if (Number.isFinite(createdAt)) result.createdAt = createdAt
        }
        if (parsed.type === 'USER_INPUT' && typeof parsed.content === 'string' &&
            result.title === `Chat ${conversationId.slice(0, 8)}`) {
          const message = parsed.content
            .replace(/<USER_REQUEST>/g, '')
            .replace(/<\/USER_REQUEST>/g, '')
            .replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, '')
            .trim()
          if (message) result.title = message.length > 80 ? `${message.slice(0, 80)}...` : message
        }
        if (Array.isArray(parsed.tool_calls)) {
          for (const call of parsed.tool_calls) {
            const args = call?.arguments
            if (!result.projectPath && args && typeof args === 'object') {
              const candidate = args.Cwd ?? args.cwd ?? args.workingDirectory
              if (typeof candidate === 'string' && candidate.trim()) result.projectPath = candidate
            }
          }
        }
      } catch {
        continue
      }
    }
  } catch {
    return result
  }
  return result
}

function getAntigravityPreviewTitle(preview: string): string | undefined {
  const message = preview
    .replace(/<USER_REQUEST>/g, '')
    .replace(/<\/USER_REQUEST>/g, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!message) return undefined
  return message.length > 80 ? `${message.slice(0, 80)}...` : message
}

async function scanAntigravityConversations(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  const databasePath = join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.gemini', 'antigravity', 'conversation_summaries.db',
  )
  if (existsSync(databasePath)) {
    const summaries = await readAntigravitySummaries(databasePath)
    if (summaries) {
      const selectedRows = summaries.rows.slice(0, Math.max(0, limit))
      const conversations = await Promise.all(selectedRows.map(async row => {
        const workspacePath = getAntigravityProjectPath(row.workspace_uris)
        const summaryTitle = row.title.trim() || summaries.indexedTitles.get(row.conversation_id)
        const previewTitle = getAntigravityPreviewTitle(row.preview)
        const transcript = (summaryTitle || previewTitle) && workspacePath
          ? undefined
          : await readAntigravityTranscriptMetadata(row.conversation_id)
        const projectPath = workspacePath ?? transcript?.projectPath
        const modifiedAt = typeof row.last_modified_time === 'number'
          ? row.last_modified_time
          : new Date(row.last_modified_time).getTime()
        return {
          id: row.conversation_id,
          platformId: 'antigravity',
          title: summaryTitle || previewTitle || transcript?.title || `Chat ${row.conversation_id.slice(0, 8)}`,
          lastActiveAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
          createdAt: transcript?.createdAt,
          projectPath,
          messageCount: Number.isFinite(row.step_count) ? row.step_count : undefined,
          isCurrentProject: currentProjectPath && projectPath
            ? isSameLocalProject(projectPath, currentProjectPath)
            : undefined,
          isActive: Boolean(row.not_fully_idle) && !Boolean(row.killed),
          modelStatus: 'unverified',
        } satisfies LocalConversation
      }))
      return {
        platformId: 'antigravity',
        platformName: 'Antigravity',
        conversations,
        scannedAt: Date.now(),
      }
    }
  }

  return scanAntigravityTranscriptConversations(currentProjectPath, limit)
}

async function scanAntigravityTranscriptConversations(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  const result: ConversationScanResult = {
    platformId: 'antigravity',
    platformName: 'Antigravity',
    conversations: [],
    scannedAt: Date.now(),
  }

  try {
    const brainDir = join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.gemini', 'antigravity', 'brain',
    )
    if (!existsSync(brainDir)) {
      result.error = 'Antigravity brain directory not found'
      return result
    }

    const dirs = readdirSync(brainDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))

    const conversations: LocalConversation[] = []

    for (const dir of dirs) {
      const convPath = join(brainDir, dir.name)
      const transcriptPath = join(convPath, '.system_generated', 'logs', 'transcript.jsonl')

      if (!existsSync(transcriptPath)) continue

      try {
        const stat = statSync(transcriptPath)
        const content = readFileSync(transcriptPath, 'utf-8')
        const lines = content.split('\n').filter(l => l.trim())

        // Extract first user message as title (without reading full content)
        let title = 'Conversación sin título'
        let createdAt: number | undefined
        let projectPath: string | undefined

        for (const line of lines.slice(0, 30)) {
          try {
            const parsed = JSON.parse(line)
            if (!createdAt && parsed.created_at) {
              createdAt = new Date(parsed.created_at).getTime()
            }
            if (parsed.type === 'USER_INPUT' && parsed.content && !title.startsWith('[')) {
              // Extract first 80 chars of first user message as title
              const msg = parsed.content
                .replace(/<USER_REQUEST>/g, '')
                .replace(/<\/USER_REQUEST>/g, '')
                .replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, '')
                .trim()
              if (msg.length > 0) {
                title = msg.length > 80 ? msg.slice(0, 80) + '...' : msg
              }
            }
            // Check tool calls for workspace paths
            if (parsed.tool_calls) {
              for (const call of parsed.tool_calls) {
                if (call.arguments?.Cwd && !projectPath) {
                  projectPath = call.arguments.Cwd
                }
              }
            }
          } catch { /* skip unparseable lines */ }
        }

        conversations.push({
          id: dir.name,
          platformId: 'antigravity',
          title,
          lastActiveAt: stat.mtimeMs,
          createdAt,
          projectPath,
          messageCount: lines.length,
          isCurrentProject: currentProjectPath && projectPath
            ? isSameLocalProject(projectPath, currentProjectPath)
            : undefined,
        })
      } catch { /* skip unreadable conversations */ }
    }

    // Sort by last active, most recent first, and limit
    conversations.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    result.conversations = conversations.slice(0, limit)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  return result
}

// ════════════════════════════════════════════════════════════════
// Claude Desktop — MSIX local-agent-mode-sessions
// ════════════════════════════════════════════════════════════════

async function scanClaudeDesktopSessions(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  const result: ConversationScanResult = {
    platformId: 'claude-desktop',
    platformName: 'Claude Desktop',
    conversations: [],
    scannedAt: Date.now(),
  }

  try {
    // MSIX path (Windows Store app)
    const msixBase = join(
      process.env.LOCALAPPDATA || '',
      'Packages',
    )
    if (!existsSync(msixBase)) {
      result.error = 'LOCALAPPDATA/Packages not found'
      return result
    }

    const packageDirs = readdirSync(msixBase)
      .filter(name => name.startsWith('Claude_'))
      .map(name => join(msixBase, name, 'LocalCache', 'Roaming', 'Claude'))
    const sessionDirectories = [
      ...packageDirs.map(directory => join(directory, 'local-agent-mode-sessions')),
      join(process.env.APPDATA || '', 'Claude', 'local-agent-mode-sessions'),
    ].filter((directory, index, all) => existsSync(directory) && all.indexOf(directory) === index)

    if (sessionDirectories.length === 0) {
      result.error = 'Claude Desktop local conversation transcripts were not found.'
      return result
    }

    const conversations: LocalConversation[] = []
    let inspectedDirectories = 0
    const maxDirectories = 5000

    const inspectDirectory = (root: string, directory: string, depth: number): void => {
      if (depth > 4 || inspectedDirectories >= maxDirectories) return
      inspectedDirectories++
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = join(directory, entry.name)
        if (entry.isDirectory()) {
          inspectDirectory(root, entryPath, depth + 1)
          continue
        }
        if (!entry.isFile() || entry.name !== 'skill_log.jsonl') continue

        try {
          const stat = statSync(entryPath)
          const firstLine = readFirstFileLine(entryPath)
          if (!firstLine) continue
          const parsed = JSON.parse(firstLine) as { cwd?: unknown; prompt?: unknown }
          const projectPath = typeof parsed.cwd === 'string' && parsed.cwd.trim()
            ? parsed.cwd
            : undefined
          const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
          const sessionId = entryPath.slice(root.length + 1).replace(/[\\/]/g, '/')
          conversations.push({
            id: sessionId,
            platformId: 'claude-desktop',
            title: prompt
              ? prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt
              : `Sesión ${basename(dirname(entryPath)).slice(0, 8)}`,
            lastActiveAt: stat.mtimeMs,
            projectPath,
            isCurrentProject: currentProjectPath && projectPath
              ? isSameLocalProject(projectPath, currentProjectPath)
              : undefined,
          })
        } catch {
          continue
        }
      }
    }

    for (const sessionsDir of sessionDirectories) {
      for (const dir of readdirSync(sessionsDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
        inspectDirectory(sessionsDir, join(sessionsDir, dir.name), 0)
      }
    }

    if (conversations.length === 0) {
      result.error =
        'Claude Desktop local-agent-mode-sessions contains no readable skill_log.jsonl transcripts; ' +
        'metadata folders are not reported as conversations.'
      return result
    }
    conversations.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    result.conversations = conversations.slice(0, limit)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  return result
}

// ════════════════════════════════════════════════════════════════
// VS Code — ChatSessionStore index in state.vscdb
// ════════════════════════════════════════════════════════════════

async function scanVSCodeWorkspaces(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  const result: ConversationScanResult = {
    platformId: 'vscode',
    platformName: 'VS Code',
    conversations: [],
    scannedAt: Date.now(),
  }

  try {
    const userDirectory = join(process.env.APPDATA || '', 'Code', 'User')
    const globalDatabasePath = join(userDirectory, 'globalStorage', 'state.vscdb')
    const workspaceStorageDirectory = join(userDirectory, 'workspaceStorage')
    if (!existsSync(globalDatabasePath) && !existsSync(workspaceStorageDirectory)) {
      result.error = 'VS Code conversation storage was not found.'
      return result
    }

    const workspaceEntries: Array<{ databasePath: string; projectPath?: string }> = []
    if (existsSync(workspaceStorageDirectory)) {
      for (const entry of readdirSync(workspaceStorageDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const workspacePath = join(workspaceStorageDirectory, entry.name)
        const databasePath = join(workspacePath, 'state.vscdb')
        if (!existsSync(databasePath)) continue
        const metadataPath = join(workspacePath, 'workspace.json')
        let projectPath: string | undefined
        if (existsSync(metadataPath)) {
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { folder?: unknown; workspace?: unknown }
          projectPath = resolveVSCodeWorkspacePath(metadata.folder ?? metadata.workspace)
        }
        workspaceEntries.push({ databasePath, projectPath })
      }
    }

    const databaseEntries = [
      ...(existsSync(globalDatabasePath) ? [{ databasePath: globalDatabasePath }] : []),
      ...workspaceEntries,
    ]
    const conversationsById = new Map<string, LocalConversation>()
    for (const { databasePath, projectPath } of databaseEntries) {
      const database = await openReadOnlySqlite(databasePath)
      if (!database) {
        result.error = 'Read-only SQLite access is unavailable for the VS Code conversation index.'
        return result
      }
      try {
        const rawIndex = getSqliteRow(database,
          "SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'",
        )
        if (!rawIndex || typeof rawIndex !== 'object' || !('value' in rawIndex) ||
          typeof rawIndex.value !== 'string') continue

        const index = JSON.parse(rawIndex.value) as {
          entries?: Record<string, {
            sessionId?: unknown
            title?: unknown
            lastMessageDate?: unknown
            isEmpty?: unknown
          }>
        }
        if (!index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) continue

        for (const entry of Object.values(index.entries)) {
          if (
            typeof entry.sessionId !== 'string' ||
            !entry.sessionId.trim() ||
            entry.isEmpty === true
          ) continue
          const title = typeof entry.title === 'string' ? entry.title.trim() : ''
          const lastActiveAt = typeof entry.lastMessageDate === 'number' &&
            Number.isFinite(entry.lastMessageDate) ? entry.lastMessageDate : 0
          const prior = conversationsById.get(entry.sessionId)
          const resolvedProjectPath = projectPath ?? prior?.projectPath
          conversationsById.set(entry.sessionId, {
            id: entry.sessionId,
            platformId: 'vscode',
            title: title || prior?.title || `Chat ${entry.sessionId.slice(0, 8)}`,
            lastActiveAt: Math.max(lastActiveAt, prior?.lastActiveAt ?? 0),
            projectPath: resolvedProjectPath,
            isCurrentProject: currentProjectPath && resolvedProjectPath
              ? isSameLocalProject(resolvedProjectPath, currentProjectPath)
              : undefined,
          })
        }
      } finally {
        database.close()
      }
    }

    result.conversations = [...conversationsById.values()]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .slice(0, Math.max(0, limit))
    if (result.conversations.length === 0) {
      result.error = 'VS Code has no non-empty chat sessions in its ChatSessionStore index.'
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  return result
}

// ════════════════════════════════════════════════════════════════
// Claude Code — CLI sessions
// ════════════════════════════════════════════════════════════════

async function scanClaudeCodeSessions(
  currentProjectPath?: string,
  limit = 20,
): Promise<ConversationScanResult> {
  const result: ConversationScanResult = {
    platformId: 'claude-code',
    platformName: 'Claude Code',
    conversations: [],
    scannedAt: Date.now(),
  }

  try {
    // Claude Code stores sessions in ~/.claude/projects/{hash}/
    const claudeDir = join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.claude',
    )

    if (!existsSync(claudeDir)) {
      result.error = 'Claude Code config directory not found (~/.claude)'
      return result
    }

    const projectsDir = join(claudeDir, 'projects')
    if (!existsSync(projectsDir)) {
      result.error = 'No Claude Code projects found (~/.claude/projects)'
      return result
    }

    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())

    const conversations: LocalConversation[] = []

    for (const projDir of projectDirs) {
      const projPath = join(projectsDir, projDir.name)
      try {
        // Each project dir may contain session JSONL files
        const files = readdirSync(projPath)
          .filter(f => f.endsWith('.jsonl'))

        for (const file of files) {
          const filePath = join(projPath, file)
          const stat = statSync(filePath)

          const projectPath = resolveClaudeCodeProjectPath(projDir.name, currentProjectPath)
          const transcript = readClaudeCodeTranscriptMetadata(filePath)
          const sessionLabel = file.replace(/\.jsonl$/, '').slice(0, 8)
          const title = transcript.prompt
            ? transcript.prompt.length > 80 ? `${transcript.prompt.slice(0, 80)}...` : transcript.prompt
            : `${projectPath ? basename(projectPath) : 'Claude Code'} — ${sessionLabel}`

          conversations.push({
            id: `${projDir.name}/${file}`,
            platformId: 'claude-code',
            title,
            lastActiveAt: stat.mtimeMs,
            createdAt: transcript.createdAt,
            projectPath,
            isCurrentProject: currentProjectPath && projectPath
              ? isSameLocalProject(projectPath, currentProjectPath)
              : undefined,
          })
        }

        function resolveClaudeCodeProjectPath(projectKey: string, currentProjectPath?: string): string | undefined {
          if (currentProjectPath) {
            const normalizedCurrent = resolve(currentProjectPath).replace(/[\\/]+$/, '')
            const encodedCurrent = process.platform === 'win32'
              ? normalizedCurrent.replace(/:/g, '-').replace(/[\\/]/g, '-')
              : normalizedCurrent.replace(/\//g, '-')
            if (encodedCurrent.toLowerCase() === projectKey.toLowerCase()) return normalizedCurrent
          }

          let decoded: string
          if (process.platform === 'win32' && /^[a-z]--/i.test(projectKey)) {
            decoded = `${projectKey[0]}:\\${projectKey.slice(3).replace(/-/g, '\\')}`
          } else if (process.platform !== 'win32' && projectKey.startsWith('-')) {
            decoded = `/${projectKey.slice(1).replace(/-/g, '/')}`
          } else {
            return undefined
          }
          return existsSync(decoded) ? decoded : undefined
        }

        function readClaudeCodeTranscriptMetadata(filePath: string): {
          prompt?: string
          createdAt?: number
        } {
          const result: { prompt?: string; createdAt?: number } = {}
          const fd = openSync(filePath, 'r')
          try {
            const buffer = Buffer.alloc(128 * 1024)
            const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
            const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)
            for (const line of lines.slice(0, 100)) {
              if (!line.trim()) continue
              let parsed: Record<string, unknown>
              try {
                parsed = JSON.parse(line) as Record<string, unknown>
              } catch {
                continue
              }
              if (!result.createdAt && typeof parsed.timestamp === 'string') {
                const createdAt = new Date(parsed.timestamp).getTime()
                if (Number.isFinite(createdAt)) result.createdAt = createdAt
              }
              if (!result.prompt && parsed.type === 'user' && parsed.message &&
                typeof parsed.message === 'object' && 'content' in parsed.message) {
                const content = (parsed.message as { content?: unknown }).content
                if (typeof content === 'string') result.prompt = content.trim()
                else if (Array.isArray(content)) {
                  const text = content
                    .filter((part): part is { type?: string; text?: string } =>
                      Boolean(part) && typeof part === 'object')
                    .filter(part => part.type === 'text' && typeof part.text === 'string')
                    .map(part => part.text)
                    .join(' ')
                    .trim()
                  if (text) result.prompt = text
                }
              }
              if (result.prompt && result.createdAt) break
            }
          } finally {
            closeSync(fd)
          }
          return result
        }
      } catch { /* skip */ }
    }

    conversations.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    result.conversations = conversations.slice(0, limit)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  return result
}
