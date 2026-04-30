# Arquitectura Multi-Agente con Consenso IA

**Última actualización**: 28 de Abril, 2026  
**Fase**: 🏗️ Diseño (implementación en Fase 2)

---

## 🎯 Visión General

Tu "agencia propia" es un sistema donde **múltiples IAs web ejecutan la misma tarea en paralelo**, sus respuestas se evalúan, comparan y se produce una **respuesta consensuada** que combina lo mejor de cada una.

```
┌─────────────────────────────────────────────────────────────┐
│                    ORQUESTADOR CENTRAL                      │
│                   (OpenClaude en tu PC)                     │
└─────────────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
   ┌─────────┐          ┌─────────┐          ┌─────────┐
   │ ChatGPT │          │ Gemini  │          │  Grok   │
   │ (Web)   │          │ (Web)   │          │ (Web)   │
   └─────────┘          └─────────┘          └─────────┘
        ↓                    ↓                    ↓
   ┌─────────────────────────────────────────────────┐
   │  SuperAssistant Extension (3 instancias)       │
   │  + MCP Tools (filesystem, memory, etc.)        │
   └─────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
   ┌──────────────────────────────────────────────────┐
   │      Proxy Local (superassistant-proxy)         │
   │      + Claude Memory (contexto compartido)      │
   └──────────────────────────────────────────────────┘
        ↑                    ↑                    ↑
   ┌────────────────────────────────────────────────────┐
   │  Respuesta 1           Respuesta 2        Respuesta 3
   └────────────────────────────────────────────────────┘
        ↓                    ↓                    ↓
   ┌──────────────────────────────────────────────────┐
   │     Comparador/Evaluador (Consensus Engine)     │
   │  - Extrae datos clave                            │
   │  - Valida coincidencias                          │
   │  - Calcula confianza                             │
   │  - Genera respuesta consensuada                  │
   └──────────────────────────────────────────────────┘
        ↓
   ┌──────────────────────────────────────────────────┐
   │      RESPUESTA FINAL AL USUARIO                  │
   │  - Consenso de la mayoría                        │
   │  - Puntos de divergencia (si existen)            │
   │  - Confianza total                               │
   │  - Trazabilidad (quién dijo qué)                 │
   └──────────────────────────────────────────────────┘
```

---

## 🏗️ Componentes de la Arquitectura

### 1. Orquestador Central (`AI Consensus Orchestrator`)

**Responsabilidad**: Coordinar todas las instancias y recopilar respuestas.

```typescript
// Pseudo-código
interface ConsensusOrchestrator {
  // Divide una tarea
  delegateTask(task: string, agents: AgentConfig[]): Promise<void>
  
  // Espera respuestas de todos los agentes
  collectResponses(): Promise<AgentResponse[]>
  
  // Detecta cuando una respuesta es completa
  isResponseComplete(response: string): boolean
  
  // Genera consenso
  generateConsensus(responses: AgentResponse[]): ConsensuResult
}
```

### 2. Agentes Web (Instancias de SuperAssistant)

Cada agente es una **sesión independiente** en una plataforma web:

```
Agente 1:
- Plataforma: ChatGPT (gpt-4)
- Ventana: navegador 1
- Rol: "Investigador técnico"

Agente 2:
- Plataforma: Gemini (Pro)
- Ventana: navegador 2
- Rol: "Escritor/resumen"

Agente 3:
- Plataforma: Grok (Beta)
- Ventana: navegador 3
- Rol: "Contrarian/validador"
```

### 3. Motor de Consenso (`Consensus Engine`)

Evalúa y compara respuestas:

```typescript
interface ConsensusEngine {
  // Compara respuestas
  compareResponses(r1: string, r2: string): SimilarityScore
  
  // Extrae puntos clave de cada respuesta
  extractKeyPoints(response: string): KeyPoint[]
  
  // Calcula "confianza" basada en convergencia
  calculateConfidence(responses: string[]): number  // 0-1
  
  // Genera versión consensuada
  mergeResponses(responses: string[]): string
  
  // Marca divergencias importantes
  identifyDivergences(responses: string[]): Divergence[]
}
```

### 4. Sistema de Memoria Compartida

Todos los agentes acceden al mismo `claude-mem`:

```json
{
  "session_id": "uuid",
  "task": "...",
  "shared_context": {
    "key_facts": [...],
    "assumptions": [...],
    "previous_decisions": [...]
  },
  "agent_responses": {
    "chatgpt": { "response": "...", "confidence": 0.95 },
    "gemini": { "response": "...", "confidence": 0.92 },
    "grok": { "response": "...", "confidence": 0.88 }
  },
  "consensus": "..."
}
```

---

## 🔄 Flujo de Ejecución

### Fase 1: Preparación

```
Usuario: "Dame un análisis profundo de tendencias en IA 2026"
   ↓
Orquestador:
  1. Divide la tarea en subtareas (si es necesario)
  2. Inyecta contexto en claude-mem
  3. Configura instrucciones personalizadas por agente
  4. Abre 3 navegadores (o pestaña) con SuperAssistant
```

### Fase 2: Ejecución Paralela

```
Agent 1 (ChatGPT):
  → Recibe tarea
  → Consulta claude-mem (contexto compartido)
  → Genera respuesta técnica completa
  → Guarda en claude-mem

Agent 2 (Gemini):
  → Recibe tarea (misma que Agent 1)
  → Consulta claude-mem
  → Genera respuesta desde otra perspectiva
  → Guarda en claude-mem

Agent 3 (Grok):
  → Recibe tarea
  → Consulta claude-mem
  → Genera respuesta crítica/validadora
  → Guarda en claude-mem

[TODO ESTO EN PARALELO]
```

### Fase 3: Recopilación

```
Orquestador:
  1. Detecta que todos los agentes terminaron
  2. Extrae respuestas de claude-mem
  3. Las envía al Consensus Engine
```

### Fase 4: Consenso

```
Consensus Engine:
  1. Compara las 3 respuestas
  2. Extrae puntos clave comunes
  3. Identifica divergencias
  4. Calcula confianza global (0-1)
  5. Genera versión consensuada
  
  Ejemplo output:
  {
    "consensus": "En 2026, las tendencias principales son A, B, C",
    "confidence": 0.93,
    "agreement": {
      "A": "3/3 de acuerdo",
      "B": "2/3 de acuerdo",
      "C": "3/3 de acuerdo"
    },
    "divergences": [
      {
        "topic": "Relevancia de X",
        "chatgpt": "Muy importante",
        "gemini": "Moderada",
        "grok": "Sobreestimada"
      }
    ],
    "traceability": {
      "chatgpt": "link a respuesta original",
      "gemini": "link a respuesta original",
      "grok": "link a respuesta original"
    }
  }
```

### Fase 5: Presentación

```
Usuario recibe:

═══ CONSENSO (Confianza: 93%) ═══
[Respuesta consensuada]

═══ PUNTOS DE ACUERDO ═══
✓ ChatGPT, Gemini, Grok coinciden en: ...

═══ DIVERGENCIAS IMPORTANTES ═══
! Sobre el tema X:
  - ChatGPT: punto de vista A
  - Gemini: punto de vista B
  - Grok: punto de vista C

═══ TRAZABILIDAD ═══
[Links a respuestas originales]
```

---

## 🛠️ Tecnologías Necesarias

### Proyecto Nuevo: `AI-Consensus-Engine`

```
ai-consensus-engine/
├── src/
│   ├── orchestrator/
│   │   ├── TaskOrchestrator.ts
│   │   ├── AgentPool.ts
│   │   └── ResponseCollector.ts
│   ├── consensus/
│   │   ├── ConsensusEngine.ts
│   │   ├── SimilarityAnalyzer.ts
│   │   ├── KeyPointExtractor.ts
│   │   └── ConfianceCalculator.ts
│   ├── memory/
│   │   ├── SharedMemoryStore.ts
│   │   └── SessionManager.ts
│   ├── adapters/
│   │   ├── ChatGPTAdapter.ts
│   │   ├── GeminiAdapter.ts
│   │   └── GrokAdapter.ts
│   └── utils/
│       ├── DOMAutomation.ts
│       └── TextComparison.ts
└── tests/
```

### Stack Técnico

```
Frontend Orchestration:
- Puppeteer o Playwright (control de navegadores)
- Headless browsers (Chrome, Firefox)

Consensus Processing:
- Transformers.js (NLP local, sin API externa)
- TF.js (tensor operations para similitud)
- Cosine similarity, jaccard, edit distance

Memory:
- Claude-mem (ya integrado)
- Redis (opcional, para sesiones distribuidas)

API/Backend:
- Express/Fastify (backend del orquestador)
- WebSocket (comunicación en tiempo real con agentes)

Data:
- JSON/JSONL (respuestas)
- SQLite (historial de consensos)
```

---

## 🎯 Casos de Uso

### Caso 1: Análisis de Tendencias

```
Tarea: "¿Cuáles serán los lenguajes de programación más usados en 2026?"

ChatGPT responde: "TypeScript, Python, Rust, Go, Zig"
Gemini responde: "Python, TypeScript, Java, C++, Kotlin"
Grok responde: "Rust, Go, TypeScript, Python, C"

Consenso: "Python, TypeScript y Rust lideran"
Confianza: 92%

Divergencia: 
  - ChatGPT incluye "Zig" (nueva)
  - Grok no menciona "Java" (legacy)
  - Gemini predice crecimiento de "Kotlin"
```

### Caso 2: Validación de Código

```
Tarea: "Revisa este código TypeScript y dame feedback"
[código adjunto]

ChatGPT: "Buena estructura, considera usar types más estrictos"
Gemini: "Performance OK, pero cuidado con memoria en arrays"
Grok: "Security: falta sanitización en inputs"

Consenso: "Código funciona, pero mejorar types, memory y security"
Prioridad según divergencia: 
  1. Security (crítico) - solo Grok lo mencionó
  2. Types (importante) - ChatGPT lo marcó
  3. Memory (importante) - Gemini lo identificó
```

### Caso 3: Toma de Decisiones Empresarial

```
Tarea: "¿Debería migrar mi infraestructura a Kubernetes?"

ChatGPT: "Sí, ofrece escalabilidad y cost optimization"
Gemini: "Depende de tu tamaño, para startups es overkill"
Grok: "Observación: la mayoría migra pero 40% se arrepiente"

Consenso: "Migra si ya tienes 5+ microservicios y equipo DevOps"
Confianza: 87% (hay divergencia significativa)

La divergencia es VALIOSA - muestra un análisis costo-beneficio real.
```

---

## 🔐 Consideraciones de Seguridad

### Datos Sensibles

```typescript
// Redacta datos sensibles antes de enviar a agentes web
interface DataRedaction {
  apiKeys: "redact",
  passwords: "redact",
  personalInfo: "anonymize",
  internalHostnames: "mask"
}

// claude-mem guarda versión redactada en sesión web
// versión completa solo local
```

### Anti-Detección

```
- Usar navegadores reales (Puppeteer + Chrome/Firefox)
- No simular "bots" - son navegadores legítimos
- Respetar rate limits de plataformas
- Usar diferentes User-Agents
- Espaciar requests
```

### Límites de Recursos

```
- Máximo 3 agentes simultáneamente (para no saturar)
- Timeout por agente: 5 minutos
- Memory límite: 100MB por sesión
- Histórico: guardar solo últimas 10 sesiones
```

---

## 📊 Métricas de Consenso

### Confianza (0-1)

```
Cálculo:
- Si 3/3 coinciden en punto A: +0.5
- Si 2/3 coinciden: +0.25
- Si 1/3: +0.05
- Suma normalizada a 0-1

Min: 0.3 (muy divergentes)
Max: 1.0 (consenso perfecto)
Típico: 0.8-0.95
```

### Divergencia (0-1)

```
Opuesto a confianza.
- Alto = muchas opiniones diferentes (valioso para decisiones complejas)
- Bajo = todos piensan igual (puede indicar parcialidad)
```

### Velocidad

```
Métrica: Tiempo de consenso
- Ideal: < 2 minutos (todas las respuestas)
- Aceptable: 2-5 minutos
- Timeout: > 5 minutos
```

---

## 🚀 Roadmap de Implementación

### Fase 1: MVP (Semana 1-2)
- [ ] TaskOrchestrator básico
- [ ] Control de navegadores (Puppeteer)
- [ ] Integración con claude-mem
- [ ] Parser simple de respuestas

### Fase 2: Consensus Engine (Semana 3-4)
- [ ] Similarity analysis (cosine similarity)
- [ ] Key point extraction (NLP básico)
- [ ] Confidence calculation
- [ ] Divergence detection

### Fase 3: UI/UX (Semana 5-6)
- [ ] Dashboard de sesiones
- [ ] Visualización de consenso
- [ ] Tabla de divergencias
- [ ] Histórico

### Fase 4: Optimizaciones (Semana 7+)
- [ ] Caché de respuestas
- [ ] Compresión de datos
- [ ] Análisis de tendencias de consenso
- [ ] ML para predicción de confianza

---

## 🎯 Próximos Pasos Inmediatos

Para comenzar en tu repo `openMCPWEBLOCK`:

1. **Crear carpeta `ai-consensus-engine/`** en la raíz
2. **Inicializar proyecto TypeScript/Bun** con Puppeteer
3. **Integrar con claude-mem** existente
4. **Prototipar TaskOrchestrator** básico
5. **Documentar API** de consenso

¿Quieres que comience a implementar el MVP?

---

## 📖 Referencias

- SuperAssistant: `PROJECT_CONTEXT_ SUPERASISTANT.md`
- Mode Controller: `MODE_CONTROLLER_DESIGN.md`
- Web Relay: `GUIA_WEB_RELAY_MODE_PRACTICA.md`
- Consensus Algorithms: Papers en `/research/` (opcional)
