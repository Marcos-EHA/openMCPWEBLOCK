import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  getAntigravityProjectPath,
  isSameLocalProject,
  scanPlatformConversations,
} from './LocalConversationDetector.js'

let temporaryDirectory: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined
let originalAppData: string | undefined
let originalLocalAppData: string | undefined

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  originalHome = undefined
  originalUserProfile = undefined
  originalAppData = undefined
  originalLocalAppData = undefined
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe('Antigravity conversation workspace recognition', () => {
  test('resolves a file URI from conversation summary metadata', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-antigravity-'))
    const workspaceUri = pathToFileURL(temporaryDirectory).href

    expect(getAntigravityProjectPath(JSON.stringify([workspaceUri]))).toBe(temporaryDirectory)
  })

  test('recognizes equivalent local project paths', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-antigravity-'))
    const equivalentPath = process.platform === 'win32'
      ? temporaryDirectory.toUpperCase()
      : join(temporaryDirectory, '.')

    expect(isSameLocalProject(temporaryDirectory, equivalentPath)).toBe(true)
  })

  test('does not treat malformed or non-file workspace URIs as local paths', () => {
    expect(getAntigravityProjectPath('not-json')).toBeUndefined()
    expect(getAntigravityProjectPath(JSON.stringify(['vscode-remote://host/workspace']))).toBeUndefined()
  })

  test('reads workspace associations from Antigravity SQLite under Bun', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-antigravity-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.HOME = temporaryDirectory
    process.env.USERPROFILE = temporaryDirectory

    const antigravityDirectory = join(temporaryDirectory, '.gemini', 'antigravity')
    mkdirSync(antigravityDirectory, { recursive: true })
    const database = new Database(join(antigravityDirectory, 'conversation_summaries.db'))
    database.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        not_fully_idle INTEGER,
        killed INTEGER
      )
    `)
    const insert = database.prepare(`
      INSERT INTO conversation_summaries
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    try {
      insert.run(
        'conversation-1',
        '',
        '<USER_REQUEST>Workspace preview title</USER_REQUEST><ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>',
        5,
        '2026-10-17 21:03:14.8620907+00:00',
        JSON.stringify([pathToFileURL(temporaryDirectory).href]),
        1,
        0,
      )
    } finally {
      insert.finalize()
    }
    database.close()

    const result = await scanPlatformConversations('antigravity', temporaryDirectory)

    expect(result.error).toBeUndefined()
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0]).toMatchObject({
      id: 'conversation-1',
      title: 'Workspace preview title',
      projectPath: temporaryDirectory,
      isCurrentProject: true,
      isActive: true,
      modelStatus: 'unverified',
    })
  })

  describe('Claude Desktop conversation recognition', () => {
    test('does not misreport local-agent-mode metadata folders as chats', async () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-claude-desktop-'))
      originalLocalAppData = process.env.LOCALAPPDATA
      originalAppData = process.env.APPDATA
      process.env.LOCALAPPDATA = temporaryDirectory
      process.env.APPDATA = join(temporaryDirectory, 'Roaming')

      const sessionDirectory = join(
        temporaryDirectory,
        'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude',
        'local-agent-mode-sessions', 'workspace-id', 'session-id',
      )
      mkdirSync(sessionDirectory, { recursive: true })
      writeFileSync(join(sessionDirectory, 'scheduled-tasks.json'), '{}')

      const result = await scanPlatformConversations('claude-desktop', temporaryDirectory)

      expect(result.conversations).toHaveLength(0)
      expect(result.error).toContain('metadata folders are not reported as conversations')
    })

    test('recognizes only a nested session with a readable skill transcript', async () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-claude-desktop-'))
      originalLocalAppData = process.env.LOCALAPPDATA
      originalAppData = process.env.APPDATA
      process.env.LOCALAPPDATA = temporaryDirectory
      process.env.APPDATA = join(temporaryDirectory, 'Roaming')
      const currentProject = join(temporaryDirectory, 'project')
      const sessionsDirectory = join(
        temporaryDirectory,
        'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude',
        'local-agent-mode-sessions', 'workspace-id', 'session-id',
      )
      mkdirSync(currentProject, { recursive: true })
      mkdirSync(sessionsDirectory, { recursive: true })
      writeFileSync(join(sessionsDirectory, 'scheduled-tasks.json'), '{}')
      writeFileSync(join(sessionsDirectory, 'skill_log.jsonl'), JSON.stringify({
        cwd: currentProject,
        prompt: 'Continue the current project implementation',
      }) + '\n')

      const result = await scanPlatformConversations('claude-desktop', currentProject)

      expect(result.error).toBeUndefined()
      expect(result.conversations).toHaveLength(1)
      expect(result.conversations[0]).toMatchObject({
        platformId: 'claude-desktop',
        title: 'Continue the current project implementation',
        projectPath: currentProject,
        isCurrentProject: true,
      })
    })
  })

  describe('VS Code chat history recognition', () => {
    function writeChatIndex(databasePath: string, entries: Record<string, unknown>): void {
      mkdirSync(join(databasePath, '..'), { recursive: true })
      const database = new Database(databasePath)
      database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
      const insert = database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      try {
        insert.run('chat.ChatSessionStore.index', JSON.stringify({ version: 1, entries }))
      } finally {
        insert.finalize()
        database.close()
      }
    }

    test('reads actual non-empty ChatSessionStore entries and attaches workspace paths', async () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-vscode-chat-'))
      originalAppData = process.env.APPDATA
      process.env.APPDATA = temporaryDirectory
      const userDirectory = join(temporaryDirectory, 'Code', 'User')
      const workspaceDirectory = join(userDirectory, 'workspaceStorage', 'project-storage')
      const currentProject = join(temporaryDirectory, 'project')
      mkdirSync(currentProject, { recursive: true })
      mkdirSync(workspaceDirectory, { recursive: true })
      writeFileSync(join(workspaceDirectory, 'workspace.json'), JSON.stringify({
        folder: pathToFileURL(currentProject).href,
      }))
      const recent = Date.now() - 1000
      writeChatIndex(join(userDirectory, 'globalStorage', 'state.vscdb'), {
        'shared-session': {
          sessionId: 'shared-session',
          title: 'Global title',
          lastMessageDate: recent,
          isEmpty: false,
        },
        'other-session': {
          sessionId: 'other-session',
          title: 'Other workspace chat',
          lastMessageDate: recent - 1000,
          isEmpty: false,
        },
        'empty-session': {
          sessionId: 'empty-session',
          title: 'Untitled',
          lastMessageDate: 0,
          isEmpty: true,
        },
      })
      writeChatIndex(join(workspaceDirectory, 'state.vscdb'), {
        'shared-session': {
          sessionId: 'shared-session',
          title: 'Workspace title',
          lastMessageDate: recent + 1000,
          isEmpty: false,
        },
        'workspace-session': {
          sessionId: 'workspace-session',
          title: 'Project chat',
          lastMessageDate: recent,
          isEmpty: false,
        },
      })

      const result = await scanPlatformConversations('vscode', currentProject, 10)

      expect(result.error).toBeUndefined()
      expect(result.conversations).toHaveLength(3)
      expect(result.conversations[0]).toMatchObject({
        id: 'shared-session',
        title: 'Workspace title',
        projectPath: currentProject,
        isCurrentProject: true,
        lastActiveAt: recent + 1000,
      })
      expect(result.conversations.find(item => item.id === 'workspace-session')).toMatchObject({
        projectPath: currentProject,
        isCurrentProject: true,
      })
      expect(result.conversations.find(item => item.id === 'other-session')).toMatchObject({
        projectPath: undefined,
        isCurrentProject: undefined,
      })
      expect(result.conversations.some(item => item.id === 'empty-session')).toBe(false)
    })
  })

  describe('Claude Code transcript recognition', () => {
    test('uses transcript cwd and first user message instead of Base64-decoding the project key', async () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmcp-claude-code-'))
      originalHome = process.env.HOME
      originalUserProfile = process.env.USERPROFILE
      process.env.HOME = temporaryDirectory
      process.env.USERPROFILE = temporaryDirectory
      const currentProject = join(temporaryDirectory, 'openMCPWEBLOCK')
      const projectKey = process.platform === 'win32'
        ? currentProject.replace(/:/g, '-').replace(/[\\/]/g, '-')
        : currentProject.replace(/\//g, '-')
      const projectDirectory = join(temporaryDirectory, '.claude', 'projects', projectKey)
      mkdirSync(currentProject, { recursive: true })
      mkdirSync(projectDirectory, { recursive: true })
      const sessionId = 'session-123'
      writeFileSync(join(projectDirectory, `${sessionId}.jsonl`), [
        JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-17T20:00:00.000Z' }),
        JSON.stringify({
          type: 'user',
          cwd: currentProject,
          timestamp: '2026-10-17T20:01:00.000Z',
          message: { role: 'user', content: 'Investigate local chat recognition' },
        }),
      ].join('\n') + '\n')

      const result = await scanPlatformConversations('claude-code', currentProject)

      expect(result.error).toBeUndefined()
      expect(result.conversations).toHaveLength(1)
      expect(result.conversations[0]).toMatchObject({
        id: `${projectKey}/${sessionId}.jsonl`,
        title: 'Investigate local chat recognition',
        projectPath: currentProject,
        isCurrentProject: true,
        createdAt: new Date('2026-10-17T20:00:00.000Z').getTime(),
      })
    })
  })
})
