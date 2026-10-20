# AI Consensus Engine (`ai-consensus-engine`)

Motor de consenso multi-agente para **openMCPWEBLOCK**.

Permite que múltiples instancias de IAs web (ChatGPT, Gemini, Grok) ejecuten tareas en paralelo a través de Chrome CDP / Web Relay / SuperAssistant, evalúa sus respuestas, extrae puntos clave, detecta divergencias y sintetiza una respuesta consensuada con métricas de confianza.

---

## 🏗️ Estructura

```
ai-consensus-engine/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                      # Punto de entrada principal
│   ├── types/
│   │   └── index.ts                  # Interfaces, tipos y contratos
│   ├── orchestrator/
│   │   ├── TaskOrchestrator.ts       # Orquestador central de tareas
│   │   ├── AgentPool.ts              # Pool y gestión de adaptadores de agentes
│   │   └── ResponseCollector.ts      # Recopilación y detección de completitud
│   ├── consensus/
│   │   ├── ConsensusEngine.ts        # Motor de evaluación y síntesis de consenso
│   │   ├── SimilarityAnalyzer.ts     # Matriz de similitud léxica y semántica
│   │   ├── KeyPointExtractor.ts      # Extracción y clustering de puntos clave
│   │   └── ConfidenceCalculator.ts   # Cálculo de confianza normalizada (0.3 - 1.0)
│   ├── memory/
│   │   ├── SharedMemoryStore.ts      # Store en memoria de contexto compartido (claude-mem compatible)
│   │   └── SessionManager.ts         # Gestión del ciclo de vida de sesiones
│   ├── adapters/
│   │   ├── ChatGPTAdapter.ts         # Adaptador para ChatGPT Web
│   │   ├── GeminiAdapter.ts          # Adaptador para Gemini Web
│   │   └── GrokAdapter.ts            # Adaptador para Grok Web
│   └── utils/
│       ├── DOMAutomation.ts          # Utilidades para interacción DOM y sanitización
│       └── TextComparison.ts         # Métricas Jaccard y Levenshtein
└── tests/
    └── scaffold.test.ts              # Suite de pruebas unitarias del scaffold
```

---

## 🚀 Uso Rápido

```typescript
import {
  TaskOrchestrator,
  type AgentConfig,
} from './src/index.js';

const orchestrator = new TaskOrchestrator();

const agents: AgentConfig[] = [
  { id: 'agent-chatgpt', platform: 'chatgpt', role: 'Investigador técnico' },
  { id: 'agent-gemini', platform: 'gemini', role: 'Escritor y síntesis' },
  { id: 'agent-grok', platform: 'grok', role: 'Validador crítico' },
];

const result = await orchestrator.runConsensusTask(
  'session-001',
  '¿Cuáles son las prioridades arquitectónicas de TypeScript en 2026?',
  agents,
  { keyFacts: ['Usar ESM nativo'] }
);

console.log('Consenso:', result.consensus);
console.log('Confianza:', result.confidence);
console.log('Divergencias:', result.divergences);
```

---

## 🧪 Pruebas

```bash
bun test ai-consensus-engine/tests/scaffold.test.ts
```
