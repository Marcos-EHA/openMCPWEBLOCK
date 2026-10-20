/**
 * SentinelCurator - Traduce eventos crudos en contenido curado.
 */

import {
  CuratedContent,
  CuratedItem,
  CuratedMessage,
  CuratedAnomaly,
  CuratorEvent,
  SurfaceConfig,
  SurfaceMode,
  formatElapsed,
} from './types.js'

export class SentinelCurator {
  config: SurfaceConfig
  private content: CuratedContent
  private listeners = new Set<(c: CuratedContent) => void>()
  private taskStart: number | null = null
  private workers = new Map<string, { name: string; sub: string; t0: number }>()
  private msgCount = 0
  private anomCount = 0

  constructor(cfg?: Partial<SurfaceConfig>) {
    this.config = {
      profile: 'mixed',
      detailLevel: 'adaptive',
      defaultMode: 'auto',
      showAnomalies: 'only-unresolved',
      conversational: true,
      autoResolve: true,
      show: { milestones: true, draftPreviews: true, tokenCount: false, timestamps: false, technicalLog: false },
      ...cfg,
    }
    this.content = this.empty()
  }

  ingest(ev: CuratorEvent): void {
    switch (ev.type) {
      case 'task-started': this.onTaskStart(ev); break
      case 'worker-started': this.onWorkerStart(ev); break
      case 'worker-responded': this.onWorkerDone(ev); break
      case 'worker-error': this.onWorkerErr(ev); break
      case 'anomaly-detected': this.onAnomaly(ev); break
      case 'anomaly-resolved': this.onAnomalyFixed(ev); break
      case 'user-message': this.onUserMsg(ev); break
      case 'task-finished': this.onTaskDone(ev); break
      case 'task-progress': this.onProgress(ev); break
      case 'agent-status': break
    }
    this.summarize()
    this.emit()
  }

  getContent() { return this.content }

  subscribe(fn: (c: CuratedContent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  setMode(m: SurfaceMode) { this.content.mode = m; this.emit() }

  private onTaskStart(ev: any) {
    this.taskStart = Date.now()
    this.content.taskTitle = ev.taskTitle
    this.workers.clear()
    this.content.items = []
    if (this.config.defaultMode === 'auto') {
      this.content.mode = this.detectMode(ev.taskTitle)
    }
    if (this.config.conversational) {
      this.say(this.tr('Tarea iniciada. Te mantendre al tanto.', 'Task started.'))
    }
  }

  private onWorkerStart(ev: any) {
    this.workers.set(ev.agentId, { name: ev.agentName, sub: ev.subTask, t0: Date.now() })
    const item: CuratedItem = { id: 'i-' + ev.agentId, title: ev.subTask, status: 'active', agentName: ev.agentName }
    const idx = this.content.items.findIndex(i => i.id === item.id)
    if (idx >= 0) this.content.items[idx] = item
    else this.content.items.push(item)
  }

  private onWorkerDone(ev: any) {
    const w = this.workers.get(ev.agentId)
    this.workers.delete(ev.agentId)
    const item = this.content.items.find(i => i.id === 'i-' + ev.agentId)
    if (item) {
      item.status = 'done'
      if (w) item.elapsedMs = Date.now() - w.t0
      if (this.config.show.draftPreviews && ev.response) {
        item.preview = ev.response.substring(0, 80) + (ev.response.length > 80 ? '...' : '')
      }
    }
    const total = this.content.items.length
    const done = this.content.items.filter(i => i.status === 'done').length
    if (total > 0) this.content.overallProgress = Math.round((done / total) * 100)
    if (this.config.conversational && this.config.show.milestones && w) {
      this.say(this.tr(ev.agentName + ' termino (' + formatElapsed(Date.now() - w.t0) + ')', ev.agentName + ' done'))
    }
  }

  private onWorkerErr(ev: any) {
    this.workers.delete(ev.agentId)
    const item = this.content.items.find(i => i.id === 'i-' + ev.agentId)
    if (item) item.status = 'blocked'
    if (this.config.autoResolve && ev.error.toLowerCase().includes('timeout')) {
      this.say(this.tr(ev.agentName + ' se atasco, ya pedi otro.', ev.agentName + ' timeout, redirecting.'))
      return
    }
    this.content.anomalies.push({
      id: 'a-' + (++this.anomCount),
      agentName: ev.agentName,
      description: ev.error,
      userMessage: ev.agentName + ': ' + ev.error,
      canAutoResolve: false,
      availableActions: [
        { key: 'r', label: 'Reintentar' },
        { key: 's', label: 'Detener' },
        { key: 'i', label: 'Investigar' },
        { key: 'd', label: 'Descartar' },
      ],
    })
  }

  private onAnomaly(ev: any) {
    if (this.config.autoResolve && this.canAuto(ev.kind)) {
      this.say(this.tr(ev.agentName + ': resolviendo automaticamente.', ev.agentName + ': auto-resolving.'))
      return
    }
    this.content.anomalies.push({
      id: 'a-' + (++this.anomCount),
      agentName: ev.agentName,
      description: ev.description,
      userMessage: ev.agentName + ': ' + this.kindText(ev.kind),
      canAutoResolve: this.canAuto(ev.kind),
      availableActions: [
        { key: 'r', label: 'Reintentar' },
        { key: 's', label: 'Detener' },
        { key: 'i', label: 'Investigar' },
        { key: 'd', label: 'Descartar' },
      ],
    })
  }

  private onAnomalyFixed(ev: any) {
    this.content.anomalies = this.content.anomalies.filter(a => a.agentName !== ev.agentName)
    this.say(this.tr(ev.agentName + ': resuelto.', ev.agentName + ': resolved.'))
  }

  private onUserMsg(ev: any) {
    this.content.mode = 'conversation'
    this.say('Tu: ' + ev.text)
  }

  private onTaskDone(ev: any) {
    this.content.overallProgress = 100
    if (this.config.conversational) {
      const el = this.taskStart ? formatElapsed(Date.now() - this.taskStart) : ''
      this.say(this.tr('Listo en ' + el + '.', 'Done in ' + el + '.'))
    }
  }

  private onProgress(ev: any) {
    this.content.overallProgress = Math.round((ev.completed / ev.total) * 100)
    if (this.isMilestone(this.content.overallProgress)) {
      this.say(this.tr('Voy al ' + this.content.overallProgress + '%.', 'Progress: ' + this.content.overallProgress + '%'))
    }
  }

  private detectMode(title: string): SurfaceMode {
    const l = title.toLowerCase()
    if (l.includes('informe') || l.includes('reporte') || l.includes('word') || l.includes('escribe')) return 'document'
    if (l.includes('investiga') || l.includes('busca') || l.includes('analiza')) return 'graph'
    return 'progress'
  }

  private tr(narr: string, tech: string): string {
    if (this.config.profile === 'technical') return tech
    return narr
  }

  private kindText(kind: string): string {
    const map: Record<string, string> = { timeout: 'se demoro', 'no-dispatch': 'no respondio', 'wrong-tool': 'uso herramienta incorrecta', lost: 'se perdio conexion' }
    return map[kind] || 'tuvo un problema'
  }

  private canAuto(kind: string): boolean {
    return kind === 'timeout' || kind === 'no-dispatch' || kind === 'lost'
  }

  private isMilestone(p: number): boolean {
    return p === 25 || p === 50 || p === 75 || p === 100
  }

  private say(text: string) {
    this.content.messages.push({ id: 'm-' + (++this.msgCount), text, timestamp: Date.now() })
    if (this.content.messages.length > 10) this.content.messages = this.content.messages.slice(-10)
  }

  private summarize() {
    const active = this.workers.size
    const done = this.content.items.filter(i => i.status === 'done').length
    const total = this.content.items.length
    if (this.content.overallProgress === 100) {
      this.content.summaryLine = 'Completado'
    } else if (active > 0) {
      this.content.summaryLine = this.content.overallProgress + '% | ' + active + ' trabajando'
    } else if (total > 0) {
      this.content.summaryLine = this.content.overallProgress + '% | ' + done + '/' + total + ' completadas'
    } else {
      this.content.summaryLine = 'Esperando...'
    }
    this.content.updatedAt = Date.now()
  }

  private empty(): CuratedContent {
    return { mode: 'auto', items: [], messages: [], anomalies: [], overallProgress: 0, summaryLine: 'Esperando...', updatedAt: Date.now() }
  }

  private emit() {
    for (const fn of this.listeners) {
      try { fn(this.content) } catch { /* ignore */ }
    }
  }
}

let inst: SentinelCurator | null = null
export function getSentinelCurator(cfg?: Partial<SurfaceConfig>): SentinelCurator {
  if (!inst) inst = new SentinelCurator(cfg)
  return inst
}