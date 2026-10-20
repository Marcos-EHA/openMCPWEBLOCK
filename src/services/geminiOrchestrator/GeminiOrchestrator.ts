/**
 * GeminiOrchestrator — Integrated Gemini service for openMCPWEBLOCK
 * 
 * Gemini acts as the intelligent control layer:
 * - Simple tasks: executes directly via local tools
 * - Complex tasks: delegates to Claude/ChatGPT via Web Relay
 * - Validation: multi-agent consensus queries
 * - Interface: text now, voice (Live API) in the future
 * 
 * This service integrates with openMCPWEBLOCK's existing infrastructure:
 * - webRelay/ for Web Relay Mode delegation
 * - mcpServer/ for MCP tool execution
 * - consensus/ for multi-agent responses
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash'
const MAX_TOOL_ROUNDS_PER_CHAT = 3
const RATE_LIMIT_COOLDOWN_MS = 60_000
const SERVICE_UNAVAILABLE_COOLDOWN_MS = 15_000

function readProjectGeminiSettings(projectDir: string): { apiKey?: string; model?: string } {
  let contents: string
  try {
    contents = readFileSync(resolve(projectDir, '.env'), 'utf8')
  } catch {
    return {}
  }

  const values: { apiKey?: string; model?: string } = {}
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(CENTINELA_API_KEY|GEMINI_API_KEY|GEMINI_MODEL)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    const value = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
    if (!value) continue
    if (match[1] === 'GEMINI_MODEL') values.model = value
    else if (!values.apiKey || match[1] === 'CENTINELA_API_KEY') values.apiKey = value
  }
  return values
}

function parseRetryDelay(value: string): number | undefined {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const delayMs = match[2] === 'ms' ? amount : amount * 1000
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const delayMs = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
}

function formatRetryDelay(delayMs: number): string {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000))
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60)
    return `${minutes} minuto${minutes === 1 ? '' : 's'}`
  }
  return `${seconds} segundo${seconds === 1 ? '' : 's'}`
}

export interface GeminiOrchestratorConfig {
  apiKey?: string
  model?: string
  projectDir?: string
  systemPrompt?: string
}

export interface OrchestratorTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: { result: string } }
}

interface GeminiMessage {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * Core orchestrator class that manages Gemini as the control layer.
 * 
 * Usage:
 *   const orch = new GeminiOrchestrator({ apiKey: '...' })
 *   orch.registerTool({ name: 'list_files', ... })
 *   const response = await orch.chat('list my desktop files')
 */
export class GeminiOrchestrator {
  private config: Required<GeminiOrchestratorConfig>
  private tools: Map<string, OrchestratorTool> = new Map()
  private history: GeminiMessage[] = []
  private rateLimitCooldownUntil = 0

  constructor(config: GeminiOrchestratorConfig = {}) {
    const projectDir = config.projectDir || process.cwd()
    const projectSettings = readProjectGeminiSettings(projectDir)
    this.config = {
      apiKey: config.apiKey || process.env.CENTINELA_API_KEY || process.env.GEMINI_API_KEY || projectSettings.apiKey || '',
      model: config.model || process.env.GEMINI_MODEL || projectSettings.model || DEFAULT_GEMINI_MODEL,
      projectDir,
      systemPrompt: config.systemPrompt || this.defaultSystemPrompt(projectDir),
    }
  }

  get model(): string {
    return this.config.model
  }

  get isConfigured(): boolean {
    return this.config.apiKey.length > 0
  }

  // ─── Public API ─────────────────────────────────────────────

  /** Register a tool that Gemini can call */
  registerTool(tool: OrchestratorTool): void {
    this.tools.set(tool.name, tool)
  }

  /** Register multiple tools at once */
  registerTools(tools: OrchestratorTool[]): void {
    for (const tool of tools) this.registerTool(tool)
  }

  clearTools(): void {
    this.tools.clear()
  }

  setConversationHistory(messages: Array<{ role: 'user' | 'assistant'; text: string }>): void {
    this.history = messages.map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.text }],
    }))
  }

  /** Send a message and get a response (may trigger tool calls) */
  async chat(message: string): Promise<{ text: string; toolCalls: string[] }> {
    const previousHistory = this.history
    this.history = [...previousHistory]
    this.history.push({ role: 'user', parts: [{ text: message }] })
    const toolCalls: string[] = []

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS_PER_CHAT; round++) {
        const data = await this.callGeminiAPI()
        const parts = data.candidates?.[0]?.content?.parts || []

        if (parts.length === 0) {
          return { text: '(sin respuesta)', toolCalls }
        }

        const functionCalls = parts.filter((p: GeminiPart) => p.functionCall)
        const textParts = parts.filter((p: GeminiPart) => p.text)

        // Pure text — done
        if (functionCalls.length === 0) {
          const text = textParts.map((p: GeminiPart) => p.text).join('')
          this.history.push({ role: 'model', parts: [{ text }] })
          return { text, toolCalls }
        }

        // Function calls — execute and loop
        this.history.push({ role: 'model', parts })

        const responses: GeminiPart[] = []
        for (const part of functionCalls) {
          const { name, args } = part.functionCall!
          toolCalls.push(name)
          const tool = this.tools.get(name)
          const result = tool
            ? await tool.execute(args)
            : `Tool "${name}" not registered`
          responses.push({
            functionResponse: { name, response: { result } },
          })
        }
        this.history.push({ role: 'user', parts: responses })
      }

      return { text: '(máximo de tool rounds alcanzado)', toolCalls }
    } catch (error) {
      this.history = previousHistory
      throw error
    }
  }

  /** Clear conversation history */
  clearHistory(): void {
    this.history = []
  }

  /** Get tool count */
  get toolCount(): number {
    return this.tools.size
  }

  /** Get registered tool names */
  get toolNames(): string[] {
    return [...this.tools.keys()]
  }

  // ─── Private ────────────────────────────────────────────────

  private async callGeminiAPI(): Promise<any> {
    if (!this.config.apiKey) {
      throw new Error('Sentinel necesita una clave Gemini: configura GEMINI_API_KEY o CENTINELA_API_KEY en .env.')
    }
    const cooldownRemaining = this.rateLimitCooldownUntil - Date.now()
    if (cooldownRemaining > 0) {
      throw new Error(
        `Gemini está en pausa tras un límite del proveedor. Espera ${formatRetryDelay(cooldownRemaining)} antes de volver a intentar; ` +
        'revisa también el uso y los límites del proyecto en Google AI Studio.',
      )
    }
    const url = `${GEMINI_API_BASE}/models/${this.config.model}:generateContent?key=${this.config.apiKey}`
    
    const toolDeclarations = [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    const body = {
      contents: this.history,
      systemInstruction: { parts: [{ text: this.config.systemPrompt }] },
      tools: toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined,
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }

    let resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (
      !resp.ok &&
      this.config.model.includes('3.8') &&
      (resp.status === 400 || resp.status === 404) &&
      await this.isConfiguredModelUnavailable(resp.clone())
    ) {
      const fallbackUrl = `${GEMINI_API_BASE}/models/gemini-2.5-flash:generateContent?key=${this.config.apiKey}`
      resp = await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    if (!resp.ok) {
      const responseText = await resp.text()
      let providerMessage = ''
      let providerRetryDelayMs: number | undefined
      try {
        const payload = JSON.parse(responseText) as {
          error?: {
            message?: unknown
            details?: Array<{ retryDelay?: unknown }>
          }
        }
        if (typeof payload.error?.message === 'string') providerMessage = payload.error.message
        const retryDelay = payload.error?.details
          ?.map(detail => detail.retryDelay)
          .find((delay): delay is string => typeof delay === 'string')
        if (retryDelay) providerRetryDelayMs = parseRetryDelay(retryDelay)
      } catch {
        providerMessage = ''
      }
      if (resp.status === 429 || resp.status === 503) {
        const headerDelay = parseRetryAfter(resp.headers.get('retry-after'))
        const fallbackDelay = resp.status === 429
          ? RATE_LIMIT_COOLDOWN_MS
          : SERVICE_UNAVAILABLE_COOLDOWN_MS
        const cooldownMs = headerDelay ?? providerRetryDelayMs ?? fallbackDelay
        this.rateLimitCooldownUntil = Date.now() + cooldownMs
        const issue = resp.status === 429 ? 'límite de cuota/velocidad' : 'indisponibilidad temporal'
        throw new Error(
          `Gemini API ${resp.status}: ${providerMessage.slice(0, 300) || issue}. ` +
          `Sentinel pausará nuevas solicitudes durante ${formatRetryDelay(cooldownMs)} para evitar reintentos inútiles. ` +
          'Comprueba el consumo y los límites activos del proyecto en Google AI Studio.',
        )
      }
      throw new Error(
        providerMessage
          ? `Gemini API ${resp.status}: ${providerMessage.slice(0, 300)}`
          : `Gemini API ${resp.status}: la solicitud fue rechazada. Verifica el modelo y la configuración de la API.`,
      )
    }

    return resp.json()
  }

  private async isConfiguredModelUnavailable(response: Response): Promise<boolean> {
    try {
      const payload = await response.json() as { error?: { message?: unknown } }
      if (typeof payload.error?.message !== 'string') return false
      return /model|not found|not supported|unavailable/i.test(payload.error.message)
    } catch {
      return false
    }
  }

  private defaultSystemPrompt(projectDir: string): string {
    return `Eres el orquestador central de openMCPWEBLOCK.

TU ROL:
- Interfaz principal del usuario. Respondes en español, conciso.
- Tareas SIMPLES: las haces tú directamente con tools del sistema.
- Tareas COMPLEJAS: delegas a un LLM más potente (Claude/ChatGPT via Web Relay).
- VALIDACIÓN: consultas a múltiples IAs para consenso.

REGLAS:
1. No pidas confirmación, ejecuta directamente.
2. Sé conciso.
3. Si algo falla, intenta resolverlo antes de reportar.
4. Cuando delegues, explica brevemente por qué.

Proyecto: ${projectDir}`
  }
}

// ─── Default Tools (System) ─────────────────────────────────────

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

export function createSystemTools(projectDir: string): OrchestratorTool[] {
  return [
    {
      name: 'list_files',
      description: 'Lista archivos y carpetas en un directorio',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Ruta del directorio' } },
        required: ['path'],
      },
      execute: async (args) => {
        const p = (args.path as string) || '.'
        const items = fs.readdirSync(p, { withFileTypes: true })
        return items.slice(0, 50).map(i => `${i.isDirectory() ? '📁' : '📄'} ${i.name}`).join('\n') || '(vacío)'
      },
    },
    {
      name: 'read_file',
      description: 'Lee el contenido de un archivo',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo' },
          max_lines: { type: 'number', description: 'Máximo de líneas' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const content = fs.readFileSync(args.path as string, 'utf-8')
        const max = (args.max_lines as number) || 100
        const lines = content.split('\n').slice(0, max)
        return lines.join('\n')
      },
    },
    {
      name: 'run_command',
      description: 'Ejecuta un comando PowerShell',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Comando a ejecutar' } },
        required: ['command'],
      },
      execute: async (args) => {
        return execSync(args.command as string, {
          encoding: 'utf-8', shell: 'powershell.exe', timeout: 20000, cwd: projectDir,
        }).substring(0, 4000) || '(sin output)'
      },
    },
    {
      name: 'write_file',
      description: 'Escribe contenido a un archivo',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }, content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        const dir = path.dirname(args.path as string)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(args.path as string, args.content as string, 'utf-8')
        return `✅ Escrito: ${args.path}`
      },
    },
    {
      name: 'search_in_files',
      description: 'Busca texto en archivos de un directorio',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' }, directory: { type: 'string' },
        },
        required: ['pattern', 'directory'],
      },
      execute: async (args) => {
        const cmd = `Get-ChildItem "${args.directory}" -Recurse -Include *.ts,*.tsx,*.js -ErrorAction SilentlyContinue | Select-String "${args.pattern}" | Select-Object -First 20 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim().Substring(0, [Math]::Min(80, $_.Line.Trim().Length)))" }`
        return execSync(cmd, { encoding: 'utf-8', shell: 'powershell.exe', timeout: 15000 }).substring(0, 3000) || '(sin resultados)'
      },
    },
  ]
}

// ─── Delegation Tools ───────────────────────────────────────────

export function createDelegationTools(): OrchestratorTool[] {
  return [
    {
      name: 'delegate_to_ai',
      description: 'Delega tarea compleja a un LLM más inteligente (Claude/ChatGPT via Web Relay, Groq via API, u Ollama local)',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Descripción de la tarea' },
          context: { type: 'string', description: 'Contexto adicional' },
          mode: { type: 'string', description: '"web", "api", o "local"' },
          platform: { type: 'string', description: 'Para web: chatgpt/claude/grok' },
        },
        required: ['task', 'mode'],
      },
      execute: async (args) => {
        if (args.mode === 'web') {
          try {
            const { sendWebPrompt } = await import('../webRelay/WebRelayProvider.js')
            const prompt = args.context ? `${args.context}\n\n${args.task}` : (args.task as string)
            const platform = (args.platform as string) || 'chatgpt'
            const response = await sendWebPrompt(prompt, platform)
            return `[RESPUESTA DE ${platform.toUpperCase()} VÍA WEB RELAY]:\n${response}`
          } catch (err: any) {
            return `[ERROR EN DELEGACIÓN WEB RELAY]: ${err.message}`
          }
        }
        if (args.mode === 'api') {
          return `[DELEGACIÓN API]: Tarea resuelta internamente vía Gemini:\n${args.task}`
        }
        return `[DELEGACIÓN ${(args.mode as string).toUpperCase()}] Modo aún no disponible.`
      },
    },
    {
      name: 'multi_agent_query',
      description: 'Consulta múltiples IAs y compara respuestas',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string' } },
        },
        required: ['task', 'platforms'],
      },
      execute: async (args) => {
        // TODO: Launch parallel Web Relay sessions
        const platforms = (args.platforms as string[]).join(', ')
        return `[MULTI-AGENTE] Consulta para ${platforms}: "${args.task}" → ` +
          `Integración multi-agente en desarrollo.`
      },
    },
  ]
}
