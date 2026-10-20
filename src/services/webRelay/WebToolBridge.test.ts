import { describe, expect, test } from 'bun:test'
import { formatSuperAssistantPrompt } from './WebToolBridge.js'

describe('SuperAssistant Web Relay prompt', () => {
  test('includes the local MCP capability contract and concrete filesystem schemas', () => {
    const prompt = formatSuperAssistantPrompt('Analiza el directorio C:\\work\\app', [
      {
        name: 'ListDir',
        description: 'List local directory contents.',
        inputSchema: {
          properties: { path: { type: 'string', description: 'Directory path.' } },
          required: ['path'],
        },
      },
      {
        name: 'Read',
        description: 'Read local file contents.',
        inputSchema: {
          properties: { file_path: { type: 'string', description: 'File path.' } },
          required: ['file_path'],
        },
      },
    ])

    expect(prompt).toContain('SuperAssistant extension connected to openMCPWEBLOCK')
    expect(prompt).toContain('they operate on the user\'s local machine')
    expect(prompt).toContain('<tool name="ListDir">')
    expect(prompt).toContain('<parameter name="path" type="string" required="true">')
    expect(prompt).toContain('<tool name="Read">')
    expect(prompt).toContain('Emit each event as one standalone JSON object on its own line.')
    expect(prompt).toContain('Never emit protocol labels')
    expect(prompt).not.toContain('TOOL_NAME')
    expect(prompt).not.toContain('UNIQUE_CALL_ID')
    expect(prompt).not.toContain('parameter_name')
    expect(prompt).toContain('Analiza el directorio C:\\work\\app')
  })

  test('does not double-wrap an already operationally-instructed prompt', () => {
    const original = '[SuperAssistant Operational Instructions]\nUser task'
    expect(formatSuperAssistantPrompt(original, [{ name: 'Read' }])).toBe(original)
  })
})
