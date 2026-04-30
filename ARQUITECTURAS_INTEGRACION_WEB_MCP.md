# Arquitecturas de Integracion: OpenClaude + MCP-SuperAssistant

## Contexto y punto de partida

Si, ya revise `PROJECT_CONTEXT_ SUPERASISTANT.md` y tu observacion es correcta: para ciertas tareas, la experiencia en interfaces web (ChatGPT/Gemini/etc.) puede sentirse mas rapida o mas "fluida" que algunas rutas API, sobre todo cuando hay throttling, colas o limites por proveedor.

Tu idea del **boton para alternar modo API vs modo SuperAssistant** es buena y, bien diseñada, evita friccion para charlas simples.

---

## Objetivo de diseno

Lograr un sistema con:
- **Modo conversacional rapido** (sin tool-calling forzado).
- **Modo herramientas web** bajo demanda (MCP-SuperAssistant).
- **Memoria persistente** (claude-mem u otra) compartida entre modos.
- **Conmutacion clara y reversible** con telemetria y health checks.

---

## Opcion 1: Modo Dual Manual (baseline)

### Como funciona
- Modo A (default): OpenClaude directo a proveedor API/local.
- Modo B: usuario abre interfaz web + extension MCP-SuperAssistant + proxy.
- Usuario decide manualmente donde trabaja cada tarea.

### Pros
- Menor complejidad tecnica inicial.
- Muy robusto y facil de depurar.
- Cero acoplamiento fuerte entre CLI y navegador.

### Contras
- Cambio de contexto manual.
- Sin continuidad automatica de mensajes entre CLI y web.

### Recomendado para
- Inicio rapido y validacion operativa.

---

## Opcion 2: Boton "Web Relay Mode" (tu idea, recomendada)

### Como funciona
- En OpenClaude (CLI o extension VS Code), agregas un toggle:
  - `API Mode` / `Web Relay Mode`.
- Al activar `Web Relay Mode`:
  1. Levanta o verifica `mcp-superassistant-proxy`.
  2. Selecciona interfaz web objetivo (ChatGPT, Gemini, Perplexity, etc.).
  3. Envia mensajes del chat local hacia esa interfaz por un bridge de automatizacion.
  4. Inserta respuesta devuelta en el chat local.

### Pros
- UX unificada: "un solo chat" para el usuario.
- Permite explotar velocidad/ergonomia de interfaces web.
- Base natural para evolucionar a multi-interfaz.

### Contras
- Requiere capa de orquestacion extra.
- Manejo de sesiones, login y anti-bot puede ser fragil.
- Mayor riesgo de cambios por updates del DOM en plataformas web.

### Riesgos operativos
- Timeouts, captcha, cambios UI, reconexiones.
- Necesidad de retries y fallback automatico a API mode.

---

## Opcion 3: Enrutador Hibrido por Intencion (smart routing)

### Como funciona
- El sistema clasifica cada mensaje:
  - "charla simple" -> API Mode.
  - "accion con herramientas web/MCP" -> Web Relay Mode.
- Permite override manual con comandos:
  - `/mode api`
  - `/mode web`
  - `/mode auto`

### Pros
- Mejor balance costo/latencia/calidad.
- Menos friccion que cambiar siempre a mano.

### Contras
- Necesita clasificador confiable (puede fallar).
- Mayor complejidad de observabilidad.

---

## Opcion 4: Multi-Web Agent Pool ("agentes web")

### Como funciona
- Multiples sesiones web paralelas por proveedor/plataforma.
- Un orquestador delega subtareas a "agentes web" especializados:
  - Agente ChatGPT (investigacion)
  - Agente Gemini (resumen)
  - Agente Perplexity (fuentes)
- Luego consolidas resultados en OpenClaude.

### Pros
- Escala tareas complejas.
- Reduce dependencia de un solo proveedor.

### Contras
- Coste computacional alto y control complejo.
- Alta necesidad de monitoreo y control de errores.

### Recomendado para
- Fase avanzada, no como primer paso.

---

## Opcion 5: MCP Web Automation con Playwright (complementaria)

### Como funciona
- Integrar `@playwright/mcp` como herramienta MCP adicional.
- Usar Playwright para pasos deterministas (navegar, click, fill, snapshot).
- SuperAssistant se mantiene para inyeccion/uso en chats web.

### Pros
- Automatizacion reproducible y testeable.
- Mejor trazabilidad que puro scraping DOM ad-hoc.

### Contras
- Mas componentes a mantener.
- Requiere gestion de sesiones y perfiles de navegador.

---

## Comparativa rapida

| Opcion | Complejidad | Latencia percibida | Robustez | UX unificada | Escalabilidad |
|---|---|---|---|---|---|
| Dual Manual | Baja | Media/Alta | Alta | Baja | Media |
| Web Relay Toggle | Media | Alta (buena UX) | Media | Alta | Media |
| Smart Routing | Media/Alta | Alta | Media | Alta | Alta |
| Multi-Web Agent Pool | Alta | Variable | Baja/Media | Media | Muy alta |
| Playwright + MCP | Media | Media | Alta | Media | Alta |

---

## Recomendacion concreta para tu proyecto

### Fase 1 (ahora): Baseline robusto
1. Mantener API Mode como default.
2. Mantener Web Mode con proxy y health checks.
3. Guardar memoria en `claude-mem` (resumen por tarea + decisiones).
4. Monitorear:
   - tiempo de respuesta
   - tasa de error de tool-calls
   - reconexiones proxy

### Fase 2: Implementar `Web Relay Mode` (boton)
1. Agregar `mode` en settings (`api|web|auto`).
2. Crear `WebRelayController` con:
   - `ensureProxyUp()`
   - `ensureWebSession(provider)`
   - `relayMessage()`
   - `fallbackToApi()`
3. Plantillas de instrucciones por interfaz (ChatGPT/Gemini/etc.).

### Fase 3: `Auto Mode` (routing por intencion)
1. Clasificador simple por reglas + override manual.
2. Logs por decision de routing.
3. Circuit-breaker para volver a API si web falla.

### Fase 4 (opcional): Agentes web paralelos
1. Ejecutar subtareas concurrentes con limites.
2. Fusionar resultados y registrar trazabilidad.

---

## Diseno del boton/alternador (propuesta UX)

### Estado visible
- `Mode: API`
- `Mode: Web (ChatGPT)`
- `Mode: Auto`

### Acciones del boton
1. Clic en toggle -> abre modal corto:
   - selector de interfaz web
   - selector de perfil/instrucciones
   - opcion "usar esta configuracion por defecto"
2. Si falta proxy:
   - iniciar automaticamente
   - mostrar estado `Connecting...`
3. Si falla:
   - toast con causa
   - fallback inmediato a API mode

### Seguridad/privacidad
- Banner explicito cuando un mensaje sale a plataforma web.
- Redaccion de secretos antes de relay.
- Lista de dominios permitidos.

---

## Memoria y contexto (clave para sinergia)

### Base recomendada
- `claude-mem` para:
  - preferencias de usuario
  - estado de tareas largas
  - decisiones de arquitectura

### Politica sugerida
- Al cerrar cada tarea:
  - guardar un resumen corto estructurado.
- Al iniciar tarea:
  - recuperar solo memoria relevante por tags.
- Evitar "arrastrar todo" para no degradar contexto.

---

## Riesgos reales y mitigaciones

1. **SSE inestable en reconexiones**  
   Mitigacion: priorizar `streamableHttp` cuando sea posible.

2. **Cambio de DOM en plataformas web**  
   Mitigacion: capas de adaptadores por plataforma + tests de humo.

3. **Captcha / bloqueos / anti-bot**  
   Mitigacion: fallback API y reintento manual asistido.

4. **Desfase de conversaciones entre modos**  
   Mitigacion: sincronizar resumen de turno en memoria compartida.

---

## Referencias utiles para este panorama

- MCP-SuperAssistant: [github.com/srbhptl39/MCP-SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant)
- Proxy npm: [npmjs.com/package/@srbhptl39/mcp-superassistant-proxy](https://www.npmjs.com/package/@srbhptl39/mcp-superassistant-proxy)
- Playwright MCP: [playwright.dev/docs/getting-started-mcp](https://playwright.dev/docs/getting-started-mcp)
- Browser-use (idea de agentes web): [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)

---

## Decisiones sugeridas (ejecutables)

1. Adoptar oficialmente `mode=api` como default.
2. Implementar `mode=web` con boton + selector de interfaz.
3. Mover proxy a `streamableHttp` en pruebas de estabilidad.
4. Crear piloto de `mode=auto` con reglas simples.
5. Medir durante 1 semana latencia, errores y satisfaccion por modo.

---

## Cierre

Tu idea del alternador no solo es viable, es probablemente la mejor ruta para unir "chat simple" y "chat con herramientas web" sin forzar friccion. La estrategia correcta es evolucionar por fases: primero confiabilidad, luego UX unificada, luego automatizacion inteligente.
