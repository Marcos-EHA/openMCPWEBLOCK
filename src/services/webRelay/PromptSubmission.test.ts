import { describe, expect, test } from 'bun:test'
import { buildInsertScript, getAdapter } from './PlatformAdapters.js'
import { insertAndSubmit } from './WebRelayProvider.js'

function fakeConnection(replies: unknown[], diagnostic: unknown = { editors: [] }) {
  const calls: Array<{ method: string; expression: string }> = []
  let diagnosticReads = 0
  const connection = {
    send: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, expression: String(params.expression) })
      if (!replies.length) throw new Error('Unexpected additional browser action')
      return replies.shift()
    },
    evaluate: async () => { diagnosticReads++; return diagnostic },
  } as unknown as Parameters<typeof insertAndSubmit>[0]
  return { connection, calls, diagnosticReads: () => diagnosticReads }
}

const success = () => ({ result: { value: true } })
const failure = () => ({ result: { value: false } })
const exception = () => ({ exceptionDetails: {
  lineNumber: 3,
  exception: { className: 'SyntaxError', description: 'PRIVATE_PROMPT_FRAGMENT' },
} })

describe('web prompt submission', () => {
  test('preserves replacement tokens, quotes, Unicode and newlines literally', () => {
    const adapter = { ...getAdapter('chatgpt'), insertText: '(function(text){return text;})(__PROMPT__)' }
    for (const prompt of ['$&', "$'", '$`', '$$', '__PROMPT__', 'línea uno\n"línea dos"\\fin']) {
      expect(Function('return ' + buildInsertScript(adapter, prompt))()).toBe(prompt)
    }
  })

  test('inserts and submits once after confirmed insertion', async () => {
    const fake = fakeConnection([success(), success()])
    await insertAndSubmit(fake.connection, getAdapter('chatgpt'), 'startup acknowledgement')
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]!.expression).toBe(getAdapter('chatgpt').submitForm)
    expect(fake.diagnosticReads()).toBe(0)
  })

  test('reports missing editor evidence without submitting or retrying', async () => {
    const fake = fakeConnection([failure()], { containerPresent: true, editors: [] })
    await expect(insertAndSubmit(fake.connection, getAdapter('chatgpt'), 'startup'))
      .rejects.toThrow('Editor state: {"containerPresent":true,"editors":[]}')
    expect(fake.calls).toHaveLength(1)
    expect(fake.diagnosticReads()).toBe(1)
  })

  test('reports insertion script errors without exposing the prompt or submitting', async () => {
    const fake = fakeConnection([exception()])
    const error = await insertAndSubmit(fake.connection, getAdapter('chatgpt'), 'startup')
      .catch(error => error as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('insertion failed (SyntaxError, line 3)')
    expect((error as Error).message).not.toContain('PRIVATE_PROMPT_FRAGMENT')
    expect(fake.calls).toHaveLength(1)
  })

  test('reports submission script errors without resending', async () => {
    const fake = fakeConnection([success(), exception()])
    await expect(insertAndSubmit(fake.connection, getAdapter('chatgpt'), 'startup'))
      .rejects.toThrow('submission failed (SyntaxError, line 3)')
    expect(fake.calls).toHaveLength(2)
  })

  test('does not repeat a submission that was not confirmed', async () => {
    const fake = fakeConnection([success(), failure()])
    await expect(insertAndSubmit(fake.connection, getAdapter('chatgpt'), 'startup'))
      .rejects.toThrow('Could not submit the prompt')
    expect(fake.calls).toHaveLength(2)
  })
})
