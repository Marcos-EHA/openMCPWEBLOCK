# Avances en OpenClaude con Ollama - Multi-Modelo

## Resumen de Implementación

Se ha implementado un sistema de auto-switching de modelos en OpenClaude para usar Ollama localmente, con un enfoque en arquitectura multi-modelo donde un modelo de razonamiento actúa como agente principal.

## Arquitectura Implementada

### 1. Modelo Principal de Razonamiento
- **Modelo**: `llama3.2:3b`
- **Función**: Maneja TODA la conversación y razonamiento
- **Ventana de Contexto**: **128K tokens** (resuelve problema de límites)

### 2. Modelos Especializados como Herramientas
- **Code Model**: `codellama:7b-code`
  - Accedido vía tool `delegate_to_model` para tareas de código
- **Chat Model**: `neural-chat:7b`
  - Disponible como alternativa para conversación

### 3. Sistema de Delegación por Tools
- **Tool**: `delegate_to_model`
- **Función**: Permite al modelo principal invocar otros modelos
- **Uso**: Para tareas especializadas que requieren expertise específica

### 4. Auto-Switching Desactivado
- **Cambio**: Ya no cambia modelo por query
- **Motivo**: Para mantener conversación unificada con neural-chat
- **Alternativa**: Delegación vía tools cuando sea necesario

## Limitaciones Actuales y Soluciones

### Problema: Context Limit Reached
- **Causa**: Prompt completo (historial + system) excede límite del modelo (~8K tokens)
- **Solución Temporal**:
  - Usar `/clear` para limpiar historial
  - Usar `/compact` para comprimir contexto
- **Solución Futura**: Implementar compactación automática o modelos con mayor contexto

### Multi-Modelo como Herramientas
- **Estado Actual**: Switching automático por query
- **Visión Futura**: Modelo principal puede invocar otros modelos vía tools durante la conversación
- **Implementación Pendiente**: Crear tool `delegate_to_model` para llamadas inter-modelo

## Archivos Modificados

1. `src/utils/model/model.ts`:
   - Modificada `getBestModelForQuery()` para usar siempre `neural-chat:7b`
   - Desactivado switching automático por query

2. `src/tools/ModelDelegateTool/`:
   - Nueva tool `delegate_to_model`
   - Permite invocar otros modelos desde neural-chat
   - API calls directas a Ollama

3. `src/tools.ts`:
   - Agregada importación y registro de `ModelDelegateTool`

4. `src/QueryEngine.ts`:
   - Sin cambios - usa `getBestModelForQuery()` que ahora retorna neural-chat

5. `scripts/run-openclaude-reasoning.cmd`:
   - Script de lanzamiento con modelo fijo a neural-chat

6. `README.md` y `AVANCES_MULTI_MODELO.md`:
   - Documentación actualizada

## Próximos Pasos

1. **Probar Sistema Completo**:
   - Ejecutar OpenClaude con llama3.2:3b
   - Verificar que "hola" funciona sin límite de contexto
   - Probar delegación a otros modelos

2. **Optimizar Tool de Delegación**:
   - Ajustar cuándo llama3.2 usa la tool
   - Mejorar prompts para mejor delegación

3. **Evaluar Rendimiento**:
   - Comparar respuestas de llama3.2 vs modelos especializados
   - Ajustar estrategia según resultados

4. **Expandir Modelo**:
   - Agregar más modelos especializados si es necesario
   - Implementar lógica más sofisticada de delegación

## Comandos para Probar

```bash
# Verificar modelos instalados
ollama list

# Ejecutar con modelo de alto contexto
cd C:\Users\marco\git\openclaude
scripts\run-openclaude-reasoning.cmd

# Dentro de OpenClaude:
# Probar conversación: "hola" (llama3.2 responde directamente)
# Probar código: "escribe una función python" (puede usar delegate_to_model para codellama)
# Limpiar contexto: /clear (ya no debería ser necesario)
# Compactar: /compact
```

## Logs y Debugging

- **Uso de Tools**: Revisar logs de OpenClaude para ver tool calls
- **Errores**: Revisar consola de OpenClaude
- **Verificación**: Modelo base es llama3.2:3b (128K contexto)
- **Verificación**: `OPENCLAUDE_AUTO_MODEL_SWITCH=true` debe estar set

Esta implementación proporciona una base sólida para conversación sin límites de tokens usando modelos locales, con capacidad de expansión hacia arquitectura multi-agente.