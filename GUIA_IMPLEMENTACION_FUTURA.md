# GUÍA DE IMPLEMENTACIÓN FUTURA - Mode Controller Expansiones

## 🎯 Objetivos de Expansión

Este documento proporciona ejemplos de código y patrones para expandir el Mode Controller hacia funcionalidades más sofisticadas.

## Fase 2: Mejora UX

### 2.1 Status Command

**Archivo: `src/commands/mcp/mcp.tsx`**

```typescript
function MCPStatus({ onComplete }: { onComplete: (message: string) => void }) {
  const didRun = useRef(false);
  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    
    const config = getCurrentProjectConfig();
    const mode = config.mcpExecutionMode || 'api';
    const message = `Current MCP execution mode: ${mode}
    
Available modes:
  • api   - Only built-in tools
  • web   - MCP proxy tools (web relay)
  • auto  - All available tools

Usage: /mcp set-mode [api|web|auto]`;
    
    onComplete(message);
  }, [onComplete]);
  return null;
}

// En la función call():
if (parts[0] === 'status') {
  return <MCPStatus onComplete={onDone} />;
}
```

### 2.2 Mode Indicator en UI

**Archivo: `src/components/MCPModeIndicator.tsx` (nuevo)**

```typescript
import React from 'react';
import { useAppState } from '../state/AppState';
import { getCurrentProjectConfig } from '../utils/config';

export function MCPModeIndicator() {
  const config = getCurrentProjectConfig();
  const mode = config.mcpExecutionMode || 'api';
  
  const modeColor = {
    'api': 'blue',
    'web': 'yellow',
    'auto': 'green'
  }[mode];
  
  const modeDescription = {
    'api': 'API Mode (Built-in only)',
    'web': 'Web Relay Mode',
    'auto': 'Auto Mode (All tools)'
  }[mode];
  
  return (
    <div className={`mcp-indicator mcp-${mode}`} title={modeDescription}>
      <span className={`badge badge-${modeColor}`}>{mode.toUpperCase()}</span>
    </div>
  );
}
```

## Fase 3: Expansión de Servidores

### 3.1 Integración de Claude Mem

**Archivo: `superassistant-proxy.config.json` (actualizado)**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "C:\\Users\\apoca\\openMCPWEBLOCK"
      ]
    },
    "claude-mem": {
      "command": "npx",
      "args": [
        "-y",
        "claude-mem",
        "start"
      ],
      "env": {
        "CLAUDE_MEM_DB_PATH": "./.claude/memory"
      }
    }
  }
}
```

### 3.2 Selector de Interfaz Web

**Archivo: `src/commands/mcp/mcp.tsx` (expandido)**

```typescript
interface WebInterface {
  name: string;
  url: string;
  capabilities: string[]
  customInstructions?: string
}

function MCPSelectInterface({ onComplete }: { onComplete: (message: string) => void }) {
  const didRun = useRef(false);
  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    
    const config = getCurrentProjectConfig();
    const availableInterfaces: WebInterface[] = [
      {
        name: 'claude-web',
        url: 'https://claude.ai',
        capabilities: ['chat', 'code-gen', 'analysis']
      },
      {
        name: 'chatgpt-web',
        url: 'https://chat.openai.com',
        capabilities: ['chat', 'code-gen', 'plugins']
      },
      {
        name: 'gemini-web',
        url: 'https://gemini.google.com',
        capabilities: ['chat', 'multimodal', 'search']
      }
    ];
    
    const message = `Available Web Interfaces:\n${
      availableInterfaces.map((i, idx) => 
        `${idx + 1}. ${i.name} - ${i.url}\n   Capabilities: ${i.capabilities.join(', ')}`
      ).join('\n')
    }`;
    
    onComplete(message);
  }, [onComplete]);
  return null;
}

// Agregar a tipos de config
export type ProjectConfig = {
  // ... campos existentes ...
  selectedWebInterface?: 'claude-web' | 'chatgpt-web' | 'gemini-web'
}
```

## Fase 4: Inteligencia de Routing

### 4.1 Detección de Tipo de Tarea

**Archivo: `src/utils/mcp/taskDetector.ts` (nuevo)**

```typescript
export type TaskType = 'coding' | 'analysis' | 'web-automation' | 'general'

export function detectTaskType(userMessage: string): TaskType {
  const message = userMessage.toLowerCase();
  
  // Patrones para web automation
  if (/automate|scrape|click|fill.*form|submit|navigate/.test(message)) {
    return 'web-automation';
  }
  
  // Patrones para coding
  if (/code|implement|function|class|refactor|debug/.test(message)) {
    return 'coding';
  }
  
  // Patrones para analysis
  if (/analyze|explain|summarize|compare|data/.test(message)) {
    return 'analysis';
  }
  
  return 'general';
}

export function getRecommendedMode(taskType: TaskType): 'api' | 'web' | 'auto' {
  switch (taskType) {
    case 'web-automation':
      return 'web';  // Necesita herramientas web
    case 'coding':
      return 'api';  // API es más rápido
    case 'analysis':
      return 'auto'; // Flexibilidad
    default:
      return 'api';  // Default conservador
  }
}
```

### 4.2 Auto-Routing Inteligente

**Archivo: `src/services/mcp/autoRouter.ts` (nuevo)**

```typescript
import { detectTaskType, getRecommendedMode } from '../../utils/mcp/taskDetector';
import { getCurrentProjectConfig, updateCurrentProjectConfig } from '../../utils/config';

export async function autoSelectMode(userMessage: string): Promise<void> {
  const taskType = detectTaskType(userMessage);
  const recommendedMode = getRecommendedMode(taskType);
  
  const config = getCurrentProjectConfig();
  const currentMode = config.mcpExecutionMode || 'api';
  
  // Si el modo recomendado es diferente y se sugiere automático
  if (recommendedMode !== currentMode) {
    console.log(`[MCP AutoRouter] Task type: ${taskType} → Mode: ${recommendedMode}`);
    
    // Opcional: cambiar automáticamente si está habilitado
    if (config.enableAutoModeDetection) {
      updateCurrentProjectConfig({
        ...config,
        mcpExecutionMode: recommendedMode
      });
    }
  }
}
```

### 4.3 Fallback Inteligente

**Archivo: `src/services/mcp/fallbackHandler.ts` (nuevo)**

```typescript
export interface ExecutionAttempt {
  mode: 'api' | 'web' | 'auto'
  toolName: string
  startTime: number
  endTime?: number
  success?: boolean
  error?: string
}

export class ModeFailoverHandler {
  private attempts: ExecutionAttempt[] = [];
  private readonly maxRetries = 3;
  private readonly timeout = 30000; // 30s
  
  async executeWithFallback(
    toolName: string,
    executor: (mode: 'api' | 'web') => Promise<unknown>
  ): Promise<unknown> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < this.maxRetries; i++) {
      const modes: ('api' | 'web')[] = i === 0 
        ? ['web', 'api']  // Intenta web primero
        : ['api'];         // Solo API si web falla
      
      for (const mode of modes) {
        try {
          const attempt: ExecutionAttempt = {
            mode,
            toolName,
            startTime: Date.now()
          };
          
          const result = await Promise.race([
            executor(mode),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), this.timeout)
            )
          ]);
          
          attempt.success = true;
          attempt.endTime = Date.now();
          this.attempts.push(attempt);
          
          return result;
        } catch (error) {
          lastError = error as Error;
          console.log(`[Fallover] ${toolName} en modo ${mode} falló: ${lastError.message}`);
        }
      }
    }
    
    throw new Error(
      `All execution attempts failed for ${toolName}. Last error: ${lastError?.message}`
    );
  }
  
  getAttemptStats() {
    const successful = this.attempts.filter(a => a.success).length;
    const avgTime = this.attempts.reduce((sum, a) => sum + (a.endTime || 0 - a.startTime), 0) / this.attempts.length;
    
    return { successful, total: this.attempts.length, avgTime };
  }
}
```

## Fase 5: Gobernanza Completa

### 5.1 Compliance Gate

**Archivo: `src/services/mcp/complianceGate.ts` (nuevo)**

```typescript
export interface CompliancePolicy {
  maxWebRelayCallsPerHour: number
  allowedWebDomains: string[]
  requireApprovalForWebMode: boolean
  maxCostPerSession: number
  auditLogging: boolean
}

export class ComplianceGate {
  private policy: CompliancePolicy;
  private webCallHistory: { timestamp: number; domain: string }[] = [];
  
  constructor(policy: CompliancePolicy) {
    this.policy = policy;
  }
  
  async checkBeforeWebRelay(domain: string): Promise<{ allowed: boolean; reason?: string }> {
    // Verificar dominio permitido
    if (!this.policy.allowedWebDomains.includes(domain)) {
      return { allowed: false, reason: `Domain ${domain} not in whitelist` };
    }
    
    // Verificar límite de llamadas por hora
    const oneHourAgo = Date.now() - 3600000;
    const recentCalls = this.webCallHistory.filter(c => c.timestamp > oneHourAgo);
    
    if (recentCalls.length >= this.policy.maxWebRelayCallsPerHour) {
      return { 
        allowed: false, 
        reason: `Exceeded max web relay calls per hour (${this.policy.maxWebRelayCallsPerHour})`
      };
    }
    
    // Verificar si requiere aprobación
    if (this.policy.requireApprovalForWebMode) {
      // Aquí ir a un gate de aprobación interactiva
      return { 
        allowed: false, 
        reason: 'Requires user approval to access web relay'
      };
    }
    
    return { allowed: true };
  }
  
  recordWebCall(domain: string) {
    this.webCallHistory.push({ timestamp: Date.now(), domain });
    
    if (this.policy.auditLogging) {
      console.log(`[Audit] Web relay call to ${domain} at ${new Date().toISOString()}`);
    }
  }
}
```

### 5.2 Métricas y Monitoreo

**Archivo: `src/services/mcp/metrics.ts` (nuevo)**

```typescript
export interface ModeMetrics {
  mode: 'api' | 'web' | 'auto'
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  avgLatency: number
  totalCost: number
  lastUpdated: number
}

export class ModeMetricsCollector {
  private metrics: Map<'api' | 'web' | 'auto', ModeMetrics> = new Map();
  
  recordCall(
    mode: 'api' | 'web' | 'auto',
    latency: number,
    success: boolean,
    cost: number
  ) {
    const current = this.metrics.get(mode) || {
      mode,
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      avgLatency: 0,
      totalCost: 0,
      lastUpdated: Date.now()
    };
    
    const newMetrics: ModeMetrics = {
      ...current,
      totalCalls: current.totalCalls + 1,
      successfulCalls: success ? current.successfulCalls + 1 : current.successfulCalls,
      failedCalls: success ? current.failedCalls : current.failedCalls + 1,
      avgLatency: (current.avgLatency * (current.totalCalls - 1) + latency) / current.totalCalls,
      totalCost: current.totalCost + cost,
      lastUpdated: Date.now()
    };
    
    this.metrics.set(mode, newMetrics);
  }
  
  getMetrics(): ModeMetrics[] {
    return Array.from(this.metrics.values());
  }
  
  getReport(): string {
    const allMetrics = this.getMetrics();
    return `MCP Mode Metrics Report:
${allMetrics.map(m => `
${m.mode.toUpperCase()} Mode:
  • Total Calls: ${m.totalCalls}
  • Success Rate: ${((m.successfulCalls / m.totalCalls) * 100).toFixed(2)}%
  • Avg Latency: ${m.avgLatency.toFixed(0)}ms
  • Total Cost: $${m.totalCost.toFixed(4)}
`).join('\n')}`;
  }
}
```

## Fase 6: Testing

### 6.1 Unit Tests para Mode Controller

**Archivo: `src/tools.test.ts` (nuevo)**

```typescript
import { assembleToolPool } from './tools';
import { getCurrentProjectConfig } from './utils/config';

jest.mock('./utils/config');

describe('Mode Controller - assembleToolPool', () => {
  const mockBuiltInTools = [
    { name: 'bash', type: 'built-in' },
    { name: 'read_file', type: 'built-in' }
  ];
  
  const mockMcpTools = [
    { 
      name: 'web_scrape', 
      mcpInfo: { serverName: 'superassistant-proxy', toolName: 'web_scrape' }
    },
    { 
      name: 'click_element', 
      mcpInfo: { serverName: 'superassistant-proxy', toolName: 'click_element' }
    }
  ];
  
  it('should exclude MCP tools in api mode', () => {
    (getCurrentProjectConfig as jest.Mock).mockReturnValue({
      mcpExecutionMode: 'api'
    });
    
    const tools = assembleToolPool({}, mockMcpTools);
    expect(tools).toHaveLength(2);
    expect(tools.every(t => !t.mcpInfo)).toBe(true);
  });
  
  it('should include only superassistant-proxy tools in web mode', () => {
    (getCurrentProjectConfig as jest.Mock).mockReturnValue({
      mcpExecutionMode: 'web'
    });
    
    const tools = assembleToolPool({}, mockMcpTools);
    expect(tools.some(t => t.name === 'web_scrape')).toBe(true);
    expect(tools.some(t => t.name === 'click_element')).toBe(true);
  });
  
  it('should include all tools in auto mode', () => {
    (getCurrentProjectConfig as jest.Mock).mockReturnValue({
      mcpExecutionMode: 'auto'
    });
    
    const tools = assembleToolPool({}, mockMcpTools);
    expect(tools.length).toBeGreaterThanOrEqual(4);
  });
});
```

## 📋 Checklist de Implementación

### Antes de Producción
- [ ] Validar todos los tests pasan
- [ ] Revisar cobertura de código (>80%)
- [ ] Documentar todos los cambios
- [ ] Revisar por security
- [ ] Performance benchmarking

### Rollout Gradual
- [ ] Fase 1: Internal testing (100% rollout a equipo interno)
- [ ] Fase 2: Beta (10% rollout a usuarios seleccionados)
- [ ] Fase 3: General release (100% rollout)

---

**Esta guía proporciona un roadmap claro para expandir el Mode Controller de manera segura y sostenible.**