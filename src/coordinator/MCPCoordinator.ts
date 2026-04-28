/**
 * MCPCoordinator - Estrategia Minimal para Testing con OpenRouter
 * Propósito: Decidir cuál proveedor usar sin invocar modelo
 */

export interface StrategyDecision {
  strategy: 'local-ollama' | 'openrouter-free' | 'mcp-superassistant' | 'anthropic-fallback'
  model: string
  tools: string[]
  baseUrl?: string
  apiKey?: string
  estimatedLatency: 'sub-1s' | '1-3s' | '3-5s'
  reason: string
}

export interface QueryContext {
  userInput: string
  conversationLength: number
  availableTools: number
  resourcesAvailable: {
    ollama: boolean
    openrouter: boolean
    mcp: boolean
    anthropic: boolean
  }
}

export class MCPCoordinator {
  /**
   * Selecciona estrategia óptima ANTES de invocar modelo
   * Retorna decisión que QueryEngine usará
   */
  async selectStrategy(userInput: string, context: QueryContext): Promise<StrategyDecision> {
    // Análisis Fase 1: Complejidad del input
    const complexity = this.analyzeComplexity(userInput)
    
    // Análisis Fase 2: Herramientas necesarias
    const requiredToolCount = this.detectRequiredToolCount(userInput)
    
    // Análisis Fase 3: Recursos disponibles
    const resources = context.resourcesAvailable
    
    // Fase 4: Seleccionar estrategia óptima
    return this.selectOptimalStrategy(complexity, requiredToolCount, resources)
  }

  /**
   * Analiza complejidad del input (0-10)
   * Heurísticas puras, sin modelo
   */
  private analyzeComplexity(input: string): number {
    let score = 0
    
    // Longitud
    if (input.length > 500) score += 1
    if (input.length > 1000) score += 2
    
    // Keywords de razonamiento (IMPORTANTES)
    if (/analyze|analyse|explore|investigate|examine|review/i.test(input)) score += 3
    if (/compare|contrast|difference/i.test(input)) score += 2
    if (/design|architect|plan|structure|organize/i.test(input)) score += 3
    if (/optimize|improve|refactor|enhance/i.test(input)) score += 3
    if (/debug|troubleshoot|fix|error|problem|issue/i.test(input)) score += 3
    if (/explain|understand|clarify|why|how does/i.test(input)) score += 2
    if (/suggest|recommend|propose|what should|best practice/i.test(input)) score += 2
    
    // Palabras clave que indican múltiples herramientas
    if (/push|commit|merge|github|gitlab/i.test(input)) score += 1
    if (/slack|notify|message|send/i.test(input)) score += 1
    if (/jira|ticket|issue|task/i.test(input)) score += 1
    
    // Keywords de simplicidad (RESTAN)
    if (/list|show|display|ls|cat|print|output/i.test(input)) score -= 2
    if (/read|get|fetch|retrieve/i.test(input)) score -= 1
    
    return Math.max(0, Math.min(10, score))
  }

  /**
   * Detecta cuántas herramientas probablemente necesita
   * Basado en keywords
   */
  private detectRequiredToolCount(input: string): number {
    const toolKeywords = {
      github: 1,
      git: 1,
      commit: 1,
      push: 1,
      pull: 1,
      slack: 1,
      notify: 1,
      message: 1,
      jira: 1,
      ticket: 1,
      desktop: 1,
      screen: 1,
      read: 0.5,
      write: 0.5,
      edit: 0.5,
      bash: 0.5,
    }

    let totalTools = 0
    for (const [keyword, weight] of Object.entries(toolKeywords)) {
      if (new RegExp(keyword, 'i').test(input)) {
        totalTools += weight
      }
    }

    // Si menciona múltiples palabras clave, acumula
    // Ejemplo: "push github and slack" → 1 + 1 = 2 tools
    return Math.min(Math.ceil(totalTools), 5)
  }

  /**
   * Decisión final de estrategia
   */
  private selectOptimalStrategy(
    complexity: number,
    requiredTools: number,
    resources: Record<string, boolean>
  ): StrategyDecision {
    // ESTRATEGIA 3: MCP-SuperAssistant (coordinador central) - PRIORIDAD ALTA
    // Ideal: Multi-tool coordination
    if (requiredTools > 2 && resources.mcp) {
      return {
        strategy: 'mcp-superassistant',
        model: 'mcp-coordinator',
        tools: ['ALL'],
        baseUrl: 'http://localhost:3006',
        estimatedLatency: '1-3s',
        reason: 'Multi-tool coordination requerida, MCP-SuperAssistant más apropiado',
      }
    }

    // ESTRATEGIA 1: Local Ollama (rápido, sin latencia red)
    // Ideal: Complejidad baja, herramientas simples
    if (
      complexity <= 3 &&
      requiredTools <= 2 &&
      resources.ollama
    ) {
      return {
        strategy: 'local-ollama',
        model: 'mistral',
        tools: ['FileRead', 'Bash', 'FileEdit'].slice(0, requiredTools + 1),
        baseUrl: 'http://localhost:11434/v1',
        estimatedLatency: 'sub-1s',
        reason: `Tarea simple (complexity ${complexity}), modelo local rápido`,
      }
    }

    // ESTRATEGIA 2: OpenRouter Free (intermedio, gratuito)
    // Ideal: Complejidad media, algunos tools
    if (
      complexity >= 4 &&
      complexity <= 6 &&
      requiredTools <= 3 &&
      resources.openrouter
    ) {
      return {
        strategy: 'openrouter-free',
        model: 'mistralai/mistral-7b-instruct:free',
        tools: ['FileRead', 'Bash', 'FileEdit', 'Grep'].slice(0, requiredTools + 2),
        baseUrl: 'https://openrouter.io/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        estimatedLatency: '3-5s',
        reason: `Complejidad moderada (${complexity}), OpenRouter gratuito disponible`,
      }
    }

    // ESTRATEGIA 4: Fallback a Anthropic API remota
    // Ideal: Cuando nada más disponible
    if (resources.anthropic) {
      return {
        strategy: 'anthropic-fallback',
        model: 'claude-opus',
        tools: ['ALL'],
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: process.env.ANTHROPIC_API_KEY,
        estimatedLatency: '3-5s',
        reason: 'Fallback: Anthropic API con acceso a todas las herramientas',
      }
    }

    // ESTRATEGIA 5: Si nada disponible, error
    throw new Error(
      'No providers available. Set up: Ollama, OPENROUTER_API_KEY, or ANTHROPIC_API_KEY'
    )
  }
}
