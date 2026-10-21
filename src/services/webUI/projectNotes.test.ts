import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_BRIEF_CHARS,
  getProjectNotesPayload,
  parseProjectNote,
  projectPageHtml,
} from './projectNotes.js'

const created: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmcp-notes-'))
  created.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

const approvedNote = [
  '# Acta 900 - Prueba aprobada',
  '',
  'Fecha: 2026-10-20',
  'Aprobación del usuario: APROBADA',
  '',
  '## 1. Datos',
  '- [C] hecho comprobado uno',
  '- [I] suposición que no debe entrar',
  '- [R] corrección que sí debe entrar',
  '- [?] duda que no debe entrar',
].join('\n')

const pendingNote = [
  '# Acta 901 - Prueba pendiente',
  'Fecha: 2026-10-21',
  'Aprobación del usuario: PENDIENTE',
  '## 1. Datos',
  '- [C] hecho de un acta pendiente que no debe entrar',
].join('\n')

describe('parseProjectNote', () => {
  test('lee título, fecha, aprobación y secciones', () => {
    const note = parseProjectNote('acta-900-x.md', approvedNote)
    expect(note.title).toBe('Acta 900 - Prueba aprobada')
    expect(note.date).toBe('2026-10-20')
    expect(note.approval).toBe('approved')
    expect(note.sections).toEqual(['1. Datos'])
  })

  test('distingue pendiente y sin estado', () => {
    expect(parseProjectNote('a.md', pendingNote).approval).toBe('pending')
    expect(parseProjectNote('b.md', '# Sin estado\nTexto').approval).toBe('unknown')
  })

  test('acepta saltos de línea de Windows', () => {
    const note = parseProjectNote('c.md', approvedNote.split('\n').join('\r\n'))
    expect(note.approval).toBe('approved')
    expect(note.date).toBe('2026-10-20')
    expect(note.title).toBe('Acta 900 - Prueba aprobada')
  })
})

describe('getProjectNotesPayload con actas inventadas', () => {
  test('solo resume las aprobadas y solo con líneas comprobadas o corregidas', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'acta-900-aprobada.md'), approvedNote, 'utf8')
    await writeFile(join(dir, 'acta-901-pendiente.md'), pendingNote, 'utf8')
    await writeFile(join(dir, 'notas.md'), '# Ajena', 'utf8')
    await writeFile(join(dir, 'acta-xx.md'), '# Nombre inválido', 'utf8')
    const payload = await getProjectNotesPayload(dir)
    expect(payload.notes.map(note => note.file)).toEqual(['acta-900-aprobada.md', 'acta-901-pendiente.md'])
    expect(payload.brief).toContain('hecho comprobado uno')
    expect(payload.brief).toContain('corrección que sí debe entrar')
    expect(payload.brief).not.toContain('suposición')
    expect(payload.brief).not.toContain('duda que no debe entrar')
    expect(payload.brief).not.toContain('acta pendiente')
    expect(payload.briefChars).toBe(payload.brief.length)
  })

  test('sin actas aprobadas el resumen queda vacío', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'acta-901-pendiente.md'), pendingNote, 'utf8')
    const payload = await getProjectNotesPayload(dir)
    expect(payload.notes.length).toBe(1)
    expect(payload.brief).toBe('')
  })

  test('una carpeta que no existe devuelve vacío sin fallar', async () => {
    const payload = await getProjectNotesPayload(join(tmpdir(), 'openmcp-no-existe-' + Date.now()))
    expect(payload.notes).toEqual([])
    expect(payload.brief).toBe('')
  })

  test('el resumen nunca supera el tamaño máximo', async () => {
    const dir = await tempDir()
    const lines = ['# Acta 902 - Larga', 'Fecha: 2026-10-22', 'Aprobación del usuario: APROBADA']
    for (let i = 0; i < 400; i++) {
      lines.push('- [C] línea comprobada número ' + i + ' con texto de relleno suficiente')
    }
    await writeFile(join(dir, 'acta-902-larga.md'), lines.join('\n'), 'utf8')
    const payload = await getProjectNotesPayload(dir)
    expect(payload.brief.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS)
    expect(payload.brief).toContain('recortado')
  })
})

describe('página y actas reales', () => {
  test('la página pide el punto de lectura de notas y escapa el texto', () => {
    const html = projectPageHtml()
    expect(html).toContain('/api/workspace/project-notes')
    expect(html).toContain('esc(n.title)')
  })

  test('lee las actas reales del proyecto sin escribir nada', async () => {
    const payload = await getProjectNotesPayload(join(process.cwd(), '.openmcp', 'project-notes'))
    expect(payload.notes.length).toBeGreaterThanOrEqual(5)
    expect(payload.notes.every(note => note.file.startsWith('acta-'))).toBe(true)
    expect(payload.briefChars).toBe(payload.brief.length)
  })
})
