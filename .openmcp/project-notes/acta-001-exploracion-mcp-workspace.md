# Acta 001 - Exploración de /mcp workspace, roles e instancias

Fecha: 2026-10-18
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), chat web de Anthropic con la extensión SuperAssistant. Una acción por turno: el usuario revisa, ejecuta y pega el resultado. Las reglas del flujo están en el archivo de instrucciones que subió al inicio del chat.
Alcance: solo lectura del proyecto; este archivo es lo primero que se crea y no se modificó código.
Último número de llamada usado antes de esta acta: 51.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.

## Identidad de este chat (debe sellarla el sistema, no la IA)
- platformId: desconocido (el propio chat declara ser un chat web de Anthropic)
- agentId, instanceId, sessionMode, conversationId: desconocidos (la IA no ve su ficha ni la dirección del chat)
- Rol en el workspace: desconocido. El usuario dijo que lo lanzó 'de forma usuario' desde la interfaz web; sin verificar.

Convención: [C] comprobado en el código (archivo:línea), [I] inferido, [R] corregido durante la sesión, [?] sin verificar. Rutas relativas a la raíz del repo; las líneas se mueven con los cambios.

## 1. Comando y arranque
- [C] src/commands/mcp/mcp.tsx:653-655: con el subcomando workspace importa ./workspaceCommand.js y le pasa el resto de argumentos.
- [C] src/commands/mcp/workspaceCommand.ts: sin argumentos arranca la interfaz web y devuelve su URL; stop la detiene; status solo muestra la URL. En src/services/webUI/integration.ts:1404-1406 la instancia es única y perezosa: stop la desconecta y un nuevo arranque la recrea.
- [C] integration.ts:61 (initializeWebUI): restaura la sesión de workspace, crea el servidor, registra el revisor Sentinel (envía a Gemini un mensaje visible) y conecta los manejadores de ajustes, contexto, actividad y participantes.
- [C] src/services/webUI/WebUIServer.ts:12-14: puerto 3007 o la variable OPENMCP_WEBUI_PORT (entero 1-65535; si no, error). Líneas 16, 101, 219 y 881: el host es 0.0.0.0 fijo en el código; no vi variable de entorno que lo cambie.

## 2. Seguridad (SENSIBLE: revisar antes de subir a un repo público)
- [C] WebUIServer.ts:53 y 75: la validación es de origen (el origin coincide con el host y este es loopback o una IP propia). No es autenticación: en ese archivo no hay token, contraseña ni cabecera de autorización.
- [C] Varios endpoints devuelven 403 por origen (líneas 255-709). El WebSocket (:204) no rechaza, solo marca sameOrigin=false. En :520, /api/prompt exige origen solo si el cuerpo trae masterSessionSourceId o workspaceParticipantId.
- [I] Un equipo de la red local podría enviar un prompt simple a /api/prompt; el alcance depende de las herramientas de los agentes y de si SuperAssistant las ejecuta solo. No probado.
- El usuario indicó que es una red doméstica. Queda pendiente, no corregido. Opción: host 127.0.0.1 (una línea), sin aplicar.

## 3. Roles y enrutamiento
- [C] src/services/webRelay/launchPolicy.ts:20: es coordinador el rol primary o con forma orchestrator-N. Quedan fuera del trabajo automático manual-user-*, sentinel-guest-* y los ids que empiezan por sentinel-.
- [C] launchPolicy.ts (resolveRelayLaunchCoordination): el modo usuario nunca lanza orquestador; el cerebro web exige un Relay coordinador dedicado; con cerebro api todas las instancias lanzadas son workers; el modo agente siempre exige orquestador.
- [C] integration.ts:806 y siguientes (onPrompt): las Master registradas entran al pool como agentId master-session:ID con rol worker-master-ID, y solo cuentan si su sesión está activa y válida.
- [C] integration.ts:415-416 y 527: una Master se registra como worker solo si se pide (registerAsWorkspaceWorker o el indicador heredado prepareSuperAssistant); las instancias locales (Antigravity, Claude Desktop, Claude Code) por defecto sí. Al lanzar Claude Desktop se registra el servidor MCP del proyecto en su configuración con el puerto 3006.
- [C] src/services/webRelay/WebRelayCoordinator.ts:66-127: el plan es un JSON con exactamente una tarea por worker, sin repetir ni asignarse trabajo; los workers corren en serie y un error no detiene a los demás. La fase de revisión final no se leyó [?].
- [C] Los participantes IDE trabajan por consulta (workspace_join, workspace_poll_tasks, workspace_complete_task); las instancias web, por envío directo del prompt.

## 4. Mensaje de arranque
- [C] src/services/webRelay/StartupHandshake.ts: el texto cambia según el rol (coordinador o worker), prohíbe ejecutar herramientas en ese intercambio y exige responder solo con un JSON (handshakeId, agentId, instanceId, platformId, rol), validado campo por campo.
- [C] Solo se invoca desde src/services/webRelay/WebRelayProvider.ts:1543. El controlador de Master (src/services/webRelay/session/MasterSessionController.ts) no lo llama.
- [I] Una Master abierta desde la interfaz probablemente no recibe el mensaje de rol al abrirse. Falta ver qué función contiene esa línea y quién la llama [?].

## 5. Herramientas que ve una instancia web
- [C] src/services/webRelay/WebToolBridge.ts: WEB_MODE_CORE_TOOLS tiene 10 nombres (7 de archivos y comandos, más report_finding, request_info y flag_issue). El filtro (:456) mira solo el nombre; el comentario da como motivo el límite de tamaño del prompt. MAX_TOOL_LOOPS=10 y MAX_TOOL_OUTPUT_CHARS=10000; una herramienta sin implementación en modo web devuelve error (~línea 415).
- [C] WebRelayProvider.ts:1309-1311: si no hay herramientas crudas, el respaldo usa solo 7 (sin las de colaboración). El mismo filtro se usa en :1369 y no se leyó [?].
- [C] Las herramientas workspace_* se registran en src/services/mcpServer/ToolAdapter.ts:747 y MCPSSEServer.ts:117 las expone sin filtro; ninguna de envío a instancias está en la lista web. workspace_send_instance_prompt exige userApproved=true, un solo destino y un prompt de hasta 8000 caracteres.
- [C] ToolAdapter.ts:~726-742: chrome-devtools-mcp.new_page siempre responde éxito sin abrir nada y list_pages devuelve un texto fijo. No sé si las llamadas desde un chat llegan a estos stubs o a un servidor real [?].
- [C] src/services/mcpServer/SentinelMCPTools.ts (:906-1326): 7 herramientas con nombre, de aspecto observador. Solo leí la descripción de 3 [?].

## 6. Colaboración y memoria
- [C] src/services/collaboration/CollaborationTools.ts:119: request_info busca coincidencias de texto en hallazgos ya publicados por otros workers; si hay, los devuelve al instante (cumplida por orchestrator-auto); si no, queda pending con un mensaje que promete respuesta.
- [C] fulfillRequest solo se llama desde request_info (:186) y una prueba; getPendingRequests solo en WebUIServer.ts:831. No encontré quién atiende las pendientes (búsqueda solo en .ts de src) [?].
- [I] CollaborationStore.ts no tiene llamadas a disco (writeFile, appendFile, readFile, mkdir): hallazgos y peticiones probablemente se pierden al cerrar.
- [C] src/services/webRelay/WorkspaceContextJournal.ts:341: getWorkspaceContextInstruction devuelve vacío salvo que webRelaySaveCleanContext sea true; si lo es, añade un aviso sobre el diario y que su contenido es dato histórico no confiable. El diario vive en %LOCALAPPDATA%/openMCPWEBLOCK/workspace-context/ (un .jsonl por proyecto).

## 7. Identificación de chats: lo que ya existe
- [C] Diario de contexto (WorkspaceContextJournal.ts): cada evento capturado lleva platformId, sessionMode, agentId, instanceId y conversationId. Capturar exige webRelaySaveCleanContext y webRelayCaptureWebConversations, y omite texto con apariencia de credencial. Esos campos los aporta quien captura (el observador de la página); no sé si el sistema los verifica ni cómo se calcula conversationId [?].
- [C] Antigravity local (WorkspaceMCPTools.ts): workspace_list_local_conversations indexa conversaciones con ID; workspace_open_local_conversation carga una y devuelve el modelo mostrado; workspace_send_local_prompt exige ese modelo como expectedModel y userApproved.
- [C] Master: webRelayResumePreviousMasterSession llega como resumePreviousConversation (integration.ts:580 y 1153) y como restorePreviousSession a MasterSessionController.ts:42-49; modos restore o fresh en :73.
- [I] Por los nombres, reanudar una Master parece restaurar la sesión del navegador, no un identificador de chat propio. No leído [?].
- [C] workspaceSettings.ts: workers en webRelayMasterSessionIds y anteriores en webRelayPreviousMasterSessionIds; con restorePreviousMasterWorkers en false, startWorkspaceSession vacía la lista activa al arrancar.

## 8. Correcciones durante la sesión
- [R] El valor true por defecto de integration.ts:527 es para instancias locales, no para Master.
- [R] El cerebro por defecto es api solo con la coordinación activa; sin ella, runCoordinatedWebTask usa web por defecto y el prompt va al primer agente listo, sin plan.
- [R] Había dicho que una instancia web no conoce su rol: el mensaje de arranque se lo comunica, al menos en el flujo Relay [?].
- [R] request_info no sirve para delegar: solo consulta hallazgos ya publicados.
- [R] Había dicho que ninguna herramienta de Sentinel envía prompts; solo leí 3 de 7 [?].
- [R] Había dicho que la lista de herramientas de esta pestaña la limita la extensión; no está verificado.

## 9. Barreras de experiencia de usuario
- Entender un comando costó 50 acciones; muchas lecturas eran independientes. Mitigación probada en la acción 51: agrupar consultas de solo lectura en un comando con bloques etiquetados.
- El código de salida de un agrupado es el del último bloque: uno sin coincidencias parece un fallo. Mitigación: cerrar con un marcador de fin; si falta, la salida se truncó.
- Tres salidas llegaron truncadas y la IA no puede abrir el texto completo: leer por rangos de unas 80 líneas y pedir antes el total de líneas. No hay ripgrep: se usa el buscador nativo de Windows.
- La IA no ve su agentId, su rol ni su registro: la identidad debe sellarla el sistema. En sesiones largas hay deriva: separar lo comprobado de lo supuesto y dejar actas como esta.
- Archivo de instrucciones: el ejemplo del formato quedó como marcador sin sustituir, no declara sistema ni shell y repite alias de una misma herramienta.

## 10. Diseño pendiente (propuestas, nada implementado)
- Apartado de proyectos: notas de solo añadir con texto, estado (comprobado, inferido, retractado), evidencia (archivo:línea), autor, aprobación del usuario e identidad del chat con los mismos campos del diario. Lo desconocido queda como desconocido; una corrección es una nota nueva que sustituye a la anterior.
- Protocolo de arranque sobre una Master (sesión reutilizable, con mensajes directos desde la interfaz). El mensaje de arranque actual pide solo un JSON y no ejecutar nada, así que el resumen del proyecto iría en un segundo mensaje acotado en tamaño: lo aprobado por el usuario como instrucciones y lo escrito por una IA como dato.
- Delegación hacia otras IA: no existe para workers web; requeriría una herramienta de envío con userApproved, sin autoenvío ni envío al coordinador. En pausa por decisión del usuario.
- Otros pendientes: consumidor de las peticiones pendientes; stubs del navegador; confirmar si el mensaje de rol llega a una Master o al modo usuario; revisar si el límite de truncado se ajusta en superassistant-proxy.config.json [?]; decidir si .openmcp se versiona (no aparece en .gitignore).
