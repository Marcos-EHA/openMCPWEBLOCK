import { randomUUID } from 'node:crypto'
import { isWebCoordinatorRole } from './launchPolicy.js'

export interface StartupHandshakeTarget {
  agentId: string
  instanceId: string
  platformId: string
  role: string
}

export interface StartupHandshakeEvidence extends StartupHandshakeTarget {
  handshakeId: string
  startedAt: number
  completedAt: number
  status: 'instructions-acknowledged'
}

export function createStartupHandshakePrompt(
  target: StartupHandshakeTarget,
  handshakeId: string,
): string {
  for (const [key, value] of Object.entries({ ...target, handshakeId })) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Startup handshake requires a non-empty ${key}`)
    }
  }
  const roleInstruction = isWebCoordinatorRole(target.role)
    ? 'Tu rol es coordinar: planificar las tareas autorizadas, asignarlas a los workers disponibles y revisar sus resultados. No inventes agentes, herramientas, resultados ni acciones de lanzamiento. Usa solo los mecanismos que realmente se te proporcionen.'
    : 'Tu rol es worker: ejecutar la tarea concreta que recibas del coordinador, respetar su alcance y devolver resultados con evidencia y limitaciones. No asumas el rol de coordinador ni asignes trabajo a otras instancias sin una instruccion explicita.'
  const acknowledgement = {
    type: 'workspace-startup-ack',
    handshakeId,
    agentId: target.agentId,
    instanceId: target.instanceId,
    platformId: target.platformId,
    role: target.role,
  }
  return [
    'Preparacion inicial de una instancia del Workspace.',
    roleInstruction,
    'Las herramientas anunciadas operan segun sus esquemas y permisos. Su disponibilidad efectiva se verificara por separado; no afirmes haberlas probado.',
    'Distingue una tarea en ejecucion, un resultado confirmado y un resultado desconocido. Un timeout no confirma que una accion haya fallado ni autoriza repetirla.',
    'En este intercambio inicial no ejecutes herramientas ni modifiques archivos. Confirma que recibiste estas instrucciones devolviendo exclusivamente el siguiente objeto JSON, sin explicaciones ni campos adicionales:',
    JSON.stringify(acknowledgement),
  ].join('\n\n')
}

export function validateStartupHandshakeResponse(
  response: string,
  target: StartupHandshakeTarget,
  handshakeId: string,
): void {
  if (typeof response !== 'string' || response.length > 4096) {
    throw new Error('Startup acknowledgement is missing or exceeds the response limit')
  }
  const trimmed = response.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed)
  let value: unknown
  try {
    value = JSON.parse(fenced ? fenced[1]! : trimmed)
  } catch {
    throw new Error('Startup acknowledgement is not a complete JSON response')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Startup acknowledgement must be an object')
  }
  const expected = {
    type: 'workspace-startup-ack', handshakeId,
    agentId: target.agentId, instanceId: target.instanceId,
    platformId: target.platformId, role: target.role,
  }
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, expectedValue]) => record[key] !== expectedValue)) {
    throw new Error('Startup acknowledgement does not match this attempt, instance and role')
  }
}

export async function performStartupHandshake(
  target: StartupHandshakeTarget,
  sendPrompt: (prompt: string) => Promise<string>,
): Promise<StartupHandshakeEvidence> {
  const handshakeId = randomUUID()
  const prompt = createStartupHandshakePrompt(target, handshakeId)
  const startedAt = Date.now()
  const response = await sendPrompt(prompt)
  validateStartupHandshakeResponse(response, target, handshakeId)
  return {
    ...target, handshakeId, startedAt, completedAt: Date.now(),
    status: 'instructions-acknowledged',
  }
}
