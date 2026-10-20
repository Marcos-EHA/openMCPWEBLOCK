/**
 * Architectural invariants for the web-relay multi-agent layer.
 *
 * These are not unit tests of convenience. Each one encodes a property that,
 * when it broke, produced a real defect found during the 2026-09 architecture
 * review. Treat a failure here as a design regression, not a flaky test.
 *
 * Run: bun test src/services/webRelay/invariants.test.ts
 */

import { afterEach, describe, expect, test } from 'bun:test'

import {
  adoptWebInstance,
  bindWebInstanceToAgent,
  createWebInstance,
  listInstanceLeases,
  listWebInstances,
  releaseWebInstance,
  resetWebInstanceRegistry,
  updateWebInstance,
} from './WebInstanceRegistry.js'

import {
  executeToolCall,
  formatSuperAssistantPrompt,
  getEffectClass,
  isAutoRetryable,
  parseToolCalls,
  MAX_TOOL_OUTPUT_CHARS,
} from './WebToolBridge.js'

afterEach(() => {
  resetWebInstanceRegistry()
})

// ─── I1/I2 — Identity is never derived from model output ─────────────────────

describe('INV: execution identity never derives from the model', () => {
  test('two agents emitting the same callId get distinct tool-call ids', () => {
    const response = `<tool_use><tool_name>Read</tool_name><tool_input>{"path":"a.txt"}</tool_input></tool_use>`

    const a = parseToolCalls(response, 'instance-A')
    const b = parseToolCalls(response, 'instance-B')

    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    // The old implementation used `web-tool-${Date.now()}-${idx}`. Two agents
    // parsing in the same millisecond produced byte-identical ids.
    expect(a[0]!.id).not.toBe(b[0]!.id)
    expect(a[0]!.id).toContain('instance-A')
    expect(b[0]!.id).toContain('instance-B')
  })

  test('ids are unique across many rapid parses in the same millisecond', () => {
    const response = `<tool_use><tool_name>Read</tool_name><tool_input>{"path":"a.txt"}</tool_input></tool_use>`
    const ids = new Set<string>()
    for (let i = 0; i < 500; i++) {
      ids.add(parseToolCalls(response, 'instance-A')[0]!.id)
    }
    expect(ids.size).toBe(500)
  })
})

// ─── I4/I20 — A port is transport, never identity ────────────────────────────

describe('INV: debug ports are never handed to two live instances', () => {
  test('concurrent instances never share a debug port', () => {
    const ports = new Set<number>()
    for (let i = 0; i < 8; i++) {
      const instance = createWebInstance('chatgpt', `agent-${i}`)
      expect(ports.has(instance.debugPort)).toBe(false)
      ports.add(instance.debugPort)
    }
    expect(ports.size).toBe(8)
  })

  test('a released port is not reused while another live instance holds it', () => {
    const first = createWebInstance('chatgpt', 'agent-1')
    const second = createWebInstance('chatgpt', 'agent-2')
    expect(first.debugPort).not.toBe(second.debugPort)

    releaseWebInstance(first.instanceId)
    const third = createWebInstance('chatgpt', 'agent-3')

    // Reclaiming agent-1's freed port is fine; stealing agent-2's is not.
    expect(third.debugPort).not.toBe(second.debugPort)
  })

  test('every instance carries a boot epoch and a port lock', () => {
    const instance = createWebInstance('chatgpt', 'agent-1')
    expect(instance.bootId).toBeTruthy()
    expect(instance.portLockPath).toContain(String(instance.debugPort))
  })

  test('an identity-verified instance can be adopted with a fresh process lock', () => {
    const launched = createWebInstance('chatgpt', 'agent-recovered')
    releaseWebInstance(launched.instanceId)

    const recovered = adoptWebInstance(
      launched.instanceId,
      'agent-recovered',
      'chatgpt',
      launched.debugPort,
      launched.profileDir,
    )

    expect(recovered.status).toBe('starting')
    expect(recovered.instanceId).toBe(launched.instanceId)
    expect(recovered.debugPort).toBe(launched.debugPort)
    const leases = listInstanceLeases('agent-recovered')
    expect(leases).toHaveLength(2)
    expect(leases.some(lease => lease.endedAt === undefined)).toBe(true)
    updateWebInstance(recovered.instanceId, { status: 'ready' })
    expect(listWebInstances()[0]!.status).toBe('ready')
  })
})

// ─── I5 — agent↔instance binding is a lease with history ─────────────────────

describe('INV: agent-to-instance binding is a revocable lease, not a field', () => {
  test('rebinding closes the previous lease and records both', () => {
    const first = createWebInstance('chatgpt', 'agent-1')
    const second = createWebInstance('chatgpt')

    bindWebInstanceToAgent(second.instanceId, 'agent-1')
    const leases = listInstanceLeases('agent-1')

    expect(leases).toHaveLength(2)
    const closed = leases.find(l => l.instanceId === first.instanceId)
    const open = leases.find(l => l.instanceId === second.instanceId)

    // Observability question: "which Chrome had agent-1 at time T?"
    expect(closed?.endedAt).toBeGreaterThan(0)
    expect(closed?.reason).toBe('rebound')
    expect(open?.endedAt).toBeUndefined()
  })

  test('an instance is never silently reused across platforms', () => {
    const chatgpt = createWebInstance('chatgpt', 'agent-1')
    const claude = createWebInstance('claude', 'agent-1')
    // The old code returned the existing instance regardless of platform,
    // pointing the agent at the wrong site.
    expect(claude.instanceId).not.toBe(chatgpt.instanceId)
  })
})

// ─── I14 — state transitions form a DAG ──────────────────────────────────────

describe('INV: instance status transitions are validated', () => {
  test('illegal transitions are rejected instead of silently applied', () => {
    const instance = createWebInstance('chatgpt', 'agent-1')
    // created -> busy skips starting/ready.
    expect(() => updateWebInstance(instance.instanceId, { status: 'busy' })).toThrow()
  })

  test('legal transitions are applied', () => {
    const instance = createWebInstance('chatgpt', 'agent-1')
    updateWebInstance(instance.instanceId, { status: 'starting' })
    updateWebInstance(instance.instanceId, { status: 'ready' })
    updateWebInstance(instance.instanceId, { status: 'busy' })
    expect(listWebInstances()[0]!.status).toBe('busy')
  })
})

// ─── I10 — retry safety is a property of the tool ────────────────────────────

describe('INV: effectful tools are never auto-retryable', () => {
  test('Bash is effectful', () => {
    expect(getEffectClass('Bash')).toBe('effectful')
    expect(isAutoRetryable('Bash')).toBe(false)
  })

  test('read-only tools are pure', () => {
    for (const name of ['Read', 'ListDir', 'Grep', 'Glob']) {
      expect(getEffectClass(name)).toBe('pure')
      expect(isAutoRetryable(name)).toBe(true)
    }
  })

  test('unknown tools fail safe as effectful', () => {
    // A tool nobody classified must not be retried on a timeout.
    expect(getEffectClass('SomeToolAddedNextTuesday')).toBe('effectful')
    expect(isAutoRetryable('SomeToolAddedNextTuesday')).toBe(false)
  })

  test('namespaced aliases resolve to the same class', () => {
    expect(getEffectClass('shell.Bash')).toBe('effectful')
  })
})

// ─── I9 — re-delivery is never re-execution ──────────────────────────────────

describe('INV: a repeated effectful call inside the window does not re-run', () => {
  test('duplicate Bash call returns the first result instead of executing twice', async () => {
    let executions = 0
    const bash = {
      name: 'Bash',
      call: async () => {
        executions++
        return 'ok'
      },
    }

    const call = { id: 'c1', name: 'Bash', input: { command: 'git push' } }
    await executeToolCall({ ...call }, [bash] as any[], 'instance-A')
    await executeToolCall({ ...call, id: 'c2' }, [bash] as any[], 'instance-A')

    // The tool loop re-reads pending calls from the page every iteration and
    // the page repeats them. Executing twice here means a double `git push`.
    expect(executions).toBe(1)
  })

  test('dedup is scoped per instance, never global', async () => {
    let executions = 0
    const bash = {
      name: 'Bash',
      call: async () => {
        executions++
        return 'ok'
      },
    }

    const call = { id: 'c1', name: 'Bash', input: { command: 'bun test' } }
    await executeToolCall({ ...call }, [bash] as any[], 'instance-A')
    await executeToolCall({ ...call }, [bash] as any[], 'instance-B')

    // Agent B's work must not be suppressed by agent A's identical call.
    expect(executions).toBe(2)
  })
})

// ─── I12 — results are a bounded projection, and truncation is visible ───────

describe('INV: oversized results are truncated explicitly', () => {
  test('truncation is announced to the model, not silent', async () => {
    const huge = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2)
    const reader = { name: 'Read', call: async () => huge }

    const result = await executeToolCall(
      { id: 'c1', name: 'Read', input: { path: 'big.txt' } },
      [reader] as any[],
      'instance-A',
    )

    // Silent truncation made the model act as if it had the whole file.
    expect(result.output).toContain('[TRUNCATED]')
    expect(result.output).toContain(String(huge.length))
    expect(result.output.length).toBeLessThan(huge.length)
  })
})

// ─── Security — the model is never told it owns the disk ─────────────────────

describe('INV: advertised filesystem scope excludes drive roots', () => {
  test('allowed_directories never contains a bare drive root', async () => {
    const result = await executeToolCall(
      { id: 'c1', name: 'filesystem.list_allowed_directories', input: {} },
      [] as any[],
      'instance-A',
    )

    const parsed = JSON.parse(result.output) as { allowed_directories: string[] }
    for (const dir of parsed.allowed_directories) {
      const normalized = dir.replace(/[\\/]+$/, '')
      expect(/^[a-zA-Z]:$/.test(normalized)).toBe(false)
      expect(normalized).not.toBe('')
    }
  })
})

// ─── SuperAssistant Prompt Attachment ───────────────────────────────────────

describe('INV: SuperAssistant prompt attachment', () => {
  test('formats tool instructions with schemas and the JSONL event contract', () => {
    const prompt = formatSuperAssistantPrompt('Read file', [
      {
        name: 'Read',
        description: 'Reads a file',
        inputSchema: {
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ])
    expect(prompt).toContain('[SuperAssistant Operational Instructions][IMPORTANT]')
    expect(prompt).toContain('<tool name="Read">')
    expect(prompt).toContain('<parameter name="file_path" type="string" required="true">')
    expect(prompt).toContain('function_call_start')
    expect(prompt).not.toContain('<function_calls>')
    expect(prompt).not.toContain('"type":"function_call_start"')
    expect(prompt).not.toContain('"type":"parameter"')
    expect(prompt).not.toContain('"type":"function_call_end"')
    expect(prompt).toContain('Never emit protocol labels')
    expect(prompt).toContain('Read file')
  })

  test('formats MCP snake_case schemas with required parameters', () => {
    const prompt = formatSuperAssistantPrompt('Run a harmless check', [
      {
        name: 'Bash',
        description: 'Runs a command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to execute' },
          },
          required: ['command'],
        },
      },
    ])

    expect(prompt).toContain('<tool name="Bash">')
    expect(prompt).toContain(
      '<parameter name="command" type="string" required="true">Command to execute</parameter>',
    )
  })

  test('is idempotent when instructions are already attached', () => {
    const original = '[SuperAssistant Operational Instructions][IMPORTANT]\nhello'
    const formatted = formatSuperAssistantPrompt(original)
    expect(formatted).toBe(original)
  })
})
