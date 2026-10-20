/**
 * types.ts — Tipos para la superficie de colaboración
 * El lienzo que refleja el trabajo de agentes en tiempo real.
 */

// ─── Modos de visualización ───────────────────────────────────────────────────

export type SurfaceMode =
  | 'auto'           // Detecta según tipo de tarea
  | 'document'       // Borrador evolutivo (para tareas de escritura)
  | 'graph'          // Grafo de investigación (para research)
  | 'progress'       // Overview simple (progreso + estado)
  | 'conversation'   // Cuando el usuario pregunta algo

// ─── Contenido curado por Sentinel ──────────────────────────────────────────

export type CuratedItemStatus = 'done' | 'active' | 'pending' | 'blocked'

export interface CuratedItem {
  id: string
  title: string
  status: CuratedItemStatus
  /** Quién está trabajando en esto (nombre amigable, no agentId técnico) */
  agentName?: string
  /** Preview del contenido (para modo documento) */
  preview?: string
  /** Sub-items (secciones de documento, nodos de grafo) */
  children?: CuratedItem[]
  /** Tiempo transcurrido desde inicio */
  elapsedMs?: number
  /** Progreso 0-100 si es medible */
  progress?: number
}

export interface CuratedMessage {
  id: string
  /** Lo que Sentinel dice al usuario (adaptado a su perfil) */
  text: string
  /** Si requiere respuesta del usuario */
  expectsResponse?: boolean
  /** Acciones sugeridas */
  actions?: Array<{ key: string; label: string }>
  timestamp: number
}

export interface CuratedAnomaly {
  id: string
  agentName: string
  description: string
  /** Traducido al nivel del usuario */
  userMessage: string
  /** Si Sentinel puede auto-resolver */
  canAutoResolve: boolean
  /** Si ya se auto-resolvió */
  autoResolved?: boolean
  availableActions: Array<{ key: string; label: string }>
}

export interface CuratedContent {
  /** Modo actual de visualización */
  mode: SurfaceMode
  /** Título de la tarea activa */
  taskTitle?: string
  /** Items para el modo documento/grao/progress */
  items: CuratedItem[]
  /** Mensajes de Sentinel (conversación) */
  messages: CuratedMessage[]
  /** Anomalías que llegaron al usuario (solo las no auto-resueltas) */
  anomalies: CuratedAnomaly[]
  /** Progreso general 0-100 */
  overallProgress: number
  /** Resumen en una línea */
  summaryLine: string
  /** Timestamp de última actualización */
  updatedAt: number
}

// ─── Configuración del usuario ────────────────────────────────────────────────

export type UserProfile = 'technical' | 'non-technical' | 'mixed'
export type DetailLevel = 'minimal' | 'medium' | 'full' | 'adaptive'

export interface SurfaceConfig {
  /** Perfil del usuario (afecta cómo Sentinel comunica) */
  profile: UserProfile
  /** Cuánto detalle mostrar por defecto */
  detailLevel: DetailLevel
  /** Modo preferido (o auto) */
  defaultMode: SurfaceMode
  /** Mostrar anomalías siempre o solo cuando no puede auto-resolver */
  showAnomalies: 'always' | 'only-unresolved'
  /** Sentinel conversa con el usuario */
  conversational: boolean
  /** Sentinel intenta auto-resolver antes de notificar */
  autoResolve: boolean
  /** Elementos específicos a mostrar/ocultar */
  show: {
    milestones: boolean
    draftPreviews: boolean
    tokenCount: boolean
    timestamps: boolean
    technicalLog: boolean
  }
}

export const DEFAULT_CONFIG: SurfaceConfig = {
  profile: 'mixed',
  detailLevel: 'adaptive',
  defaultMode: 'auto',
  showAnomalies: 'only-unresolved',
  conversational: true,
  autoResolve: true,
  show: {
    milestones: true,
    draftPreviews: true,
    tokenCount: false,
    timestamps: false,
    technicalLog: false,
  },
}

// ─── Eventos que el curador recibe ───────────────────────────────────────────

export type CuratorEvent =
  | { type: 'agent-status'; agentId: string; agentName: string; status: string; detail?: string }
  | { type: 'task-started'; taskId: string; taskTitle: string }
  | { type: 'task-progress'; taskId: string; completed: number; total: number; currentActivity: string }
  | { type: 'task-finished'; taskId: string; result?: string }
  | { type: 'worker-started'; taskId: string; agentId: string; agentName: string; subTask: string }
  | { type: 'worker-responded'; taskId: string; agentId: string; agentName: string; response: string }
  | { type: 'worker-error'; taskId: string; agentId: string; agentName: string; error: string }
  | { type: 'anomaly-detected'; agentId: string; agentName: string; kind: 'timeout' | 'no-dispatch' | 'wrong-tool' | 'lost'; description: string }
  | { type: 'anomaly-resolved'; agentId: string; agentName: string; how: string }
  | { type: 'user-message'; text: string }

// ─── Utilidades ──────────────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function makeFriendlyName(agentId: string): string {
  if (agentId.includes('glm') || agentId.includes('z-ai')) return 'GLM'
  if (agentId.includes('chatgpt') || agentId.includes('loco-verde')) return 'ChatGPT'
  if (agentId.includes('claude') || agentId.includes('locoverdesito')) return 'Claude'
  if (agentId.includes('gemini')) return 'Gemini'
  return agentId.split('-')[0].charAt(0).toUpperCase() + agentId.split('-')[0].slice(1)
}