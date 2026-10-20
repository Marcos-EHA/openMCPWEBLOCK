import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tools } from '../../Tool.js'
import { adaptToolsForMCP } from './ToolAdapter.js'

const [grep] = adaptToolsForMCP([{
  name: 'Grep',
  isEnabled: () => true,
  inputJSONSchema: { type: 'object', properties: {} },
}] as unknown as Tools)

let directory: string
let file: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openmcp grep test-'))
  mkdirSync(join(directory, 'nested'))
  file = join(directory, 'nested', 'sample.txt')
  writeFileSync(file, 'alpha\nbeta\n--literal\n', 'utf8')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('MCP Grep regression', () => {
  it('finds text in an explicit file with spaces in its path', async () => {
    expect(await grep!.execute({ pattern: 'alpha', path: file })).toContain(':1:alpha')
  })
  it('searches directories recursively and supports regex alternation', async () => {
    const result = await grep!.execute({ pattern: 'alpha|beta', path: directory })
    expect(result).toContain(':1:alpha')
    expect(result).toContain(':2:beta')
  })
  it('returns no matches only for a successful search without matches', async () => {
    expect(await grep!.execute({ pattern: 'absent', path: file })).toBe('(no matches)')
  })
  it('reports an invalid regex as an error', async () => {
    expect(await grep!.execute({ pattern: '[', path: file })).toStartWith('Error searching:')
  })
  it('reports a missing path as an error', async () => {
    expect(await grep!.execute({ pattern: 'alpha', path: join(directory, 'missing.txt') })).toStartWith('Error searching:')
  })
  it('treats a pattern starting with a dash as data', async () => {
    expect(await grep!.execute({ pattern: '--literal', path: file })).toContain(':3:--literal')
  })
})
