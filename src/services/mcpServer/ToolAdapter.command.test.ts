import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import type { Tools } from '../../Tool.js'
import { adaptToolsForMCP } from './ToolAdapter.js'

const [commandTool] = adaptToolsForMCP([{
  name: 'Bash',
  isEnabled: () => true,
  inputJSONSchema: { type: 'object', properties: {} },
}] as unknown as Tools)

function command(source: string): string {
  return `"${process.execPath}" -e "${source}"`
}

describe('MCP command execution', () => {
  it('preserves stdout and stderr on success', async () => {
    const result = await commandTool!.execute({ command: command("console.log('stdout-marker'); console.error('stderr-marker')") })
    expect(result).toContain('stdout-marker')
    expect(result).toContain('stderr-marker')
  })
  it('preserves output and exit code on failure', async () => {
    const result = await commandTool!.execute({ command: command("console.log('partial-output'); console.error('failure-detail'); process.exit(7)") })
    expect(result).toContain('Exit code 7')
    expect(result).toContain('partial-output')
    expect(result).toContain('failure-detail')
  })
  it('handles an empty command', async () => {
    expect(await commandTool!.execute({ command: '' })).toBe('Error: No command provided')
  })
  it('handles a successful command without output', async () => {
    expect(await commandTool!.execute({ command: command('process.exit(0)') })).toBe('(no output)')
  })
  it('keeps the parent HTTP server responsive while the child runs', async () => {
    const server = createServer((_request, response) => response.end('parent-responsive'))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing server address')
      const result = await commandTool!.execute({
        command: command(`fetch('http://127.0.0.1:${address.port}', { signal: AbortSignal.timeout(2000) }).then(r => r.text()).then(t => console.log(t)).catch(e => { console.error(e.message); process.exit(1) })`),
      })
      expect(result).toContain('parent-responsive')
      expect(result).not.toContain('Exit code')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 10000)
})
