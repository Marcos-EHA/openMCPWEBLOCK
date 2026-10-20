# Acta 002 - Arranque de Masters, plantilla de SuperAssistant y diseño del protocolo

Fecha: 2026-10-19
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que el acta 001. Una acción por turno.
Último número de llamada usado antes de esta acta: 59.
Relación: complementa el acta 001 sin modificarla. Sus correcciones están en la sección 5.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?].
Convención: [C] comprobado en el código (archivo:línea), [I] inferido, [R] corregido, [?] sin verificar.
Aviso: este texto no cita a propósito la cabecera literal de la plantilla de SuperAssistant (ver sección 3).

## 1. Quién recibe el mensaje de rol
- [C] src/services/webRelay/WebRelayProvider.ts:1520 (verifyWebRelayStartup) exige instancia registrada, puerto, rol explícito y SuperAssistant ya preparado; envía el mensaje por handleSAMode (:1229).
- [C] Solo se invoca desde src/services/webUI/launchAgents.ts:271 y :448; en el contexto leído de :271 está dentro de un bloque condicionado a que el propósito sea agent. El resto de usos son pruebas.
- [C] sendWebPromptToMaster (WebRelayProvider.ts:1572) y src/services/webRelay/session/MasterSessionConversation.ts no llaman a esa verificación.
- [I] Una Master y el modo usuario no reciben el mensaje de rol. Sin probar en ejecución.

## 2. Qué recibe una Master en cada envío
- [C] MasterSessionConversation.ts:22-87 (sendMasterSessionPrompt): normaliza el prompt, le añade la instrucción de contexto (vacía salvo que webRelaySaveCleanContext sea true), anota en el diario un agent-task con taskId, agentId master-session:ID y plataforma, busca el puerto activo, comprueba la sesión autenticada, envía con sendWebPromptToMaster y anota la respuesta o el error.
- [C] Ese mismo punto atiende los mensajes directos de la interfaz y los del coordinador (integration.ts:788 y :866).
- [C] En ese registro no se pasa conversationId ni sessionMode: la identidad de chat de una Master es hoy solo el id de su fuente.
- [C] sendWebPromptToMaster prepara SuperAssistant en el puerto en cada envío y llama a handleSAMode con rawTools vacío y respuesta directa de la instancia.
- [I] formatSuperAssistantPrompt se aplica en WebRelayProvider.ts:1266 con las herramientas de getSuperAssistantPromptTools (:1265). Con rawTools vacío el respaldo son 7 herramientas (leer, listar, patrón, texto, comando, editar, escribir), sin las de colaboración. Falta leer :1260-1275 [?].

## 3. La plantilla de capacidades
- [C] src/services/webRelay/WebToolBridge.ts:121 (formatSuperAssistantPrompt) arma: cabecera de instrucciones, bloque system, protocolo de llamadas en JSONL, herramientas en XML (formatToolDefinitions, :77) y al final el prompt del usuario. Sin herramientas omite la lista XML.
- [C] Es idempotente: si el texto ya contiene la cabecera de la plantilla o el arranque de su bloque system, lo devuelve intacto (:134-139). Consecuencia: un texto que cite esa cabecera literal desactiva la plantilla. Por eso las actas la parafrasean.
- [C] Contenido: las herramientas operan en la máquina local con el alcance de su esquema; analizar solo la ruta pedida; no leer .env ni credenciales sin petición expresa; el observador ejecuta una llamada válida y se espera su resultado.
- [C] Su protocolo habla de evento de inicio con nombre y call_id, un evento por parámetro y evento de cierre. No vi mención de la línea de descripción ni de numerar call_id desde 1, que sí pide el archivo de instrucciones del usuario. Puede estar en un tramo no leído; no sé si el observador la exige [?].
- [C] src/services/collaboration/CollaborationPrompt.ts:80 también la usa.

## 4. Límite de truncado de salidas
- [I] Ni src ni superassistant-proxy.config.json contienen el esquema execution-result ni claves de límite, y los .ps1/.mjs/.js de la raíz no mencionan truncado. El recorte parece estar en la extensión o en el proxy; no se abrió código de ahí.
- [?] MAX_TOOL_OUTPUT_CHARS=10000 existe en WebToolBridge.ts; no sé si aplica a este canal.
- [C] chrome-extension/source contiene un archivo .env (no abierto; no abrir), y las carpetas pages y packages.

## 5. Correcciones
- [R] El acta 001 dice Fecha 2026-10-18; la fecha de la sesión es 2026-10-19.
- [R] La 001 (sección 4) lo daba por inferido: ahora [C] por llamadores que una Master no recibe el mensaje de rol.
- [R] Se afirmó que la verificación de arranque cubría a las Masters; no es así (sección 1).
- [R] Las búsquedas recursivas con comodines desde la raíz del repo (node_modules, perfiles de Chrome) provocaron el timeout -32001 [I]. Regla: limitar a src o a archivos de la raíz, y no entrar en chrome-profile-*.
- [I] Los símbolos raros en algunas salidas parecen un problema de codificación de la consola de Windows.
- Git: .openmcp aparece sin seguimiento y ninguna regla la ignora. Las actas incluyen una sección de seguridad: decisión pendiente del usuario.

## 6. Diseño: protocolo de arranque para una Master (propuesta, nada implementado)
- Enganche: sendMasterSessionPrompt, porque centraliza todos los envíos a Masters, anota en el diario y admite dependencias inyectadas (más fácil de probar).
- Dos partes: (a) identidad y rol sellados por el sistema (fuente, plataforma, modo y conversación si se conoce); (b) resumen del proyecto tomado de las actas aprobadas, con tamaño acotado. Lo aprobado por el usuario va como instrucciones; lo escrito por una IA, como dato.
- El mensaje de rol actual pide solo un JSON de confirmación y prohíbe ejecutar herramientas: el resumen va en un segundo mensaje.
- El resumen no debe contener la cabecera literal de la plantilla (sección 3).
- Sin resolver: distinguir el primer envío de una conversación reanudada. Hoy no hay marca de arranque y el diario de Masters no guarda conversationId. Opciones: marca por fuente en la configuración del proyecto, o consultar el diario. Sin decidir.
- Almacén de notas: archivos de solo añadir en .openmcp/project-notes con cabecera de identidad; la interfaz los listaría con estado y aprobación. La versión 1 es lo que ya hace esta carpeta, más lectura en la interfaz.
- Límite de longitud de un prompt a una Master: desconocido [?]. El envío a instancias del workspace admite 8000 caracteres; el valor de MAX_AGENT_TASK_LENGTH no se ha visto.

## 7. Pendiente
- Leer WebRelayProvider.ts:1260-1275 para confirmar la plantilla en el camino de Masters.
- Listar quién llama a sendMasterSessionPrompt y ver MAX_AGENT_TASK_LENGTH.
- Interfaz: WebUIServer.ts:831 y workspace.html como punto para el apartado de proyectos (no leídos).
- Decisiones del usuario: aprobar las actas, .gitignore, delegación (en pausa) y consumidor de peticiones pendientes.
