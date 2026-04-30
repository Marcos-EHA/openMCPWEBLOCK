# MODE CONTROLLER DESIGN

## Visión General

El Mode Controller es un mecanismo de selección de herramientas que permite a los usuarios alternar entre tres modos de ejecución de MCP:

- **API Mode**: Solo herramientas built-in (comportamiento original)
- **Web Mode**: Solo herramientas MCP del servidor `superassistant-proxy`
- **Auto Mode**: Todas las herramientas disponibles (MCP + built-in)

## Diseño Técnico

### 1. Cambios en Config

#### Archivo: `src/utils/config.ts`

**Interface ProjectConfig**:
```typescript
export type ProjectConfig = {
  // ... campos existentes ...
  
  /** Mode for MCP execution: 'api' for direct API calls, 'web' for web relay via MCP-SuperAssistant, 'auto' for automatic selection */
  mcpExecutionMode?: 'api' | 'web' | 'auto'
}
```

**Default Config**:
```typescript
const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  // ... defaults existentes ...
  mcpExecutionMode: 'api', // Default to API mode
}
```

### 2. Comando CLI

#### Archivo: `src/commands/mcp/index.ts`

Actualizado argumentHint:
```typescript
argumentHint: '[enable|disable [server-name]] | [set-mode api|web|auto]'
```

#### Archivo: `src/commands/mcp/mcp.tsx`

**Nuevo componente**:
```typescript
function MCPSetMode({ mode, onComplete }: { mode: 'api' | 'web' | 'auto'; onComplete: (message: string) => void }) {
  const didRun = useRef(false);
  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    const config = getCurrentProjectConfig();
    updateCurrentProjectConfig({ ...config, mcpExecutionMode: mode });
    onComplete(`MCP execution mode set to '${mode}'`);
  }, [mode, onComplete]);
  return null;
}
```

**Lógica de dispatch**:
```typescript
if (parts[0] === 'set-mode' && parts[1] && ['api', 'web', 'auto'].includes(parts[1])) {
  return <MCPSetMode mode={parts[1] as 'api' | 'web' | 'auto'} onComplete={onDone} />;
}
```

### 3. Selección de Herramientas

#### Archivo: `src/tools.ts`

**Función `assembleToolPool` (actualizada)**:

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const config = getCurrentProjectConfig()
  const mode = config.mcpExecutionMode || 'api'

  // Filter out MCP tools that are in the deny list
  let allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Filter MCP tools based on execution mode
  if (mode === 'api') {
    // In API mode, exclude MCP tools (use only built-in)
    allowedMcpTools = []
  } else if (mode === 'web') {
    // In web mode, only include MCP tools from superassistant-proxy
    allowedMcpTools = allowedMcpTools.filter(tool =>
      tool.mcpInfo?.serverName === 'superassistant-proxy'
    )
  } else if (mode === 'auto') {
    // In auto mode, include all MCP tools (default behavior)
    // Could implement logic to choose based on tool type or context
  }

  // ... rest of deduplication logic ...
}
```

## Flujo de Ejecución

```
┌─────────────────────────────────────────┐
│  Usuario ejecuta comando: /mcp set-mode web
└────────────────┬────────────────────────┘
                 │
         ┌───────▼────────┐
         │ MCPSetMode     │
         │ Component      │
         │ (mcp.tsx)      │
         └───────┬────────┘
                 │
         ┌───────▼────────────────────┐
         │ updateCurrentProjectConfig │
         │ (config.ts)                │
         └───────┬────────────────────┘
                 │
         ┌───────▼──────────────────┐
         │ Guardar en proyecto      │
         │ .claude/config.json      │
         └───────┬──────────────────┘
                 │
         ┌───────▼────────────────────┐
         │ Próxima llamada:            │
         │ assembleToolPool            │
         │ (tools.ts)                 │
         └───────┬────────────────────┘
                 │
         ┌───────▼───────────────────────┐
         │ Leer mcpExecutionMode='web'  │
         │ Filtrar herramientas MCP     │
         └───────┬───────────────────────┘
                 │
         ┌───────▼──────────────────────────┐
         │ Tool Pool =                      │
         │ - Built-in tools                │
         │ - MCP tools (superassistant     │
         │   only)                         │
         └────────────────────────────────┘
```

## Estados y Transiciones

```
┌─────────────────────────────────────────────┐
│          API Mode (Default)                 │
│  Built-in tools only                        │
│  No latencia web, máxima confiabilidad      │
└──────────────┬──────────────────────────────┘
               │ /mcp set-mode web
               │
               ▼
┌─────────────────────────────────────────────┐
│          Web Mode                           │
│  MCP-SuperAssistant proxy tools             │
│  Posible latencia, acceso a web relay       │
└──────────────┬──────────────────────────────┘
               │ /mcp set-mode auto
               │
               ▼
┌─────────────────────────────────────────────┐
│          Auto Mode                          │
│  Todas las herramientas (built-in + MCP)   │
│  Máxima flexibilidad                        │
└──────────────┬──────────────────────────────┘
               │ /mcp set-mode api
               │
               └──────────────┐
                              ▼ (ciclo)
                        API Mode
```

## Persistencia de Configuración

La configuración se guarda en:
```
~/.claude/projects/<PROJECT_HASH>/config.json
```

Estructura guardada:
```json
{
  "mcpExecutionMode": "web"
}
```

## Testing

### Unit Test Ejemplo
```typescript
describe('assembleToolPool', () => {
  it('should exclude MCP tools in api mode', () => {
    // Mock config con mcpExecutionMode='api'
    const tools = assembleToolPool(permissionContext, mcpTools);
    expect(tools).not.toContainEqual(
      expect.objectContaining({ mcpInfo: { serverName: 'superassistant-proxy' } })
    );
  });

  it('should include only superassistant-proxy tools in web mode', () => {
    // Mock config con mcpExecutionMode='web'
    const tools = assembleToolPool(permissionContext, mcpTools);
    expect(tools.filter(t => t.mcpInfo)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mcpInfo: { serverName: 'superassistant-proxy' } })
      ])
    );
  });

  it('should include all tools in auto mode', () => {
    // Mock config con mcpExecutionMode='auto'
    const tools = assembleToolPool(permissionContext, mcpTools);
    expect(tools).toContain(builtInTools);
    expect(tools).toContain(mcpTools);
  });
});
```

## Roadmap de Expansión

### Fase 1 (Actual): MVP
- ✅ Tres modos basados en config simple
- ✅ Comando CLI para cambiar modo
- ✅ Persistencia en config

### Fase 2: Inteligencia de Selección
- Logic para `auto` basada en:
  - Tipo de tarea detectado
  - Latencia estimada
  - Histórico de éxito/fracaso
- UI indicator del modo activo

### Fase 3: Multi-Interface Web
- Soporte para múltiples servidores MCP
- Selector de interfaz web
- Herramientas específicas por interfaz

### Fase 4: Agentes Web
- Orquestación multi-herramienta
- Memoria contextual (Claude Mem)
- Monitoreo y gobernanza

## Conclusión

El Mode Controller implementa una arquitectura extensible y simple para alternar entre modos de ejecución. El diseño permite evolucionar hacia sistemas más sofisticados sin romper compatibilidad con el comportamiento actual.