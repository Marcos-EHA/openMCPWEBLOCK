// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider } from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

export function getSmallFastModel(): ModelName {
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) return process.env.ANTHROPIC_SMALL_FAST_MODEL
  // For Gemini provider, use a fast model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  // For OpenAI provider, use OPENAI_MODEL or a sensible default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  return getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    // Read the model env var that matches the active provider to prevent
    // cross-provider leaks (e.g. ANTHROPIC_MODEL sent to the OpenAI API).
    const provider = getAPIProvider()
    specifiedModel =
      (provider === 'gemini' ? process.env.GEMINI_MODEL : undefined) ||
      (provider === 'openai' || provider === 'gemini' || provider === 'github'
        ? process.env.OPENAI_MODEL
        : undefined) ||
      (provider === 'firstParty' ? process.env.ANTHROPIC_MODEL : undefined) ||
      settings.model ||
      undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
const strategyPath = path.resolve(process.cwd(), '..', 'learning-system/modelo-strategy.json');

// Types for model strategy
interface ModelStrategy {
  estrategia_global: string;
  modelos_disponibles: Record<string, {
    mejor_para: string[];
    latencia: string;
    exactitud: string;
    estado_instalacion?: string;
  }>;
  fallback_strategy: string;
}

interface TaskClassification {
  type: 'conversacion' | 'codigo' | 'analisis' | 'busqueda' | 'debugging' | 'documentacion';
  confidence: number;
  keywords: string[];
}

// Load model strategy from learning-system
function loadModelStrategy(): ModelStrategy | null {
  try {
    if (!existsSync(strategyPath)) {
      console.warn(`Model strategy file not found: ${strategyPath}`);
      return null;
    }
    const content = readFileSync(strategyPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error loading model strategy: ${error}`);
    return null;
  }
}

// Classify user input to determine optimal model
function classifyTask(userInput: string): TaskClassification {
  const input = userInput.toLowerCase();

  // Code-related keywords
  const codeKeywords = [
    'código', 'función', 'script', 'python', 'javascript', 'typescript',
    'java', 'c++', 'php', 'ruby', 'go', 'rust', 'sql', 'html', 'css',
    'api', 'endpoint', 'database', 'query', 'algoritmo', 'clase',
    'método', 'variable', 'constante', 'import', 'export', 'async',
    'await', 'promise', 'callback', 'framework', 'librería', 'paquete',
    'dependencia', 'build', 'compile', 'debug', 'error', 'exception',
    'stack trace', 'syntax', 'parsing', 'token', 'lexer', 'parser'
  ];

  // Analysis/Reasoning keywords
  const analysisKeywords = [
    'analizar', 'explicar', 'razonar', 'comparar', 'evaluar', 'resumir',
    'interpretar', 'concluir', 'argumentar', 'evidencia', 'prueba',
    'hipótesis', 'teoría', 'concepto', 'paradigma', 'arquitectura',
    'diseño', 'patrón', 'estrategia', 'metodología', 'enfoque',
    'perspectiva', 'visión', 'análisis', 'diagnóstico', 'auditoría'
  ];

  // Search/Documentation keywords
  const searchKeywords = [
    'buscar', 'encontrar', 'localizar', 'investigar', 'documentación',
    'manual', 'guía', 'tutorial', 'referencia', 'documento', 'archivo',
    'leer', 'revisar', 'consultar', 'verificar', 'confirmar', 'validar'
  ];

  // Debugging keywords
  const debugKeywords = [
    'debug', 'depurar', 'error', 'bug', 'problema', 'issue', 'fix',
    'solucionar', 'corregir', 'arreglar', 'reparar', 'troubleshoot',
    'diagnosticar', 'investigar', 'trace', 'log', 'exception', 'crash'
  ];

  // Documentation keywords
  const docKeywords = [
    'documentar', 'documentación', 'readme', 'md', 'markdown', 'wiki',
    'comentario', 'docstring', 'javadoc', 'comentarios', 'explicar',
    'describir', 'detallar', 'especificar', 'definir'
  ];

  // Count matches for each category
  const codeMatches = codeKeywords.filter(k => input.includes(k)).length;
  const analysisMatches = analysisKeywords.filter(k => input.includes(k)).length;
  const searchMatches = searchKeywords.filter(k => input.includes(k)).length;
  const debugMatches = debugKeywords.filter(k => input.includes(k)).length;
  const docMatches = docKeywords.filter(k => input.includes(k)).length;

  // Determine primary task type
  const scores = [
    { type: 'codigo' as const, score: codeMatches },
    { type: 'analisis' as const, score: analysisMatches },
    { type: 'busqueda' as const, score: searchMatches },
    { type: 'debugging' as const, score: debugMatches },
    { type: 'documentacion' as const, score: docMatches }
  ];

  const maxScore = Math.max(...scores.map(s => s.score));
  const bestMatch = scores.find(s => s.score === maxScore);

  // If no significant matches, default to conversation
  if (maxScore === 0) {
    return {
      type: 'conversacion',
      confidence: 0.5,
      keywords: []
    };
  }

  // Calculate confidence based on match ratio
  const totalMatches = codeMatches + analysisMatches + searchMatches + debugMatches + docMatches;
  const confidence = totalMatches > 0 ? maxScore / totalMatches : 0;

  return {
    type: bestMatch?.type || 'conversacion',
    confidence: Math.min(confidence, 1.0),
    keywords: [
      ...codeKeywords.filter(k => input.includes(k)),
      ...analysisKeywords.filter(k => input.includes(k)),
      ...searchKeywords.filter(k => input.includes(k)),
      ...debugKeywords.filter(k => input.includes(k)),
      ...docKeywords.filter(k => input.includes(k))
    ].slice(0, 5) // Limit to top 5 keywords
  };
}

// Get optimal model based on task classification
function getOptimalModel(userQuery: string): string {
  const strategy = loadModelStrategy();
  if (!strategy) {
    // Fallback to default model selection
    return getBestModel();
  }

  const classification = classifyTask(userQuery);

  // Map task types to available models
  const taskToModelMap: Record<string, string[]> = {
    'codigo': ['codellama:7b-code', 'codellama', 'codegemma', 'codestral'],
    'debugging': ['codellama:7b-code', 'codellama', 'deepseek-coder'],
    'analisis': ['mistral', 'qwen2.5', 'llama2:13b', 'neural-chat'],
    'busqueda': ['mistral', 'qwen2.5', 'neural-chat'],
    'documentacion': ['neural-chat', 'mistral', 'qwen2.5'],
    'conversacion': ['neural-chat', 'mistral', 'qwen2.5']
  };

  const candidateModels = taskToModelMap[classification.type] || [strategy.fallback_strategy];

  // Find the first available model from candidates
  for (const modelName of candidateModels) {
    if (strategy.modelos_disponibles[modelName] &&
        strategy.modelos_disponibles[modelName].estado_instalacion === 'instalado') {
      return modelName;
    }
  }

  // Fallback to default strategy
  return strategy.fallback_strategy;
}

// Log model decision to learning system
function logModelDecision(query: string, selectedModel: string, classification: TaskClassification, latency?: number) {
  try {
    const decisionsPath = path.resolve(process.cwd(), '..', 'learning-system/decisiones_log.jsonl');

    const decisionEntry = {
      timestamp: new Date().toISOString(),
      query: query.substring(0, 200), // Truncate long queries
      modelo_seleccionado: selectedModel,
      razon_seleccion: classification.type,
      confianza_clasificacion: classification.confidence,
      palabras_clave: classification.keywords,
      latencia_ms: latency || null,
      estrategia: 'seleccionar_por_tarea_automaticamente',
      fuente: 'openclaude_model_switching'
    };

    // Append to decisions log
    const fs = require('fs');
    fs.appendFileSync(decisionsPath, JSON.stringify(decisionEntry) + '\n');
  } catch (error) {
    console.warn(`Failed to log model decision: ${error}`);
  }
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// Get best model for a specific query using automatic switching
export function getBestModelForQuery(userQuery: string): ModelName {
  // Check if automatic switching is enabled
  const enableAutoSwitch = process.env.OPENCLAUDE_AUTO_MODEL_SWITCH === 'true' ||
                          process.env.CLAUDE_CODE_AUTO_SWITCH === 'true';

  if (!enableAutoSwitch) {
    return getBestModel();
  }

  const optimalModel = getOptimalModel(userQuery);

  // Log the decision
  const classification = classifyTask(userQuery);
  logModelDecision(userQuery, optimalModel, classification);

  // For Ollama models, return as-is since they're handled via OpenAI compatibility
  if (optimalModel.includes(':') || optimalModel.includes('llama') || optimalModel.includes('mistral')) {
    // Set environment variable for Ollama model selection
    process.env.OPENAI_MODEL = optimalModel;
    return optimalModel as ModelName;
  }

  // For other providers, map to appropriate model names
  return optimalModel as ModelName;
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.5-pro-preview-03-25'
  }
  // OpenAI provider: use user-specified model or default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Codex provider: use user-specified model or default to gpt-5.4
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.4'
  }
  // 3P providers (Bedrock, Vertex, Foundry) — kept as a separate branch
  // even when values match, since 3P availability lags firstParty and
  // these will diverge again at the next model launch.
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus46
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  }
  // OpenAI provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Codex provider
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.4'
  }
  // Default to Sonnet 4.5 for 3P since they may not have 4.6 yet
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  // OpenAI provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  // Codex provider
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.4'
  }

  // Haiku 4.5 is available on all platforms (first-party, Foundry, Bedrock, Vertex)
  return getModelStrings().haiku45
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // sonnetplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 4.6 for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Gemini provider: always use the configured Gemini model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash'
  }
  // OpenAI provider: always use the configured OpenAI model
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // GitHub provider: always use the configured GitHub model
  if (getAPIProvider() === 'github') {
    return process.env.OPENAI_MODEL || 'github:copilot'
  }
  // Codex provider: always use the configured Codex model (default gpt-5.4)
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.4'
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-5 before 4)
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.6 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.6 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.6 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  // Handle Codex models - show actual model name + resolved model
  if (setting === 'codexplan') {
    return 'codexplan (gpt-5.4)'
  }
  if (setting === 'codexspark') {
    return 'codexspark (gpt-5.3-codex-spark)'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  // For OpenAI/Gemini/Codex providers, show the actual model name not a Claude alias
  if (getAPIProvider() === 'openai' || getAPIProvider() === 'gemini' || getAPIProvider() === 'codex') {
    return null
  }
  switch (model) {
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.3-codex-spark':
      return 'GPT-5.3 Codex Spark'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Claude {ModelName}" for public models, or "Claude ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '') // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        return getBestModel()
      default:
    }
  }

  // Handle Codex aliases - map to actual model names
  if (modelString === 'codexplan') {
    return 'gpt-5.4'
  }
  if (modelString === 'codexspark') {
    return 'gpt-5.3-codex-spark'
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs)
  // Only strip [1m] suffix if present, maintaining case of the base model
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
