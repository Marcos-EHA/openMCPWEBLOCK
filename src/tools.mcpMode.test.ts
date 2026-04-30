import { describe, expect, test } from 'bun:test'
import {
  filterMcpToolsForMode,
  getMcpModeComposition,
  isServerMatch,
} from './tools.js'

function tool(serverName: string, name = `${serverName}__tool`) {
  return {
    name,
    mcpInfo: {
      serverName,
      toolName: name,
    },
  } as any
}

describe('MCP mode composition', () => {
  test('matches server aliases with hyphen/underscore differences', () => {
    expect(isServerMatch('claude_mem', 'claude-mem')).toBe(true)
    expect(isServerMatch('chrome-devtools-mcp', 'chrome-devtools')).toBe(true)
    expect(isServerMatch('superassistant-proxy', 'superassistant-proxy')).toBe(
      true,
    )
  })

  test('api mode keeps only claude-mem MCP tools', () => {
    const tools = [
      tool('claude-mem'),
      tool('superassistant-proxy'),
      tool('chrome-devtools'),
    ]
    const filtered = filterMcpToolsForMode(tools, 'api')
    expect(filtered.map(t => t.mcpInfo!.serverName)).toEqual(['claude-mem'])
  })

  test('web mode keeps superassistant/chrome-devtools/claude-mem tools', () => {
    const tools = [
      tool('claude-mem'),
      tool('superassistant-proxy'),
      tool('chrome-devtools'),
      tool('filesystem'),
    ]
    const filtered = filterMcpToolsForMode(tools, 'web')
    expect(filtered.map(t => t.mcpInfo!.serverName).sort()).toEqual(
      ['claude-mem', 'chrome-devtools', 'superassistant-proxy'].sort(),
    )
  })

  test('auto mode keeps all MCP tools', () => {
    const tools = [
      tool('claude-mem'),
      tool('superassistant-proxy'),
      tool('chrome-devtools'),
      tool('filesystem'),
    ]
    const filtered = filterMcpToolsForMode(tools, 'auto')
    expect(filtered).toHaveLength(4)
  })

  test('composition reports missing expected servers for web mode', () => {
    const composition = getMcpModeComposition('web', ['superassistant-proxy'])
    expect(composition.expectedServers).toEqual([
      'superassistant-proxy',
      'chrome-devtools',
      'claude-mem',
    ])
    expect(composition.missingServers).toEqual(['chrome-devtools', 'claude-mem'])
  })
})
