# PROJECT_CONTEXT.md — MCP-SuperAssistant

> Archivo de contexto generado por análisis completo del código fuente (~228 archivos leídos, ~98% cobertura).
> Para cargar contexto en cualquier IA: "Lee PROJECT_CONTEXT.md y ayúdame con X"

---

## 1. ¿Qué es este proyecto?

**MCP-SuperAssistant** es una extensión de Chrome/Firefox que conecta el protocolo **MCP (Model Context Protocol de Anthropic)** con plataformas de IA web como ChatGPT, Gemini, Grok, Perplexity, DeepSeek y otras 10+ plataformas.

Permite que cualquier IA web pueda ejecutar herramientas MCP reales (filesystem, bases de datos, APIs, etc.) sin necesidad de acceso nativo, interceptando las respuestas de la IA en el DOM y ejecutando las tool calls a través de un proxy local.

**Repositorio:** `C:\Users\marco\git\MCP-SuperAssistant`
**Proxy requerido:** `npx @srbhptl39/mcp-superassistant-proxy`

---

## 2. Arquitectura General

```
Monorepo (Turbo + pnpm workspaces)
├── chrome-extension/          → Manifest V3, background service worker, cliente MCP
├── pages/
│   └── content/               → Content script principal inyectado en páginas web
│       └── src/
│           ├── core/          → Inicialización, circuit breaker, error handler, performance
│           ├── events/        → Event bus centralizado (EventEmitter patrón pub/sub)
│           ├── stores/        → Estado global con Zustand (6 stores)
│           ├── hooks/         → React hooks para stores, adapters, eventos
│           ├── plugins/       → Registry + Adapters por plataforma
│           ├── services/      → AutomationService (auto-execute, auto-submit)
│           ├── utils/         → DOM, storage, async, helpers, shadowDom
│           ├── types/         → Tipos TypeScript centralizados
│           ├── components/    → UI React (Sidebar, Settings, Tools, Instructions)
│           │   ├── sidebar/   → Sidebar principal con shadow DOM
│           │   ├── mcpPopover/→ Popover flotante con drag
│           │   └── ui/        → Primitivos UI (button, card, dialog)
│           └── render_prescript/ → Parser/Renderer de tool calls en streaming
│               ├── parser/    → XML (functionParser) + JSON (jsonFunctionParser)
│               ├── observer/  → MutationObserver, StreamObserver, StallHandler
│               ├── renderer/  → Renderiza bloques de tool calls en el DOM
│               └── utils/     → themeDetector, dom, performance
└── packages/                  → Librerías compartidas del monorepo
    ├── shared/                → Logger, HOCs (ErrorBoundary, Suspense), useStorage
    ├── storage/               → Chrome storage abstraction con liveUpdate
    ├── ui/                    → cn() utility (clsx + tailwind-merge), withUI
    ├── hmr/                   → Hot Module Replacement para desarrollo
    ├── i18n/                  → Internacionalización (56 idiomas soportados)
    ├── env/                   → Variables de entorno tipadas
    ├── vite-config/           → withPageConfig() base para todos los packages
    ├── module-manager/        → CLI para agregar/eliminar features del monorepo
    └── zipper/                → Empaquetador ZIP para distribución
```

---

## 3. Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Runtime | Node.js ≥22.12, pnpm 9.15, Turbo |
| Frontend | React 19, TypeScript 5.8 |
| Bundler | Vite + @vitejs/plugin-react-swc |
| Estilos | TailwindCSS + clsx + tailwind-merge |
| Estado | Zustand 5 |
| Extensión | Chrome Manifest V3 |
| Protocolo | MCP SDK (@modelcontextprotocol/sdk) |
| Remote Config | Firebase Remote Config REST API (deshabilitado por defecto) |
| Logs | Logger centralizado (@extension/shared/lib/logger) |

---

## 4. Flujo Principal (End-to-End)

```
1. Usuario abre ChatGPT (u otra plataforma soportada)
2. La extensión inyecta content/index.ts en la página
3. main-initializer.ts inicializa: stores → plugins → sidebar → automation
4. El usuario conecta al proxy local (puerto configurable, default SSE/WS/StreamableHTTP)
5. connection.store.ts actualiza estado → sidebar muestra herramientas disponibles
6. El usuario envía un mensaje a la IA con instrucciones MCP
7. La IA genera una respuesta con bloques de tool calls (XML o JSON)
8. render_prescript/MutationObserver detecta nuevos nodos en el DOM
9. functionParser.ts (XML) o jsonFunctionParser.ts (JSON) parsea el bloque
10. functionBlock.ts renderiza una tarjeta con botón RUN en el DOM
11. Si auto-execute está activo → automation.service.ts ejecuta automáticamente
12. mcpClient → SSEPlugin/WebSocketPlugin/StreamableHttpPlugin → proxy local → herramienta MCP
13. El resultado llega como ToolCallResult
14. functionResult.ts renderiza el resultado en el DOM
15. Si auto-submit está activo → adapter inserta el resultado en el chat y lo envía
```

---

## 5. Sistema de Plugins y Adapters

### PluginRegistry (`plugins/plugin-registry.ts`)
Registro central que gestiona el ciclo de vida de todos los plugins. Detecta automáticamente el sitio activo por hostname y activa el adapter correspondiente.

### BaseAdapterPlugin (`adapters/base.adapter.ts`)
Clase abstracta con métodos:
- `insertTextIntoInput(text)` — inserta texto en el campo de chat
- `submitInput()` — envía el mensaje
- `getPageContent()` — extrae contenido de la página
- `isApplicable()` — verifica si el adapter aplica al sitio actual

### Adapters implementados

| Adapter | Hostnames |
|---------|-----------|
| ChatGPT | chatgpt.com |
| Gemini | gemini.google.com |
| Grok | grok.com, x.com |
| Perplexity | perplexity.ai |
| DeepSeek | chat.deepseek.com |
| AIStudio | aistudio.google.com |
| OpenRouter | openrouter.ai |
| Mistral | chat.mistral.ai |
| GitHub Copilot | github.com/copilot |
| Kimi | kimi.moonshot.cn |
| T3Chat | t3.chat |
| Z.ai | z.ai |
| QwenChat | qwenchat.com |
| Default | fallback genérico |

### DefaultConfigs (`adapters/defaultConfigs/`)
Cada adapter puede tener configuración por defecto (selectors CSS, estrategias de inserción, retry config). `config-manager.ts` gestiona el merge entre configs remotas y locales.

---

## 6. Sistema de Stores (Zustand)

| Store | Responsabilidad |
|-------|----------------|
| `app.store.ts` | Estado global de inicialización, errores, ciclo de vida de la app |
| `connection.store.ts` | Estado de conexión MCP (disconnected/connecting/connected/error), URL del servidor, health checks |
| `tool.store.ts` | Lista de herramientas disponibles, herramientas detectadas en el DOM, estado de ejecución |
| `ui.store.ts` | Estado del sidebar (visible/collapsed/push-mode), notificaciones remotas, modales |
| `adapter.store.ts` | Adapter activo, registro de adapters, estado de cada adapter |
| `config.store.ts` | Feature flags remotos, preferencias del usuario, notificaciones de versión |

---

## 7. Sistema de Parseo (render_prescript)

### Parser XML — `functionParser.ts`
Detecta y parsea bloques `<function_calls>` con estructura:
```xml
<function_calls>
  <invoke name="tool_name">
    <parameter name="param1">value1</parameter>
  </invoke>
</function_calls>
```

### Parser JSON — `jsonFunctionParser.ts`
Detecta y parsea bloques JSONL con estructura:
```json
{"type": "function_call", "name": "tool_name", "call_id": "uuid", "parameters": {...}}
{"type": "parameter", "key": "param1", "value": "value1", "call_id": "uuid"}
```
Soporta streaming parcial — reconstruye parámetros a medida que llegan.

### Observers
- `mutationObserver.ts` — Observa cambios en el DOM en tiempo real
- `streamObserver.ts` — Detecta streaming activo vs completado
- `stalledStreamHandler.ts` — Maneja streams que se detienen sin completar
- `functionResultObserver.ts` — Observa cuando los resultados son insertados

### Renderer
- `functionBlock.ts` — Crea la tarjeta UI con el tool call, botón RUN/RUNNING/DONE
- `functionResult.ts` — Renderiza el resultado de la ejecución
- `functionHistory.ts` — Mantiene historial de ejecuciones en la sesión
- `themeDetector.ts` — Detecta tema light/dark del sitio con sistema de scoring multi-estrategia

---

## 8. Cliente MCP (chrome-extension/src/mcpclient/)

### McpClient.ts
Cliente principal que:
- Gestiona conexión a través de plugins de transporte
- Expone `callTool(name, args)`, `getPrimitives()`, `connect()`, `disconnect()`
- Emite eventos: `connection:status-changed`, `client:connected`, `client:error`
- Implementa health checks periódicos

### Transportes disponibles

| Plugin | Protocolo | Uso |
|--------|-----------|-----|
| `SSEPlugin.ts` | Server-Sent Events | Default para HTTP/HTTPS |
| `StreamableHttpPlugin.ts` | HTTP streaming | Alternativa moderna |
| `WebSocketPlugin.ts` + `WebSocketTransport.ts` | WebSocket | Para baja latencia |

### Detección automática de transporte
```typescript
ws:// o wss:// → WebSocket
http:// o https:// → SSE (default)
```

---

## 9. Sistema de Eventos (Event Bus)

`event-bus.ts` implementa un EventEmitter pub/sub centralizado. Eventos principales:

| Evento | Descripción |
|--------|-------------|
| `connection:status-changed` | Cambio de estado de conexión MCP |
| `adapter:connection-status-changed` | El adapter activo cambió su estado |
| `sidebar:toggle-requested` | Toggle del sidebar |
| `sidebar:show-with-outputs` | Mostrar sidebar con outputs de herramientas |
| `sidebar:refresh-content` | Refrescar contenido del sidebar |
| `feature-flags:updated` | Flags remotos actualizados |
| `remote-config:updated` | Configuración remota actualizada |
| `app:version-updated` | Nueva versión de la extensión |

---

## 10. Sidebar UI

Construido con React 19 + TailwindCSS, montado en un **Shadow DOM** (`#mcp-sidebar-shadow-host`) para aislamiento de estilos.

### Componentes principales
- `Sidebar.tsx` — Componente raíz con layout y tabs
- `SidebarManager.tsx` — Gestiona ciclo de vida del Shadow DOM
- `ServerStatus/` — Indicador de conexión con el proxy
- `AvailableTools/` — Lista de herramientas MCP disponibles
- `Settings/` — Configuración (auto-execute, auto-submit, push mode, tema)
- `Instructions/` — Generador de instrucciones para la IA
  - `instructionGenerator.ts` — Genera instrucciones en formato XML
  - `instructionGeneratorJson.ts` — Genera instrucciones en formato JSON
  - `schema_converter.ts` — Convierte JSON Schema a formato comprimido
  - `website_specific_instruction/` — Instrucciones específicas por plataforma
- `InputArea/` — Área de input manual para enviar mensajes
- `ui/` — Toggle, Icon, Typography, ResizeHandle (componentes primitivos)

### Animaciones (`sidebar.css`)
El sidebar usa animaciones CSS3 con `cubic-bezier` para aparecer/desaparecer con efecto 3D sutil. Soporta **push mode** (empuja el contenido de la página) y **overlay mode**.

---

## 11. Automation Service (`services/automation.service.ts`)

Gestiona la ejecución automática de tool calls:
- **Auto-execute:** ejecuta automáticamente cuando detecta un tool call nuevo
- **Auto-submit:** después de obtener el resultado, lo inserta en el chat y lo envía
- Respeta permisos por herramienta (`always`, `once`, `never`)
- Almacena permisos en `localStorage` (`mcp_tool_permissions`)

---

## 12. Core Infrastructure

### CircuitBreaker (`core/circuit-breaker.ts`)
Patrón circuit breaker para proteger llamadas a servicios externos:
- Estados: `CLOSED` → `OPEN` → `HALF_OPEN`
- Configurable: threshold de fallos, timeout de reset, umbral de éxito

### ContextBridge (`core/context-bridge.ts`)
Puente de comunicación entre el content script y el background service worker usando `chrome.runtime.sendMessage`.

### ErrorHandler (`core/error-handler.ts`)
Captura global de errores no manejados con reporte estructurado y niveles de severidad.

### Performance (`core/performance.ts`)
Monitor de rendimiento para operaciones críticas del content script.

---

## 13. Firebase Remote Config

Implementado en `chrome-extension/src/background/firebase-remote-config-api.ts` pero **deshabilitado por defecto** (`REMOTE_CONFIG_ENABLED = false`).

Capacidades cuando está habilitado:
- Feature flags (`sidebar_v2`, `ai_tools_enhanced`, `notification_system`)
- Notificaciones remotas
- Configuración por versión
- Configuración específica por adapter

---

## 14. Packages Compartidos

### `@extension/shared`
- `Logger` — Logger con niveles (DEBUG/INFO/WARN/ERROR), deshabilitado en producción
- `withErrorBoundary` — HOC React para error boundaries
- `withSuspense` — HOC React para Suspense
- `useStorage` — Hook para chrome.storage con liveUpdate

### `@extension/storage`
Abstracción sobre `chrome.storage.local` y `chrome.storage.sync` con:
- `createStorage<T>(key, defaultValue, options)`
- `StorageEnum.Local` / `StorageEnum.Sync` / `StorageEnum.Session`
- `liveUpdate: true` para sincronización reactiva

### `@extension/ui`
- `cn(...classes)` — Función de merge de clases Tailwind (clsx + tailwind-merge)
- `withUI(tailwindConfig)` — Wrapper para extender config de Tailwind

---

## 15. Instrucciones para la IA (cómo funciona el protocolo)

Las instrucciones que se inyectan en el chat le dicen a la IA que debe:
1. Imprimir los tool calls como bloques JSON/XML en su respuesta (no ejecutarlos)
2. El DOM observer de la extensión los intercepta y ejecuta
3. El resultado llega en tags `<fnr>` que la IA debe leer para continuar
4. NO usar modo canvas/artifacts de la plataforma
5. Todas las demás herramientas nativas están deshabilitadas

---

## 16. Entry Point y Ciclo de Vida

**`pages/content/src/index.ts`** es el entry point principal:

```
1. initializeLogger()
2. setupSidebarRecovery() — mecanismo de recuperación del sidebar
3. initializeRenderer() — inicialización inmediata del parser (IIFE)
4. applicationInit() — inicialización completa (stores, plugins, sidebar)
5. initializeAllServices() — AutomationService
6. chrome.runtime.onMessage — escucha comandos del popup/background
7. window.beforeunload → applicationCleanup() + cleanupAllServices()
```

---

## 17. Comandos de Desarrollo

```bash
# Instalar dependencias
pnpm install

# Desarrollo con HMR
pnpm dev

# Build de producción
pnpm build

# Empaquetar para distribución
pnpm zip

# Gestionar features del monorepo
pnpm module-manager
```

---

## 18. Archivos Clave para Modificaciones Comunes

| Tarea | Archivos a modificar |
|-------|---------------------|
| Agregar nuevo adapter | `plugins/adapters/nuevo.adapter.ts` + `plugins/index.ts` + `core/config.ts` |
| Cambiar comportamiento del parser | `render_prescript/src/parser/jsonFunctionParser.ts` |
| Modificar UI del sidebar | `components/sidebar/Sidebar.tsx` + `components/sidebar/styles/sidebar.css` |
| Cambiar lógica de auto-ejecución | `services/automation.service.ts` |
| Agregar nuevo evento | `events/event-types.ts` + `events/event-bus.ts` |
| Cambiar configuración de transporte | `chrome-extension/src/mcpclient/config/defaults.ts` |
| Modificar instrucciones para la IA | `components/sidebar/Instructions/instructionGeneratorJson.ts` |

---

## 19. Notas Importantes

- **Shadow DOM:** El sidebar está montado en Shadow DOM para evitar conflictos de estilos con las plataformas de IA. Cualquier estilo debe ser injectado dentro del shadow root.
- **Encoding issue:** Los archivos `t3chat.adapter.ts`, `z.adapter.ts`, `qwenchat.adapter.ts` y `example-forum.adapter.ts` tienen problemas de encoding en Windows pero siguen exactamente el mismo patrón que `grok.adapter.ts`.
- **Firebase deshabilitado:** `REMOTE_CONFIG_ENABLED = false` en `firebase-remote-config-api.ts`. Para habilitarlo se requieren credenciales de proyecto Firebase.
- **Session 10:** El código hace referencias a "Session 10" que es el nombre interno de la refactorización arquitectónica más reciente (sistema de plugins, stores con Zustand, event bus).
- **Analytics:** El content script envía eventos de analítica al background (page_view, url_change, content_script_loaded) vía `chrome.runtime.sendMessage`.

---

*Generado el 2026-04-27 — Cobertura: ~98% del código fuente (~228 archivos)*
