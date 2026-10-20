import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'bun:test'
import { MCPSSEServer } from './MCPSSEServer.js'
import { sharedActivityJournal } from '../observability/SharedActivityJournal.js'

async function getAvailablePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => probe.close(() => resolve()))
    throw new Error('Could not determine a free local TCP port for the MCP integration test.')
  }
  await new Promise<void>((resolve, reject) => {
    probe.close(error => error ? reject(error) : resolve())
  })
  return address.port
}

function getToolText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('content' in result) ||
    !Array.isArray(result.content)) return undefined
  const textBlock = result.content.find((item): item is { type: 'text'; text: string } =>
    typeof item === 'object' && item !== null &&
    'type' in item && item.type === 'text' &&
    'text' in item && typeof item.text === 'string',
  )
  return textBlock?.text
}

describe('MCPSSEServer image tool results', () => {
  it('preserves image content blocks through Streamable HTTP', async () => {
    const port = await getAvailablePort()
    const server = new MCPSSEServer({ port })
    const image = {
      type: 'image' as const,
      data: '/9j/2Q==',
      mimeType: 'image/jpeg',
    }
    server.registerTools([{
      name: 'test_image_result',
      description: 'Test MCP image result.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({
        content: [
          { type: 'text' as const, text: 'viewport captured' },
          image,
        ],
      }),
    }])

    const client = new Client({ name: 'mcp-image-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    )
    try {
      await server.start()
      await client.connect(transport)
      const listedTools = await client.listTools()
      expect(listedTools.tools.some(tool => tool.name === 'sentinel_capture_instance_view')).toBe(true)
      expect(listedTools.tools.some(tool => tool.name === 'openmcp_read_activity')).toBe(true)
      expect(listedTools.tools.some(tool => tool.name === 'openmcp_watch_activity')).toBe(true)
      expect(listedTools.tools.some(tool => tool.name === 'workspace_join')).toBe(true)
      expect(listedTools.tools.some(tool => tool.name === 'workspace_get_state')).toBe(true)
      expect(listedTools.tools.some(tool => tool.name === 'workspace_inspect_instance')).toBe(true)
      const participantId = `mcp-workspace-test-${Date.now()}`
      const joined = await client.callTool({
        name: 'workspace_join',
        arguments: {
          id: participantId,
          provider: 'test-ide',
          displayName: 'MCP IDE Test',
          capabilities: ['review'],
        },
      })
      expect(joined.isError).not.toBe(true)
      const assignment = await client.callTool({
        name: 'workspace_assign_task',
        arguments: { participantId, prompt: 'Verify MCP registration.' },
      })
      const assignmentText = getToolText(assignment)
      const assignedTask = assignmentText ? JSON.parse(assignmentText) : null
      const claimed = await client.callTool({
        name: 'workspace_poll_tasks',
        arguments: { participantId },
      })
      const claimedText = getToolText(claimed)
      const claimedTasks = claimedText ? JSON.parse(claimedText) : []
      expect(claimedTasks).toHaveLength(1)
      expect(claimedTasks[0].id).toBe(assignedTask.id)
      const taskResult = await client.callTool({
        name: 'workspace_complete_task',
        arguments: { participantId, taskId: assignedTask.id, response: 'MCP workspace verified.' },
      })
      expect(taskResult.isError).not.toBe(true)
      const readActivity = await client.callTool({
        name: 'openmcp_read_activity',
        arguments: { limit: 10 },
      })
      const readText = getToolText(readActivity)
      expect(readText ? JSON.parse(readText).nextSequence : -1).toBeGreaterThanOrEqual(0)
      const afterSequence = sharedActivityJournal.latestSequence
      const watchingActivity = client.callTool({
        name: 'openmcp_watch_activity',
        arguments: { afterSequence, waitSeconds: 1, sources: ['coordinator'] },
      })
      setTimeout(() => {
        sharedActivityJournal.append({
          source: 'coordinator',
          event: 'coordinator:mcp-e2e-phase',
          agentId: 'mcp-test-coordinator',
          details: { phase: 'planning-started' },
        })
      }, 25)
      const watched = await watchingActivity
      const watchedText = getToolText(watched)
      const watchedData = watchedText ? JSON.parse(watchedText) : null
      expect(watchedData?.events?.some((event: { event: string }) =>
        event.event === 'coordinator:mcp-e2e-phase',
      )).toBe(true)
      const deniedCapture = await client.callTool({
        name: 'sentinel_capture_instance_view',
        arguments: { agentId: 'unregistered-image-test-agent', userApproved: false },
      })
      expect(deniedCapture.isError).toBe(true)
      expect(deniedCapture.content).toContainEqual(expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('requires explicit user approval'),
      }))
      const result = await client.callTool({ name: 'test_image_result', arguments: {} })
      expect(result.content).toContainEqual(image)
      const mcpActivity = await client.callTool({
        name: 'openmcp_read_activity',
        arguments: { limit: 50, sources: ['mcp'] },
      })
      const mcpActivityText = getToolText(mcpActivity)
      const mcpEvents = mcpActivityText
        ? JSON.parse(mcpActivityText).events as Array<{
          event: string
          details?: Record<string, unknown>
        }>
        : []
      expect(mcpEvents.some(event =>
        event.event === 'mcp:tool-dispatch' &&
        event.details?.toolName === 'test_image_result',
      )).toBe(true)
      expect(JSON.stringify(mcpEvents)).not.toContain('viewport captured')
    } finally {
      await client.close()
      await server.stop()
    }
  })
})
