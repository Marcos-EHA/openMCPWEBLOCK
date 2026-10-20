import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createMasterSessionSource,
  getMasterSessionSource,
  listMasterSessionSources,
} from './MasterSessionRegistry.js'

const originalLocalAppData = process.env.LOCALAPPDATA
let temporaryDataDir: string

beforeEach(() => {
  temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'master-session-registry-'))
  process.env.LOCALAPPDATA = temporaryDataDir
})

afterEach(() => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  fs.rmSync(temporaryDataDir, { recursive: true, force: true })
})

describe('MasterSessionRegistry', () => {
  test('initializes the legacy Loco Verde source and creates isolated additional sources', () => {
    const initial = listMasterSessionSources()
    expect(initial).toEqual([{
      id: 'loco-verde',
      name: 'Loco Verde',
      profileDir: 'master-session',
      debugPort: 9227,
      platformId: 'chatgpt',
    }])

    const added = createMasterSessionSource('Cuenta Norte')
    expect(added).toEqual({
      id: 'cuenta-norte',
      name: 'Cuenta Norte',
      profileDir: path.join('master-sessions', 'cuenta-norte'),
      debugPort: 9400,
      platformId: 'chatgpt',
    })
    expect(fs.existsSync(path.join(temporaryDataDir, 'openMCPWEBLOCK', added.profileDir, 'Default'))).toBe(true)
    expect(listMasterSessionSources()).toHaveLength(2)
  })

  test('rejects duplicate names and resolves unknown IDs explicitly', () => {
    createMasterSessionSource('Cuenta Norte')
    expect(() => createMasterSessionSource(' cuenta   norte ')).toThrow('already exists')
    expect(() => getMasterSessionSource('missing')).toThrow('Unknown Master Session source')
  })

  test('creates platform-isolated Claude sources and defaults legacy entries to ChatGPT', () => {
    const claude = createMasterSessionSource('Claude Personal', 'claude')
    expect(claude.platformId).toBe('claude')

    const registryPath = path.join(temporaryDataDir, 'openMCPWEBLOCK', 'master-sessions.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    delete registry.sources[0].platformId
    fs.writeFileSync(registryPath, JSON.stringify(registry))
    expect(listMasterSessionSources()[0]?.platformId).toBe('chatgpt')
  })

  test('creates a Z.ai Master Session source without reusing another platform profile', () => {
    const source = createMasterSessionSource('Z.ai GLM 5.3', 'zai')

    expect(source).toEqual({
      id: 'z-ai-glm-5-3',
      name: 'Z.ai GLM 5.3',
      profileDir: path.join('master-sessions', 'z-ai-glm-5-3'),
      debugPort: 9400,
      platformId: 'zai',
    })
    expect(listMasterSessionSources()).toContainEqual(source)
  })

  test('creates an isolated ChatX Master Session source', () => {
    const source = createMasterSessionSource('Astra GPT', 'chatx')

    expect(source).toEqual({
      id: 'astra-gpt',
      name: 'Astra GPT',
      profileDir: path.join('master-sessions', 'astra-gpt'),
      debugPort: 9400,
      platformId: 'chatx',
    })
    expect(fs.existsSync(path.join(temporaryDataDir, 'openMCPWEBLOCK', source.profileDir, 'Default'))).toBe(true)
    expect(listMasterSessionSources()).toContainEqual(source)
  })

  test('rejects unsupported Master Session platforms', () => {
    const registryPath = path.join(temporaryDataDir, 'openMCPWEBLOCK', 'master-sessions.json')
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      sources: [{
        id: 'invalid',
        name: 'Invalid',
        profileDir: 'x',
        debugPort: 9400,
        platformId: 'gemini',
      }],
    }))
    expect(() => listMasterSessionSources()).toThrow('invalid or duplicate source')
  })

  test('rejects malformed registry fields without assuming their runtime types', () => {
    const registryPath = path.join(temporaryDataDir, 'openMCPWEBLOCK', 'master-sessions.json')
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      sources: [{ id: 'invalid', name: 42, profileDir: 'x', debugPort: 9400 }],
    }))
    expect(() => listMasterSessionSources()).toThrow('invalid or duplicate source')
  })
})
