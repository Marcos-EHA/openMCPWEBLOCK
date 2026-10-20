export type SentinelFlowVisibility = 'visible' | 'hidden' | 'unknown'
export type SentinelFlowFocus = 'focused' | 'unfocused' | 'unknown'
export type SentinelUserIntervention = 'occurred' | 'not-observed' | 'unknown'

export interface SentinelExecutionFlowSnapshot {
  requestSubmitted: boolean | null
  assistantResponseObserved: boolean | null
  functionCallObserved: boolean | null
  turnSettled: boolean | null
  autoExecuteEnabled: boolean | null
  matchingVisibleExecuteButton: boolean | null
  claimCreated: boolean | null
  executionTriggered: boolean | null
  executionIdentityPresent: boolean | null
  executionStatus: 'success' | 'error' | 'missing' | 'unknown' | null
  diagnosticTransportLagMs?: number | null
  resultInserted: boolean | null
  autoSubmitEnabled: boolean | null
  resultSubmitted: boolean | null
  assistantResponded: boolean | null
  visibility: SentinelFlowVisibility
  focus: SentinelFlowFocus
  userIntervention: SentinelUserIntervention
}

export interface SentinelExecutionFlowDiagnosis {
  code: string
  confidence: 'observed' | 'inconclusive'
  summary: string
  nextCheck: string
}

export const SENTINEL_EVIDENCE_MENU_OPTION = {
  label: 'Evidencia y diagnóstico de llamadas MCP',
  value: 'evidence',
  description: 'Consulta resultados observados, límites de la prueba y diagnóstico por etapas.',
} as const

export const CHATGPT_AUTO_EXECUTION_EVIDENCE = {
  id: 'chatgpt-auto-execution-background-2026-09-29',
  title: 'ChatGPT: Auto Execute, entrega del resultado y dependencia de foco',
  date: '2026-09-29',
  conclusion: 'La ejecución y entrega MCP sí se observaron; la operación completamente desatendida no quedó demostrada.',
  observed: [
    'Con el prompt Original intacto y Auto Execute/Insert/Submit activos, una llamada Bash inocua terminó en Execution Completed.',
    'La traza de esa llamada registró AUTO_EXECUTION_TRIGGERED, GET_EXECUTION_RESOLVED=success, RESULT_INSERTION_SUCCEEDED y DELIVERY_MARKED_DELIVERED.',
    'El claim local de SuperAssistant no contiene executionId; la identidad se obtiene en la ruta de despacho y getExecution. La ausencia de identidad en el claim no prueba que falte en MCP.',
    'El usuario informó que visualizó la ventana durante esa interacción; por ello no cuenta como prueba sin intervención.',
    'Después de la ejecución apareció una tarjeta completa visible y una tarjeta duplicada con dimensiones cero. La selección automática debe excluir tarjetas no visibles y controles deshabilitados.',
    'Un intento posterior en una pestaña oculta no generó una llamada MCP observable antes de terminar la prueba; el borrador preparado activó el foco de la página, así que no fue una prueba válida de ejecución desenfocada.',
  ],
  notProven: [
    'Que ChatGPT genere y ejecute la llamada MCP si nadie visualiza o enfoca la página.',
    'Que ChatGPT produzca siempre una respuesta final después de recibir e insertar un resultado MCP.',
    'Que la ausencia de foco sea la causa del intento fallido: también deben comprobarse sesión, generación y estado del envío.',
  ],
  nextCheck: 'En una sesión autenticada, enviar una sola petición nueva mientras la pestaña ya está oculta y sin foco; conservar una línea de tiempo de visibilidad, foco, tarjeta ejecutable, claim, executionId, entrega y respuesta final. No repetir una llamada pendiente.',
} as const

export const CHATGPT_HIDDEN_EXECUTION_EVIDENCE = {
  id: 'chatgpt-hidden-execution-and-diagnostic-lag-2026-10-08',
  title: 'ChatGPT: ejecución MCP oculta y retraso de diagnósticos',
  date: '2026-10-08',
  conclusion: 'Cinco ejecuciones Read autenticadas completaron hasta inserción y Auto Submit estando minimizadas, incluida una prueba con dos agentes concurrentes que mantuvo ambas generaciones en paralelo; el harness dio PASS y correlacionó las trazas durables. Dos corridas anteriores tuvieron retraso del collector (91 s y 235 s), y otros intentos se detuvieron por transición visible o preflight.',
  observed: [
    'Dos llamadas Read con call IDs únicos completaron parser → Auto Execute → EXECUTION_CREATED con executionId real → dispatch MCP → completion success → inserción del resultado → Auto Submit success.',
    'Las muestras durante las dos llamadas completas fueron hidden/unfocused (19/19 y 15/15); el probe de timer oculto se disparó. Esto prueba que la ruta de herramienta puede completar en background, no que el ciclo conversacional entero sea 100% fiable.',
    'En la primera corrida el collector recibió eventos unos 91 segundos después de sus timestamps de origen; en la segunda, hasta unos 235 segundos después. El harness informó FAIL/TIMEOUT antes de leer esas fases ya completadas.',
    'En otra corrida la pestaña pasó a visible y siguió desenfocada durante la generación antes de emitirse JSONL; esa corrida se abortó y no demuestra fallo ni éxito de ejecución MCP.',
    'Un intento adicional no encontró el botón compacto de SuperAssistant durante el preflight; no se envió una petición y no cuenta como prueba de Auto Execute.',
    'Una nueva instancia OpenMCP autenticada completó Read con PASS: 52/52 muestras hidden/unfocused, timer probe oculto disparado, brecha de visibilidad de 2607 ms antes de Auto Submit, retraso máximo de entrega diagnóstica 1774 ms, y ninguna fase requerida ausente.',
    'La repetición PASS observó el bundle esperado y la traza correlacionada también desde chrome.storage.local. Confirmó el arranque minimizado, throttling de timers/background renderer desactivado y entrega automática al composer mientras la instancia estaba oculta.',
    'El relay usado para la repetición se detuvo y el puerto 9222 quedó cerrado; MCP :3006 y la Master dedicada :9227 permanecieron activos.',
    'Prueba de concurrencia OpenMCP (2026-10-08): dos relays ChatGPT autenticados se lanzaron mediante MultiAgentRunner y recibieron solicitudes Read independientes con call IDs distintos en el mismo milisegundo. Ambas generaciones se observaron activas en paralelo; cada traza completó parser, creación de executionId/executionKey, dispatch MCP, completion success, inserción y Auto Submit success.',
    'Se verificó que `C:\\Users\\elias\\OneDrive\\Desktop\\OpenMCPWEBLOCK.lnk` apunta a `node dist\\cli.mjs` en el checkout del proyecto y se reutilizó su MCP ya activo en :3006. El ensayo creó/inició los relays llamando a `createAgent/startAgent` del mismo MultiAgentRunner; no se automatizaron las pulsaciones del menú TUI.',
    'Una repetición posterior para medir solapamiento de llamadas Bash de 8 s se detuvo en el preflight: `SessionBroker` informó que la Master `loco-verde` no estaba activa. El ensayo abortó antes de crear/iniciar agentes o enviar prompts; no es un fallo de MCP ni una prueba de concurrencia de herramientas.',
    'En la inspección final posterior, los puertos MCP :3006 y Master :9227 tampoco tenían listener; no se atribuye ese cierre a la prueba (el harness había abortado antes de lanzar Chrome). Confirmar servicios y autenticación de nuevo antes de otra prueba.',
    'Cada relay permaneció hidden/unfocused/minimized en 76/76 muestras; ambos probes de timer oculto dispararon, no se observó restauración de ventana, los lags diagnósticos máximos fueron 20 ms y 28 ms y ninguna fase requerida faltó. Las llamadas Read fueron muy rápidas y sus intervalos MCP no se solaparon: dispatch A 01:10:05.471–01:10:05.492Z, dispatch B 01:10:07.669–01:10:07.693Z. Esto demuestra generaciones paralelas y dos ciclos de herramienta ocultos, no ejecución simultánea de esos dispatches.',
    'Un intento previo de la prueba de concurrencia detectó una restauración de ventana a normal, aunque desenfocada, al comenzar una generación; se detuvo sin declarar éxito. En otra repetición ambos agentes pasaron el preflight, no hubo restauraciones y terminaron correctamente.',
    'Los dos relays concurrentes de la prueba PASS se detuvieron y :9222/:9223 quedaron cerrados; MCP :3006 y la Master dedicada :9227 permanecieron activos.',
    'Reporte del usuario (aún no correlacionado con telemetría): una instancia autenticada mediante Master `loco-verde` sigue requiriendo que el usuario visualice la ventana para que funcione el flujo de llamadas.',
    'Comprobación local de solo lectura posterior al reporte: MCP respondió en :3006, pero no había listener de `loco-verde` en :9227 ni relays CDP en 9222–9322; el único CDP activo encontrado fue :9402, registrado como Master Z.ai. No se pudo observar ni identificar la instancia descrita.',
  ],
  notProven: [
    'Que cada llamada y cada plataforma funcionen siempre en background, ni que el modelo emita siempre una respuesta final tras Auto Submit.',
    'Que el reporte reciente de dependencia de visualización ocurra en uno de los relays OpenMCP minimizados que dieron PASS; no había identidad/puerto CDP de esa instancia para correlacionarlo.',
    'Que el retraso de entrega al collector haya causado retraso en la ejecución MCP; las marcas de origen muestran que las fases MCP y entrega ocurrieron antes.',
    'Que estas ejecuciones expliquen de forma universal el error `An executionId or executionKey is required` en otras conversaciones o builds.',
    'Que el flujo de selección interactiva `/mcp set-mode web` produzca los mismos resultados sin interrupciones; la prueba de concurrencia usó las APIs de ciclo de vida subyacentes, no interacción de teclado con el TUI.',
    'Que dos ejecuciones MCP de larga duración se solapen: la prueba Read no produjo solapamiento de dispatch y el intento de Bash no pasó preflight por falta de una Master activa.',
  ],
  nextCheck: 'Antes de toda prueba, verificar que el MCP de OpenMCP responda en :3006 y que la Master autenticada esté activa; si falta cualquiera, abortar sin crear relays y no atribuirlo a Auto Execute/MCP. Distinguir la ventana Master (fuente de sesión) de la instancia Relay: confirmar el perfil desde el que se envía el prompt y asociar agentId→instanceId→puerto CDP. La Master `loco-verde` usa :9227; los relays administrados usan 9222–9322. Si no hay CDP/identidad para la instancia reportada, marcarla no observable, no inferir que la prueba anterior la cubre y no abrir la Master automáticamente. Para un FAIL/TIMEOUT, correlacionar primero el callId y ordenar eventos por timestamp de origen; medir por separado receivedAt−timestamp del collector. Si existe CDP, contrastar la copia durable en chrome.storage.local. Verificar estado visible/oculto y foco de cada muestra, creación de executionId, completion, inserción y submit. No marcar como fallo MCP por silencio del collector sin comprobar su retraso y no enviar otra llamada si la traza durable ya muestra dispatch. Reproducir el ingreso de usuario por `/mcp set-mode web` → Relay profiles → Agent mode → seleccionar ChatGPT, dos instancias y la misma Master Session autenticada; separar cualquier fallo del menú de un fallo de ejecución. Antes de probar solapamiento real de tools, comprobar que la Master está activa; si no, abortar sin lanzar instancias. Con Master activa, pedir a dos agentes una única tarea Bash inocua y acotada (por ejemplo PowerShell `Start-Sleep -Seconds 8; Write-Output TOKEN`), y exigir call IDs independientes, timestamps `MCP_DISPATCH_REQUEST`/`EXECUTION_COMPLETION` solapados y muestras hidden/unfocused por instancia. Distinguir solapamiento de generación del de dispatch MCP; la prueba Read anterior demostró lo primero pero no lo segundo. Para repetir fiabilidad o concurrencia efectiva de herramientas, no afirmar 100% basándose en una sola corrida PASS.',
} as const

export const CLAUDE_COMPACT_CONTROL_EVIDENCE = {
  id: 'claude-compact-control-preflight-2026-09-29',
  title: 'Claude: control compacto y preflight de SuperAssistant',
  date: '2026-09-29',
  conclusion: 'ClaudeAdapter montó el control compacto y el preflight explícito para claude pasó tras recargar; no se ejecutaron prompts ni herramientas.',
  observed: [
    'La inspección CDP de solo lectura encontró el editor visible `data-testid="chat-input"` y la acción `data-testid="chat-input-attach"`, pero inicialmente no encontró el control compacto; la sidebar sí estaba presente.',
    'Tras registrar ClaudeAdapter y reconstruir la extensión, Chrome desactivó la extensión desempaquetada porque Developer mode estaba apagado. Al habilitarlo y volver a habilitar la extensión en ese perfil Relay, la recarga de la página montó el botón con `data-adapter="ClaudeAdapter"`.',
    'El botón compacto quedó en la misma fila visual que el botón de adjuntos; el selector de Sentinel `#mcp-popover-container .mcp-main-button` lo detectó y la sidebar continuó presente.',
    'Al retirar el control del DOM, el observer lo volvió a montar junto al botón de adjuntos.',
    'Antes del preflight se abrió el popover sin cambiar toggles: MCP estaba activo y Auto Insert, Auto Submit y Auto Execute apagados; Agent mode (dynamic prompt) también estaba apagado.',
    'La preparación directa `prepareSAAgentForWebRelay(..., "claude")` seleccionó solo la pestaña Claude, configuró Streamable HTTP en :3006, recargó y pasó la verificación post-recarga. CDP confirmó después MCP, Push Content Mode, Auto Insert, Auto Submit, Auto Execute y sidebar activos; el composer seguía vacío.',
    'El MCP externo siguió disponible en :3006 con 23 tools registradas. El contador de conexiones es global y no se usó como prueba de que una herramienta concreta se ejecutara desde este Relay.',
    'En tres lecturas separadas, Windows mantuvo VS Code (PID 3864) como ventana foreground mientras el Relay Chrome (PID 2516) estaba maximizado, visible y no minimizado. La cadena Win32 de z-order puso explícitamente la ventana VS Code por encima de Chrome; ambas cubrían prácticamente el mismo rectángulo (-7..1374, 0..728).',
    'CDP `Target.activateTarget`/`Page.bringToFront` pudo dejar `document.hasFocus=true`, pero `document.visibilityState` siguió en `hidden`; `SetForegroundWindow` tampoco cambió la ventana foreground efectiva. Foco del documento no equivale a la pestaña visible en el escritorio.',
    'Antes de enviar una petición, `document.visibilityState="hidden"` hizo que se detuviera la prueba de respuesta. No se forzó `Page.setWebLifecycleState` ni se añadió `--disable-backgrounding-occluded-windows`, porque eso falsearía la condición de visibilidad que se quiere probar.',
  ],
  notProven: [
    'Que el flujo completo del wizard lance, prepare y retenga un Relay Claude de forma correcta.',
    'Que Claude emita una llamada MCP, que el observer la capture o que la ejecución reciba `executionId`/`executionKey`.',
    'Que una sesión Claude autenticada o la transferencia desde Master Session funcione end-to-end.',
    'Que Claude responda o ejecute una herramienta mientras el Relay permanece en segundo plano; esa prueba no se intentó.',
  ],
  nextCheck: 'Reanudar solo cuando la ventana Chrome Relay sea realmente foreground y CDP confirme `visibilityState="visible"`; entonces comprobar el wizard completo y ejecutar una prueba inocua de solo texto, sin herramientas. No interpretar foco como visibilidad.',
} as const

export const CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE = {
  id: 'claude-hidden-text-response-2026-09-29',
  title: 'Claude: salidas de UI con Relay oculto/desenfocado (ruta no correlacionada)',
  date: '2026-09-29',
  conclusion: 'La UI de Claude mostró respuestas y salidas etiquetadas como Bash con `visibilityState=hidden` y `hasFocus=false`, pero no se correlacionó su origen MCP ni la identidad. Son observaciones de UI, no prueba de continuidad MCP.',
  observed: [
    'En pantalla de 1366×768, Claude y VS Code se colocaron lado a lado sin forzar el estado de ciclo de vida de Chrome. CDP confirmó `visibilityState="visible"`; se insertó por CDP una petición explícita de solo texto/sin herramientas y Claude terminó respondiendo `LISTO`.',
    'Después, VS Code cubrió la ventana Chrome de Claude. Antes del envío, CDP confirmó `visibilityState="hidden"`, `document.hasFocus()=false` y composer vacío. La petición `OCULTO` se insertó y envió por CDP; durante la generación Claude permaneció `hidden` y terminó respondiendo `OCULTO` en aproximadamente 3 segundos.',
    'Al insertar y enviar por CDP, el documento pasó a `hasFocus=true` sin dejar de estar `hidden`. Para una solicitud separada, CDP confirmó antes del envío `visibilityState="hidden"` y `hasFocus=true`; la UI indicó que se ejecutó `Bash echo MCP_VISIBILITY_TEST` y mostró exactamente `MCP_VISIBILITY_TEST` en aproximadamente 5.4 segundos. La visibilidad se mantuvo `hidden` y no apareció `An executionId or executionKey is required`, pero no se identificó qué runtime produjo esa salida.',
    'El resultado visible no confirma Auto Execute ni despacho por el MCP local. El DOM no expuso atributos callId/executionId y la telemetría de esa sesión no tuvo eventos parser/start/getExecution, por lo que no se conoce el origen del Bash ni su identidad.',
    'Las entradas de prueba anteriores se enviaron mediante el composer usando eventos CDP; no se inyectó JSONL de llamada ni un ID de ejecución. El envío CDP enfoca el documento, por lo que esos turnos no prueban procesamiento desenfocado.',
    'La página mostró un diálogo modal `[role="dialog"]` titulado `Usa Opus 5.5 con Claude Pro`, con `Cerrar` y la opción `Ahora no`, después de las primeras llamadas completadas. Al reanudar la prueba se cerró mediante `Cerrar`; no se eligió el plan ni se atribuye el diálogo a interrupciones anteriores.',
    'Tras cerrar el diálogo por su botón `Cerrar`, se confirmó el toggle MCP activo y que el servidor `:3006` estaba healthy con 23 tools; eso no asocia una llamada de la página con ese servidor. Se envió una solicitud visible y luego Windows colocó VS Code foreground y Chrome detrás. CDP observó `visibilityState="hidden"`/`hasFocus()=false`; la UI mostró `Se ejecutaron 2 comandos` y las salidas `MCP_LINK_STEP_ONE` y `MCP_LINK_STEP_TWO` en ~5.1 s, sin error de identidad, pero no se obtuvo traza de origen.',
    'En otro turno bajo `hidden/false`, la tarjeta UI para `Bash echo MCP_LINK_REPEAT` mostró el comando completado y la salida. El composer quedó vacío y no había control de detener generación. El sondeo no encontró la frase literal `Claude terminó la respuesta`; la settlement de UI se observó, el origen de la herramienta no.',
    'Para probar el envío desde una página ya oculta, se preparó el composer visible, se minimizó Chrome y CDP confirmó `hidden`/`hasFocus()=false`, texto presente y botón habilitado antes de Enter. La UI devolvió `MCP_SEND_HIDDEN_UNFOCUSED`; luego `hasFocus()` pasó a true y la visibilidad siguió hidden. Esto confirma el estado inicial y la salida visible, pero no el origen MCP ni foco permanentemente ausente.',
    'Tras las tres rondas ocultas, `http://127.0.0.1:3006/status` seguía indicando `running=true` y `tools=23`. Su contador `connections` es global y no identifica ejecuciones individuales.',
    'La extensión del Relay tenía 46 diagnósticos locales (30 `RUNTIME_IDENTITY`, 16 `STREAM_MONITORING_STOPPED`) y ninguno de parser, Auto Execute, `START_EXECUTION`, `EXECUTION_CREATED` o `GET_EXECUTION`; no quedó trazado un `callId` ni presencia de `executionId`/`executionKey` para estas herramientas. No había listener en `:3011`, el colector configurado en el código.',
    'Se inició una copia aislada del colector en el directorio persistente de esta sesión y su prueba de humo fue aceptada. Después del turno `MCP_SEND_HIDDEN_UNFOCUSED`, recibió un `RUNTIME_IDENTITY` del service worker con build marker `openmcpweblock-source-dist-execution-trace-20260925-01`, pero 0 eventos de parser, Auto Execute, despacho MCP o creación/consulta de identidad. El colector sí pudo recibir al menos un evento de la extensión; la ausencia de telemetría de ejecución es específica de esa ruta observada.',
    'El colector anterior conserva `events.jsonl` de 7,081,710 bytes y un resumen de 16,995 eventos de una sesión anterior. No se reinició porque su script inicializa el log con truncado.',
    'El listener `:3006` pertenece a un proceso `bun.exe` PID 28232 iniciado el 2026-09-29 a las 02:12 hora local, muchas horas antes de estas pruebas. No se reinició para no interrumpir el servicio. No se confirmó qué versión de código está ejecutando ese proceso.',
  ],
  notProven: [
    'Que las salidas Bash visibles en estos turnos vinieran del MCP local, de SuperAssistant o de una herramienta integrada de Claude; ni el almacenamiento de la extensión ni el colector aislado recibieron eventos de ejecución en esa sesión.',
    'Que el flujo normal de inserción/Auto Submit de la extensión sea idéntico a enviar el mensaje desde el composer mediante Input CDP.',
    'Que la identidad interna `executionId`/`executionKey` en estas rondas exitosas sea la misma ruta/valor que faltaba cuando ocurrió el error.',
    'Que la oclusión de ventana sea la causa del error `An executionId or executionKey is required` en la conversación o plataforma donde ocurrió originalmente.',
    'Que esta observación en Claude garantice el mismo resultado para ChatGPT u otros perfiles.',
    'Que tres turnos exitosos garanticen continuidad sin interrupciones en sesiones prolongadas o ante suspensión/reinicio del service worker.',
    'Que el proceso MCP actualmente activo esté ejecutando el mismo código fuente y la misma instrumentación visibles en este worktree.',
  ],
  nextCheck: 'Sin reiniciar el MCP activo durante una sesión del usuario, identificar de forma segura qué código sirve el PID 28232 y por qué ni la extensión ni el colector aislado recibieron eventos de parser/despacho. En una ventana de mantenimiento acordada, actualizar el proceso si corresponde; luego capturar `START_EXECUTION`, `EXECUTION_CREATED`, respuesta de start, polling y entrega. Preservar los logs anteriores y no inferir continuidad indefinida.',
} as const

export const CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE = {
  id: 'claude-execution-identity-diagnosis-2026-09-30',
  title: 'Claude: llamada reportada y prompt de arranque pausado',
  date: '2026-09-30',
  conclusion: 'El usuario reporta una llamada real de SuperAssistant en una conversación anterior. En nuestro ensayo, la primera prueba Bash omitió Original y usó el Bash integrado; al enviar Original, el observer leyó el ejemplo placeholder y Claude pausó el turno. Ninguna de esas trazas reproduce el error original.',
  observed: [
    'El usuario informa que en una conversación previa Claude sí produjo una llamada real para SuperAssistant y entregó un prompt Original para usar. El reporte es evidencia de que el flujo pudo avanzar en otra sesión, pero no incluye telemetría correlacionada de parser, llamada al servidor, handle ni respuesta.',
    'Se consultó Claude en una conversación nueva y visible con un resumen técnico abstracto, sin enviar código ni credenciales. Claude propuso como hipótesis principal que el parser/render puede reconocer una llamada sin que el inicio cree o asocie un handle; también enumeró un bootstrap ausente y rutas/builds distintos como hipótesis, no como hechos.',
    'La primera prueba visible `SA_TRACE_PROBE_20260930` se hizo antes de insertar el prompt de arranque. Claude dijo que usó su `bash_tool` integrado, no MCP Bash. Se descarta como prueba del MCP local; la ausencia de un evento Bash del servidor es coherente con esa omisión.',
    'En un chat limpio se verificó `Prompt version=original`, se pulsó el botón `Insert` (no `Copy`) y el composer recibió 11,345 caracteres con la cabecera `[SuperAssistant Operational Instructions][IMPORTANT]`.',
    'Después de enviar el prompt Original como primer turno, Claude pausó la conversación con el aviso de seguridad `[reasoning_extraction]`. No se eligió continuar con otro modelo ni se alteró el prompt para eludir esa pausa.',
    'La traza del envío Original registró `JSONL_PARSER_OUTPUT` para `function_name` con parámetros placeholder, igual que el ejemplo incluido en el prompt; también registró `AUTO_EXECUTION_SCHEDULED`, `AUTO_EXECUTION_ATTEMPT` y `AUTO_EXECUTION_TRIGGERED`. Esto no fue una llamada de herramienta emitida por Claude.',
    'Para ese placeholder, el observer consultó la dirección determinista con `GET_EXECUTION_REQUEST`; el background respondió `not_found`. El handle/address de esa consulta estaba presente (`executionKeyPresent=true`), así que no reprodujo el error por handle vacío.',
    'El resumen del colector marca `START_EXECUTION_REQUEST` como primer evento esperado ausente después de `AUTO_EXECUTION_TRIGGERED`. Esto localiza una brecha para el falso positivo del ejemplo, pero no demuestra que sea la brecha de la llamada original.',
    'El colector aislado recibió eventos `MCP_TOOL_DISPATCHER_INPUT`/`MCP_TOOL_ADAPTER_ENTRY` para llamadas de control `WebSearch`/`WebFetch` que sí llegaron al servidor local; la llamada Bash previa al prompt se descarta porque Claude dijo que usó su herramienta integrada.',
    'En el código fuente local, `mcpClient.getExecution()` lanza exactamente `An executionId or executionKey is required` si su argumento `handle` es falsy. La ruta del botón inicia primero `mcpClient.startExecution()`, toma `execution.executionId` y después consulta `getExecution(executionId)`.',
    'El parser JSONL puede reconocer y extraer `function_call_start`, `call_id` y parámetros; esa observación por sí sola no prueba que el adaptador haya enviado `mcp:start-execution` ni que el background haya creado y devuelto un handle.',
    'El README upstream de SuperAssistant documenta el formato JSONL, pero su lista de plataformas no incluye Claude.ai. El formato existe, pero no certifica el flujo de ejecución MCP en esta integración Claude personalizada.',
  ],
  notProven: [
    'Que la llamada real reportada por el usuario ocurriera en el mismo perfil, build, conversación o ruta de ejecución que el error original.',
    'Que Claude haya emitido una llamada real MCP después del prompt Original: el turno quedó pausado por seguridad y el parser observó un ejemplo placeholder.',
    'Que la ausencia de `START_EXECUTION_REQUEST` para `function_name` explique el error original de handle vacío.',
    'Que la causa del error original sea falta de bootstrap, un handle no asociado o una ruta/build distintos.',
    'Que las otras respuestas Bash visibles anteriores fueran del Bash integrado o del MCP local; sin una traza asociada no se puede atribuir cada una.',
    'Que un éxito de Bash integrado valide SuperAssistant, el MCP local `:3006`, la creación de `executionId` o la entrega del resultado MCP.',
  ],
  nextCheck: 'No extrapolar la prueba `SA_TRACE_PROBE_20260930` al flujo MCP: se hizo sin Original. El ensayo con Original fue pausado por la salvaguarda de Claude; no cambiar de modelo ni modificarlo para saltar esa protección. El usuario reporta una llamada real en otra conversación; para localizar el error, hace falta correlacionar esa ruta o una repetición aprobada: parser → inicio → handle → getExecution → entrega.',
} as const

const diagnosis = (
  code: string,
  summary: string,
  nextCheck: string,
  confidence: SentinelExecutionFlowDiagnosis['confidence'] = 'observed',
): SentinelExecutionFlowDiagnosis => ({ code, confidence, summary, nextCheck })

export function diagnoseExecutionFlow(
  snapshot: SentinelExecutionFlowSnapshot,
): SentinelExecutionFlowDiagnosis {
  if (snapshot.requestSubmitted === false) {
    return diagnosis(
      'USER_REQUEST_NOT_SUBMITTED',
      'No se confirmó el envío de una solicitud nueva a ChatGPT.',
      'Verificar que el composer se vació y que el botón de envío inició un turno antes de revisar herramientas.',
    )
  }

  if (
    snapshot.requestSubmitted === true &&
    snapshot.turnSettled === true &&
    snapshot.assistantResponseObserved === false
  ) {
    return diagnosis(
      'MODEL_RESPONSE_NOT_OBSERVED',
      'La solicitud se envió, pero no se observó una respuesta de ChatGPT al terminar el turno.',
      'Comprobar sesión, generación y errores de la página; esto no demuestra que el foco sea la causa.',
      'inconclusive',
    )
  }

  if (
    snapshot.assistantResponseObserved === true &&
    snapshot.functionCallObserved === false
  ) {
    return diagnosis(
      'MODEL_DID_NOT_REQUEST_TOOL',
      'ChatGPT respondió, pero no emitió una llamada de herramienta en ese turno.',
      'Verificar intención de la petición, herramientas disponibles y formato emitido; no culpar a Auto Execute.',
    )
  }

  if (snapshot.autoExecuteEnabled === false) {
    return diagnosis(
      'AUTO_EXECUTE_DISABLED',
      'Auto Execute está desactivado; la llamada puede esperar una acción manual.',
      'Verificar el toggle persistido de SuperAssistant y escanear el perfil otra vez.',
    )
  }

  if (snapshot.matchingVisibleExecuteButton === false) {
    return diagnosis(
      'EXECUTABLE_TARGET_NOT_VISIBLE',
      'No hay un control Run habilitado en una tarjeta visible que coincida con la llamada.',
      'Esperar a que termine el renderizado; no crear un claim ni pulsar una tarjeta oculta.',
    )
  }

  if (snapshot.claimCreated === true && snapshot.executionTriggered === false) {
    return diagnosis(
      'CLAIM_WITHOUT_DISPATCH',
      'Hay un claim, pero no consta el despacho de la herramienta; el claim por sí solo no demuestra ejecución.',
      'Comparar AUTO_EXECUTION_TRIGGERED y el estado del claim; liberar solo claims propios no despachados.',
    )
  }

  if (snapshot.executionTriggered === true && snapshot.executionIdentityPresent === false) {
    return diagnosis(
      'EXECUTION_IDENTITY_MISSING',
      'La herramienta fue despachada sin executionId ni executionKey; la capa MCP no recibió identidad de ejecución.',
      'Seguir el evento start-execution y el request a getExecution; no inventar identidad en el prompt.',
    )
  }

  if (snapshot.executionStatus === 'error' || snapshot.executionStatus === 'missing') {
    return diagnosis(
      'MCP_EXECUTION_NOT_SUCCESSFUL',
      'La identidad llegó a la capa de ejecución, pero no hay un resultado MCP exitoso.',
      'Revisar el resultado de la ejecución y el error del servidor antes de cualquier reintento.',
    )
  }

  if (snapshot.executionStatus === 'success' && snapshot.resultInserted === false) {
    return diagnosis(
      'RESULT_NOT_INSERTED',
      'MCP terminó correctamente, pero Auto Insert no confirmó la inserción del resultado.',
      'Revisar RESULT_INSERTION_FAILED, el composer visible y la respuesta del adaptador.',
    )
  }

  if (
    snapshot.executionStatus === 'success' &&
    snapshot.diagnosticTransportLagMs !== undefined &&
    snapshot.diagnosticTransportLagMs !== null &&
    snapshot.diagnosticTransportLagMs > 30_000
  ) {
    return diagnosis(
      'EXECUTION_DIAGNOSTICS_DELAYED',
      `MCP terminó correctamente, pero el collector recibió diagnósticos con ${Math.round(snapshot.diagnosticTransportLagMs / 1000)} s de retraso; el timeout del collector no significa que falló la ejecución.`,
      'Ordenar por timestamp de origen, comparar con receivedAt y revisar la traza durable en chrome.storage.local antes de repetir la llamada.',
      'inconclusive',
    )
  }

  if (snapshot.resultInserted === true && snapshot.autoSubmitEnabled === false) {
    return diagnosis(
      'RESULT_WAITING_FOR_USER_SUBMIT',
      'El resultado se insertó, pero Auto Submit está desactivado; se espera envío manual.',
      'Enviar el resultado desde el composer si se desea que ChatGPT continúe.',
    )
  }

  if (snapshot.resultInserted === true && snapshot.autoSubmitEnabled === true && snapshot.resultSubmitted === false) {
    return diagnosis(
      'AUTO_SUBMIT_NOT_CONFIRMED',
      'El resultado se insertó, pero no se confirmó el envío automático.',
      'Comprobar botón habilitado, submitForm y confirmación de que ChatGPT empezó a generar.',
    )
  }

  if (
    snapshot.resultSubmitted === true &&
    snapshot.assistantResponded === false &&
    snapshot.executionStatus === 'success' &&
    snapshot.resultInserted === true &&
    snapshot.visibility === 'hidden' &&
    snapshot.focus === 'unfocused' &&
    snapshot.userIntervention === 'not-observed'
  ) {
    return diagnosis(
      'UNATTENDED_TOOL_DELIVERY_VERIFIED',
      'La ejecución MCP y la entrega automática se completaron hidden/unfocused; no se capturó la respuesta final posterior del modelo.',
      'Conservar la traza de ejecución y ampliar la captura hasta la respuesta final antes de declarar verificado el ciclo conversacional completo.',
      'inconclusive',
    )
  }

  if (snapshot.resultSubmitted === true && snapshot.assistantResponded === false) {
    return diagnosis(
      'MODEL_DID_NOT_CONTINUE',
      'El resultado se envió a ChatGPT, pero no se observó una respuesta final.',
      'Comprobar el estado de generación y la sesión; no reenviar la llamada MCP a ciegas.',
    )
  }

  if (
    snapshot.assistantResponded === true &&
    snapshot.visibility === 'hidden' &&
    snapshot.focus === 'unfocused' &&
    snapshot.userIntervention === 'not-observed'
  ) {
    return diagnosis(
      'UNATTENDED_FLOW_VERIFIED',
      'La llamada, la entrega y la respuesta final se completaron sin foco ni intervención observada.',
      'Conservar la secuencia de eventos y repetirla en otra sesión antes de tratarla como garantía general.',
    )
  }

  if (
    snapshot.userIntervention === 'occurred' &&
    (snapshot.executionStatus === 'success' || snapshot.resultInserted === true)
  ) {
    return diagnosis(
      'FOCUS_INDEPENDENCE_UNPROVEN',
      'Se observaron etapas del flujo MCP, pero hubo intervención del usuario; la independencia del foco no está demostrada.',
      'Completar la captura de la respuesta final y repetir con una petición nueva, pestaña oculta y desenfocada desde antes del envío.',
      'inconclusive',
    )
  }

  return diagnosis(
    'EXECUTION_FLOW_INCOMPLETE',
    'La evidencia disponible no cubre todas las etapas necesarias para concluir el flujo.',
    'Capturar eventos desde la llamada del modelo hasta la respuesta final y registrar foco e intervención.',
    'inconclusive',
  )
}

export const CHATGPT_AUTO_EXECUTION_DIAGNOSIS = diagnoseExecutionFlow({
  requestSubmitted: true,
  assistantResponseObserved: true,
  functionCallObserved: true,
  turnSettled: true,
  autoExecuteEnabled: true,
  matchingVisibleExecuteButton: true,
  claimCreated: true,
  executionTriggered: true,
  executionIdentityPresent: true,
  executionStatus: 'success',
  resultInserted: true,
  autoSubmitEnabled: true,
  resultSubmitted: null,
  assistantResponded: null,
  visibility: 'unknown',
  focus: 'unknown',
  userIntervention: 'occurred',
})
