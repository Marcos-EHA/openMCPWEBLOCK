# Acta 003 - Almacén de chats por instancia, estado del repositorio y correcciones

Fecha: 2026-10-19
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 y 002. Una acción por turno.
Último número de llamada usado antes de esta acta: 66.
Relación: complementa las actas 001 y 002 sin modificarlas. Sus correcciones están en la sección 3.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado en el código (archivo y función), [I] inferido, [R] corregido, [?] sin verificar. Las líneas se mueven: anclar a nombres de función y a la fecha de modificación.
Aviso: este texto no cita a propósito la cabecera literal de la plantilla de SuperAssistant.

## 1. Estado del repositorio
- [C] git status en src muestra más de 100 archivos rastreados modificados y muchos sin seguimiento. La salida se truncó: solo vi una parte [?].
- [C] Sin seguimiento y sin commits (visto en la parte no truncada): src/services/webUI/integration.ts, src/commands/mcp/workspaceCommand.ts, src/services/webRelay/StartupHandshake.ts, launchPolicy.ts, WorkspaceContextJournal.ts, WebRelayCoordinator.ts, y las carpetas src/services/collaboration y src/services/localInstances. Consecuencia: git no puede recuperarlos si se pierden. Decisión del usuario: commit o copia.
- [C] .openmcp aparece sin seguimiento y ninguna regla la ignora (ya dicho en el acta 001).
- [C] Fechas medidas el 19/10/2026 a las 19:44: integration.ts modificado el 18/10/2026 01:44, con 69.350 bytes y 1560 líneas; WebRelayProvider.ts modificado el 19/10/2026 a las 19:32. Al menos 15 archivos ajenos de src comparten la hora 19:40 [I: operación masiva de git, formateador, sincronización o compilación; el listado se recortó a 15].
- [?] Discrepancia no resuelta: al inicio de la sesión el listado de la carpeta daba 62.302 bytes para integration.ts y sus líneas estaban unas 154 más arriba (envíos a Master en 788 y 865; ahora en 942 y 1019). No sé si el archivo cambió durante la sesión, si se restauró conservando la fecha o si las medidas no son comparables.
- Regla: las notas citan archivo, función y fecha de modificación; el número de línea es solo orientativo.

## 2. Almacén de chats por instancia
- [C] src/services/webUI/WorkspaceInstanceChatStore.ts: clase WorkspaceInstanceChatStore e instancia única workspaceInstanceChatStore. Solo la usa integration.ts (onInstanceChatHistory y onInstanceChatSend).
- [C] Cada mensaje tiene id, instanceId, conversationId, rol (user, assistant, status o error), texto, hora y modelo opcional. instanceId admite hasta 150 caracteres y conversationId hasta 200.
- [C] Límites: 1000 mensajes en total, 200 por conversación y 50.000 caracteres por mensaje. Al superarlos se recorta el historial (trimHistory y persist); no leí el detalle del recorte [?].
- [C] Persistencia: archivo .jsonl en %LOCALAPPDATA%/openMCPWEBLOCK/workspace-instance-chats/ con nombre igual a un hash de 20 caracteres de process.cwd(). Añade por línea (appendFile) y compacta con archivo temporal y renombrado. Pide modo 0o600; en Windows no sé qué efecto real tiene [?]. El contenido es texto plano.
- [I] Como la clave usa process.cwd() y el diario de contexto usa getProjectPathForConfig, si ambas rutas difieren habría almacenes distintos. No comprobado.
- [C] onInstanceChatSend: el conversationId pedido, o main si no llega. Una instancia con id que empieza por master-session: se trata como Master; si no, se busca una instancia local y luego un Relay listo. Registra primero el mensaje del usuario. Si la instancia local devuelve un id real para un chat nuevo, se mueve la conversación a ese id. En la rama de Master no vi que se asigne un id real.
- [C] Estados: entrega submitted o unknown, respuesta received o pending. Una conversación ocupada rechaza otro envío (activeInstanceChats por instancia y conversación). Master usa sendMasterSessionPrompt, Relay usa sendWebPrompt, local usa sendLocalPrompt.
- [I] Varios chats reales de una misma Master quedarían mezclados bajo main.
- [?] No leí si la respuesta de la Master se guarda en este almacén (el bloque leído termina cerca de la línea 440).

## 3. Correcciones
- [R] Acta 002, sección 2: la identidad de chat de una Master no es solo el id de su fuente. Eso vale para el diario de contexto. A nivel de workspace existe el par instanceId y conversationId, con main por defecto en las Masters.
- [R] Acta 002, sección 7, pendientes que se cierran: sendMasterSessionPrompt tiene cinco puntos de entrada (el gestor de Master de la línea de comandos MasterSessionManager.tsx, la herramienta de envío con aprobación del workspace y tres en integration.ts). MAX_AGENT_TASK_LENGTH vale 12.000 en WebRelayCoordinator.ts; si aplica a envíos directos a una Master no lo sé [?]. /api/canvas entrega hallazgos y peticiones pendientes a la interfaz; no vi si exige validación de origen [?].
- [C] La plantilla de capacidades se aplica a todos los envíos a una Master (handleSAModeWithAccess la aplica y la escribe en la página por CDP). El acta 002 lo tenía como inferido.
- [R] Dije que alguien editaba WebRelayProvider.ts mientras trabajábamos. No se sostiene: otros archivos comparten la misma hora, lo que apunta a una operación masiva.
- [R] Dije que no había almacén de identidad de chat más allá del diario; sí existe el de esta sección.

## 4. Diseño (propuesta, nada implementado)
- Identidad de chat en las notas: reutilizar el par instanceId y conversationId y los campos del diario (plataforma, agente, modo de sesión). No inventar campos nuevos.
- Las notas del proyecto no deben vivir en el almacén de chats por sus límites y su recorte. Mantener archivos de solo añadir en .openmcp/project-notes y que la interfaz los liste. Decidir si se versionan y si .openmcp se mueve a otra ruta.
- Un conversationId real para una Master requiere que el sistema lo observe (por ejemplo desde la página del chat). Hoy no existe; no sé si la plataforma lo expone [?].
- Resumen de arranque de una Master: segundo mensaje, tamaño acotado (conservador: hasta unos 8.000 caracteres, el menor de los límites vistos), con lo aprobado por el usuario como instrucciones y lo escrito por una IA como dato.

## 5. Pendiente
- Leer WorkspaceInstanceChatStore.ts desde la línea 80 hasta el final (recorte y escritura).
- Leer onInstanceChatSend de integration.ts a partir de la línea 440 (respuesta y cierre en la rama de Master).
- Ver cómo la interfaz (workspace.html y workspaceLayout.js) muestra y lista el chat de una instancia.
- Comprobar qué ruta usan process.cwd() y getProjectPathForConfig al lanzar desde /mcp workspace.
- Decisiones del usuario: aprobar las actas, commit o copia de los archivos sin seguimiento, .gitignore, delegación (en pausa) y consumidor de peticiones pendientes.
