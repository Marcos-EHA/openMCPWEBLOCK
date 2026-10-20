import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Workspace instance chat views', () => {
  for (const file of ['workspace.html', 'workspace-canvas.html']) {
    test(`${file} has parseable scripts and a card-scoped persistent chat`, () => {
      const html = readFileSync(join(import.meta.dir, file), 'utf8')
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      expect(scripts.length).toBeGreaterThan(0)
      for (const [, source] of scripts) expect(() => new Function(source)).not.toThrow()
      expect(html).toContain('/api/workspace/instance-chat')
      expect(html).toContain('/api/workspace/instance-chat/context')
      expect(html).toContain('/api/workspace/instance-history')
      expect(html).toContain('Conversación de esta instancia')
      expect(html).toContain('Historial de actividad')
      expect(html).toContain('Chats y conversación')
    })
  }
})
