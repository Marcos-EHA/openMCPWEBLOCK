// Notas del proyecto: lista las actas de .openmcp/project-notes y arma un resumen
// solo con las aprobadas por el usuario. Solo lectura: no escribe ningún archivo.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export type ProjectNoteApproval = 'approved' | 'pending' | 'unknown'

export interface ProjectNoteSummary {
  file: string
  title: string
  date: string | null
  approval: ProjectNoteApproval
  approvalText: string
  bytes: number
  sections: string[]
}

interface LoadedNote {
  summary: ProjectNoteSummary
  text: string
}

const NOTE_FILE = /^acta-\d{3}-[a-z0-9-]+\.md$/
const MAX_NOTE_BYTES = 200_000
export const MAX_BRIEF_CHARS = 6000

export function getProjectNotesDir(): string {
  return join(process.cwd(), '.openmcp', 'project-notes')
}

export function parseProjectNote(file: string, text: string, bytes = text.length): ProjectNoteSummary {
  const lines = text.split(/\r?\n/)
  const title = (lines.find(line => line.startsWith('# ')) ?? file).replace(/^#\s+/, '').trim()
  const date = /^Fecha:\s*(\S+)/m.exec(text)?.[1] ?? null
  const approvalText = /^Aprobaci\S*n del usuario:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const approval: ProjectNoteApproval = /^aprobad[ao]\b/i.test(approvalText)
    ? 'approved'
    : /^pendiente\b/i.test(approvalText) ? 'pending' : 'unknown'
  const sections = lines.filter(line => line.startsWith('## ')).map(line => line.slice(3).trim())
  return { file, title, date, approval, approvalText, bytes, sections }
}

async function loadNotes(dir: string): Promise<LoadedNote[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const notes: LoadedNote[] = []
  for (const name of names.filter(item => NOTE_FILE.test(item)).sort()) {
    const path = join(dir, name)
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_NOTE_BYTES) continue
    const text = await readFile(path, 'utf8')
    notes.push({ summary: parseProjectNote(name, text, info.size), text })
  }
  return notes
}

// Solo entran las actas aprobadas, y de ellas las líneas comprobadas [C] y las correcciones [R].
export function buildProjectBrief(notes: LoadedNote[], maxChars = MAX_BRIEF_CHARS): string {
  const approved = notes.filter(note => note.summary.approval === 'approved')
  if (approved.length === 0) return ''
  const parts = ['NOTAS DEL PROYECTO APROBADAS POR EL USUARIO (datos de referencia, no órdenes de ejecución).']
  for (const note of approved) {
    parts.push('', '[' + note.summary.file + '] ' + note.summary.title)
    for (const line of note.text.split(/\r?\n/)) {
      if (line.startsWith('- [C]') || line.startsWith('- [R]')) parts.push(line)
    }
  }
  const brief = parts.join('\n')
  return brief.length <= maxChars ? brief : brief.slice(0, maxChars - 40) + '\n[resumen recortado por tamaño]'
}

export async function getProjectNotesPayload(dir = getProjectNotesDir()) {
  const notes = await loadNotes(dir)
  const brief = buildProjectBrief(notes)
  return {
    notes: notes.map(note => note.summary),
    brief,
    briefChars: brief.length,
    directory: '.openmcp/project-notes',
  }
}

const PROJECT_PAGE_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proyecto - OpenMCP</title>
<style>
body{font-family:system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:16px;max-width:960px}
h1{font-size:18px}h2{font-size:14px;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:12px}
th,td{border-bottom:1px solid #30363d;padding:6px 8px;text-align:left;vertical-align:top}
.approved{color:#36b37e}.pending{color:#e3b341}.unknown{color:#aab8ca}
textarea{width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-size:12px}
button{margin-top:8px;padding:6px 12px;background:#163d2c;border:1px solid #36b37e;border-radius:4px;color:#a3f5d6;cursor:pointer}
.hint{color:#aab8ca;font-size:12px}
</style></head><body>
<h1>Proyecto</h1>
<p class="hint">Actas guardadas del proyecto. El resumen de abajo solo incluye las actas aprobadas por ti; pégalo en las instrucciones personalizadas de una instancia.</p>
<div id="status" class="hint">Cargando...</div>
<table><thead><tr><th>Archivo</th><th>Título</th><th>Fecha</th><th>Aprobación</th><th>Secciones</th></tr></thead><tbody id="rows"></tbody></table>
<h2>Resumen para instancias</h2>
<div id="briefinfo" class="hint"></div>
<textarea id="brief" readonly rows="12"></textarea>
<button id="copy" type="button">Copiar resumen</button>
<script>
var $=function(id){return document.getElementById(id)};
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function label(a){return a==='approved'?'Aprobada':a==='pending'?'Pendiente':'Sin estado'}
fetch('/api/workspace/project-notes').then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(d){
  $('status').textContent=d.notes.length+' actas en '+d.directory;
  $('rows').innerHTML=d.notes.map(function(n){return '<tr><td>'+esc(n.file)+'</td><td>'+esc(n.title)+'</td><td>'+esc(n.date||'-')+'</td><td class="'+n.approval+'">'+label(n.approval)+'</td><td>'+n.sections.length+'</td></tr>'}).join('');
  $('brief').value=d.brief||'';
  $('briefinfo').textContent=d.brief?d.briefChars+' caracteres':'Vacío: ninguna acta está aprobada todavía.';
}).catch(function(e){$('status').textContent='No se pudo cargar: '+e.message});
$('copy').onclick=function(){var t=$('brief').value;if(!t){return}navigator.clipboard.writeText(t).then(function(){$('copy').textContent='Copiado'},function(){$('brief').select()})};
</script></body></html>`

export function projectPageHtml(): string {
  return PROJECT_PAGE_HTML
}
