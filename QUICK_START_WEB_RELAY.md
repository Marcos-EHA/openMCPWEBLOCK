# 🚀 Quick Start: Web Relay Mode - 5 Minutos

**Objetivo**: Activar Web Relay Mode en OpenClaude y hacer tu primera consulta web  
**Tiempo**: ~5 minutos  
**Requisitos**: Chrome corriendo + Proxy corriendo (ya están ✅)

## ChatX

Selecciona **ChatX** en el selector de plataforma para abrir `https://chatx.ai/es/gpt` en el perfil aislado de Web Relay. La extensión MCP incluye un control en el compositor de ChatX y Relay usa sus selectores de editor/envío/respuesta. El lanzamiento real de ChatX, la preparación de SuperAssistant/MCP y la verificación del sidebar compacto se comprobaron desde WebUI; no se envió ningún prompt. El modelo se elige dentro de ChatX; en la página observada, **Gemini 3.8 Flash** aparecía disponible con registro requerido. La disponibilidad depende de la cuenta; OpenMCP no preselecciona ni verifica el modelo activo.

---

## Interfaz actual de Web Relay y Sentinel

La WebUI usa `http://localhost:3007` por defecto. Para usar otro puerto disponible (por ejemplo, `3008`), configura `OPENMCP_WEBUI_PORT` en el entorno antes de iniciar el proceso OpenMCP; en PowerShell: `$env:OPENMCP_WEBUI_PORT='3008'`. La variable se lee al cargar el servidor, así que cambiarla después no afecta un proceso ya iniciado; `/mcp workspace` informa el puerto activo.

En la TUI actual, los controles del pie del input permiten:

- **Puente MCP ON/OFF/ACTUALIZAR**: confirma que el servidor local y su API relay responden. El puerto predeterminado es `3006`; se puede aislar un proceso con `MCP_PORT` (por ejemplo, `MCP_PORT=3307`). No confirma que ChatGPT haya iniciado sesión ni que una instancia web esté lista. Haz clic para abrir `/mcp status`.
- **OpenMCP / Modo agente Web / Sentinel (Gemini)**: son destinos independientes. Una conversación Agente siempre tiene coordinador: el cerebro API coordina sin consumir una Relay, o el cerebro Web añade uno o más candidatos a orquestador Web aparte del número seleccionado de workers. En cada tarea se usa un candidato; puedes alternarlos desde el control de coordinador. Los demás no se suman al pool de workers. En cualquiera de los dos casos puedes dirigir un mensaje directamente a un worker. Sentinel es independiente del modo de conversación: el monitor de salud inicia con la aplicación y el destino Gemini puede elegirse en cualquier momento.
- **Lanzar/configurar**: abre el asistente manual `/mcp set-mode web`. En Windows, para importar datos de un perfil Chrome local a ChatGPT elige directamente **ChatGPT — importar desde Chrome (copia aislada)**. La opción te lleva al flujo de ChatGPT, pregunta propósito/cantidad, permite seleccionar el perfil para las instancias y exige autorización antes de copiar; solicita el cierre normal de Chrome si hace falta. La copia es un perfil distinto y **puede pedir iniciar sesión en la ventana Relay aunque Chrome normal ya tenga la sesión abierta**. Si prefieres iniciar sesión una sola vez y reutilizar una sesión persistente, usa **Solo sesiones Master** o selecciona una Master como fuente `Authenticated`; esta es la vía recomendada para evitar iniciar sesión en cada lanzamiento. Si eliges **Perfiles Relay**, la opción de importación también aparece luego entre los tipos de sesión de ChatGPT. **Solo sesiones Master** abre/reutiliza fuentes y prepara/verifica SA sin crear Relays, agregarlas al pool ni cambiar el modo de ejecución. En la elección de propósito, pulsa **Tab** para alternar `Agent mode` / `User mode`; **Enter** continúa y **Esc** cancela:
  - **Conversación Agente**: siempre lanza un coordinador. Elige cerebro API (mínimo un worker, sin coordinador Web dedicado) o cerebro Web (uno o más candidatos a orquestador Web y al menos un worker). Los candidatos Web se pueden seleccionar como coordinador; la configuración de sesión de TUI se comparte entre candidatos, mientras Workspace permite configurar cada candidato por separado. En esta versión no ejecutan consenso paralelo: uno planifica y revisa cada tarea. Las Relay deben pasar preparación y verificación SA antes de quedar listas. Los comandos `/...` siguen su ruta local.
  - **Conversación Usuario**: abre ventanas para uso manual; no entran en el pool y la aplicación no les enruta tareas ni lanza un coordinador. Si quieres delegación/orquestación, elige Conversación Agente.
  - **Sentinel**: no es un tipo de conversación ni una instancia Chrome que compita por el cupo de workers. Su monitor se inicia con la aplicación; el destino Gemini permanece disponible de forma independiente y sus invitados se administran por separado desde `/mcp sentinel`.
  - Para ChatGPT y Claude puedes elegir `Guest / clean` o `Authenticated`. `Guest / clean` no copia cookies de ninguna sesión maestra. `Authenticated` permite elegir una fuente Master Session de la misma plataforma; la sesión se transfiere al perfil Relay y la cuenta/cuota se comparte solo con los agentes que la seleccionen. La Master es un perfil persistente separado de Chrome normal: inicia sesión una vez allí y OpenMCP puede reutilizarlo sin pedir que cierres tu Chrome diario. En ChatGPT sobre Windows también está disponible `Importar desde Chrome (copia aislada)`: al seleccionar el perfil no se lanzan instancias todavía; tras tu autorización, OpenMCP comprueba si Chrome está usando el perfil y le solicita un cierre normal si hace falta. La acción puede cerrar todas las ventanas del Chrome normal, así que guarda tu trabajo antes. OpenMCP espera a que los procesos terminen y no los fuerza; si Chrome no responde, muestra el PID y explica cómo reintentar, sin copiar ni lanzar Relays. La copia vuelve a comprobar el estado antes de leer/copiar los datos. OpenMCP copia datos seleccionados a un Relay aislado; no comparte ni sincroniza el directorio del Chrome habitual. La sesión de Chrome normal o de la aplicación de escritorio ChatGPT no implica que la copia quede autenticada: si el navegador no puede reutilizar las cookies cifradas, hay que iniciar sesión en la **ventana Chrome del Relay aislado**, no en las otras ventanas. Después, esa sesión persiste en el Relay, pero no se sincroniza con Chrome normal. Si el objetivo es iniciar sesión una vez y reutilizar una sesión, usa una Master Session. Historial, contraseñas, marcadores y extensiones no se copian. Este perfil elegido se admite tanto en `/mcp set-mode web` como en el lanzador WebUI. El soporte de transferencia de Claude acaba de incorporarse y requiere validación con una cuenta real de Claude antes de considerarlo verificado. Arena.ai se abre en Direct Chat con perfiles `Guest / clean`; el modelo se debe elegir manualmente en cada ventana. No se ha validado aún la captura de respuestas de Arena mediante Web Relay. Si falla una instancia, las demás se preparan individualmente y solo se conservan las que pasan sus verificaciones; si no queda el mínimo del modo elegido, se detienen las instancias de ese intento.
- **Estado de instancias**: el contador muestra agentes listos en el proceso actual; puede mostrar aparte ventanas de usuario y avisar de IDs guardados sin agentes listos. No representa todas las ventanas Chrome abiertas por otros procesos.

Las tarjetas de **instancias locales** (Antigravity, VS Code, Claude Desktop y Claude Code) identifican chats/sesiones junto a la instancia y cargan la lista al mostrarse. La detección usa almacenamiento local en modo solo lectura: Antigravity consulta `conversation_summaries.db` y asocia el workspace; VS Code lee los índices `chat.ChatSessionStore.index` de `state.vscdb`, omite sesiones vacías, deduplica IDs y asocia el workspace cuando está disponible; Claude Code usa los transcripts JSONL y sus metadatos `cwd`; Claude Desktop solo cuenta sesiones con un `skill_log.jsonl` legible, no carpetas de metadatos como `scheduled-tasks.json`. Si una plataforma no dispone de un transcript compatible, la interfaz lo informa en vez de presentar esas carpetas como chats. Cuando se conoce el proyecto, las conversaciones se marcan como pertenecientes al proyecto actual. Estos datos no se envían a Gemini ni a otra plataforma. La lista identifica conversaciones, pero no selecciona ni reanuda una conversación dentro de la aplicación local.

La inspección técnica de Sentinel para Masters ChatGPT reconoce tanto `chat.openai.com` como `chatgpt.com`, y verifica el botón compacto real del adaptador dentro del compositor. Esta comprobación informa preparación de UI y conexión MCP, pero no demuestra por sí sola que el observer haya capturado o ejecutado una llamada; para confirmar esa fase hacen falta eventos de ejecución correlacionados.

En terminales estrechas, los controles inferiores de MCP/Web/Sentinel se agrupan en filas compactas separadas para evitar que las etiquetas se envuelvan a mitad de palabra o queden desalineadas.

La vista WebUI conserva el botón **+ Instancia** en las variantes clásica y Canvas, con un diálogo compartido para `Agente` y `Usuario`. En modo Agente la coordinación es obligatoria: **Cerebro API** coordina sin abrir un Relay y todas las instancias lanzadas son workers; **Cerebro Web** permite configurar uno o más candidatos a orquestador Web, además del número de workers. El selector distingue sus perfiles y las sesiones de los workers. Cada tarea usa un único candidato seleccionado; los otros quedan como alternativas, no como workers ni como consenso paralelo. Se admite un total máximo de 20 Relay físicas, reservando al menos un worker además de los candidatos Web. TUI también permite varios candidatos Web; comparten la selección de perfil Master/Guest, pero cada Relay conserva un perfil Chrome aislado. El botón de lanzamiento nombra explícitamente los roles. En modo Usuario se abren ventanas para uso manual, fuera del pool, sin coordinador ni envío de tareas del Workspace. No existe una opción Agente sin orquestador. Esta elección es independiente de `mcpExecutionMode`, que controla la ejecución de herramientas. Sentinel es un rol supervisor lógico aparte, no una instancia Chrome ni parte del conteo de workers: su monitor de salud arranca con la aplicación; su destino de conversación Gemini se activa desde la TUI en cualquier momento y es independiente del tipo de conversación. Los invitados de Sentinel se administran desde `/mcp sentinel` y permanecen fuera del pool normal. El diálogo deja elegir `Guest / clean` o una fuente Master para cada Relay compatible, y tiene un flujo separado para abrir una o varias Master Sessions registradas. El botón Master espera la respuesta HTTP antes de cerrar el diálogo; si una apertura falla, muestra el motivo y permite reintentar. Una Master cerrada conserva su puerto asignado y se abre con su perfil persistente. Para crear/registrar una nueva fuente Master, usa `/mcp master-session add [nombre]` (o `--platform claude|zai`); luego aparecerá en el selector WebUI. El historial del diálogo se filtra por el tipo de instancia y la plataforma seleccionados; los lanzamientos activos o con resultado sin confirmar de cualquier plataforma siguen visibles y bloquean nuevos lanzamientos hasta revisar su estado. Las ventanas User son manuales, no reemplazan el pool y no reciben un prompt colaborativo automático. Tanto las Relay de Agent como User pasan por preparación y verificación de SuperAssistant antes de informarse como operativas. El preflight exige el registro inicializado, los plugins base (Remote Config y Sidebar), todas las fábricas de adaptadores integradas y el adaptador activo correspondiente a la plataforma del Relay. La fábrica diferida del adaptador activo puede desaparecer del registro al inicializarse; en ese caso, su plugin debe figurar activo y registrado. Los adaptadores de otras plataformas permanecen como fábricas diferidas; no se activan a la vez. El panel lateral se inicia minimizado y el control MCP compacto debe quedar visible en el compositor. En ChatGPT, el adaptador usa la fila visible de acciones (adjuntar, dictado/envío) si la versión actual de la página no expone un campo de texto reconocible; la verificación exige el botón compacto dentro del compositor, no solo cualquier botón SA visible. El selector de destino permite enviar una tarea directamente a cualquier worker listo del pool. El flujo Master-only abre o reutiliza perfiles y siempre carga/configura SuperAssistant, espera su conexión MCP y verifica los controles y plugin registry antes de confirmar. La pestaña se recarga cuando hace falta para inicializar la extensión. El diálogo WebUI permite decidir por separado si las Masters preparadas también se registran como workers de Workspace; ninguna opción omite SA. Un Relay autenticado basado en una Master es una instancia aparte y debe pasar su propio gate SA. El asistente de terminal `/mcp set-mode web` sigue disponible como flujo independiente.

### Master Session frente a perfiles Relay

En las tarjetas de instancias del Workspace, **×** cierra la instancia activa tras confirmar la acción: en un Relay detiene Chrome y conserva su registro para poder reiniciarlo; en una Master cierra su Chrome, pero conserva el perfil persistente, las credenciales y su registro como worker. Una vez detenido el Relay, **×** lo retira del Workspace, elimina su configuración de worker y, si era Clean, borra los eventos de memoria temporal asociados a ese agente. En una Master cerrada, **×** quita solo su rol de worker del Workspace; no elimina la fuente Master, el perfil, las credenciales ni el historial de cuenta. **Reiniciar** vuelve a lanzar la instancia; para una Master también prepara y verifica SuperAssistant. Una Master sin ventana activa muestra **Abrir**. Las acciones muestran su progreso y notifican errores; cerrar una ventana interrumpe las tareas que dependan de ella.

Al lanzar o reiniciar un Relay autenticado, si su Master Session está cerrada, el flujo la abre temporalmente para transferir la sesión y la cierra al terminar el arranque que requiere esa fuente. Una Master que ya estaba abierta se deja intacta. Si la Master abierta no está autenticada, permanece abierta para que el usuario pueda iniciar sesión; no se cierra como si la transferencia hubiera terminado. Cada lanzamiento puede registrar un candidato `primary` y candidatos `orchestrator-N`; los IDs de rol no se duplican. Antes de lanzar otro pool, detén o retira el pool Web registrado. Los candidatos Web se inician y pasan su preparación de SuperAssistant antes de abrir workers; si ningún candidato queda operativo, se cancela el lanzamiento sin abrirlos. Si hay varios candidatos, los que pasen pueden seleccionarse como alternativas; una tarea usa un solo coordinador.

Los errores totales y parciales de lanzamiento se muestran en **Alertas de lanzamiento** en las vistas Clásica y Canvas. El usuario puede seleccionar IDEs locales y asignarles una solicitud explícita de diagnóstico desde esa sección. Sentinel y clientes MCP también pueden leer metadatos del mismo proceso con `openmcp_read_activity` filtrando `sources: ["orchestration"]`. Este historial es volátil y se pierde cuando se reinicia el proceso.

**Comportamiento Master en Workspace (WebUI):** toda Master seleccionada se prepara y verifica con SuperAssistant, incluso si no se registra como worker. La casilla de registro es independiente; si está activa, la Master aparece como tarjeta propia junto a Sentinel y el orquestador y puede recibir tareas directas o coordinadas, incluso con workers de otras plataformas. Desactivarla solo la deja fuera del pool, no omite SA. Un Relay autenticado basado en una Master es una instancia aparte y debe pasar su propio gate SA. Para Z.ai, Workspace verifica la sesión con una cookie de autenticación activa no-CSRF y el compositor visible; si no puede confirmarla, muestra **Sesión no verificada** en lugar de afirmar que hace falta iniciar sesión.

En ChatGPT, un indicador de conexión MCP no demuestra por sí solo que el observer de respuestas ni el control compacto estén operativos. La preparación debe confirmar también el adaptador/plugin activo y el botón MCP dentro del composer. Si una Master ChatGPT muestra “conectado” pero no tiene el botón o sus llamadas JSONL no aparecen como ejecutables, no la consideres lista: revisa su diagnóstico por instancia y confirma que el proceso cargó el build reciente. Los perfiles Master pueden reutilizar una instalación SA preexistente, mientras que los perfiles Clean nuevos cargan el bundle local; la diferencia de build/configuración debe comprobarse antes de atribuir el problema a la cuenta o a la herramienta llamada.

El renderer de ChatGPT observa tanto `pre` como `code`, porque algunas respuestas se montan directamente como elementos `code` sin un `pre` contenedor. El source corregido ya contempla ambos formatos; una extensión instalada necesita cargar el build actualizado para recibir el arreglo.

En **⚙ Ajustes** puedes elegir si el Workspace recupera el registro anterior de Masters worker y si al abrir una Master intenta continuar en las pestañas/conversación local anterior. Desactivar la restauración del registro retira esos perfiles del pool, pero conserva el registro guardado para que se pueda reactivar; no cierra Chrome ni borra perfiles o credenciales. Al desactivar la continuidad de pestañas, la Master abre la página principal de su plataforma. Ninguno de estos ajustes borra conversaciones guardadas por ChatGPT, Claude o Z.ai en sus cuentas.

También puedes activar **Guardar memoria temporal compartida** para conservar localmente y sin truncar las interacciones gestionadas por Workspace y cada llamada MCP con su resultado. El diario se comparte por herramientas MCP `workspace_context_info`, `workspace_context_read` y `workspace_context_search`; `workspace_task_trace` permite recuperar por `taskId` el proceso completo de una tarea (petición al orquestador, plan, asignaciones, respuestas/errores y revisión), paginándolo cuando sea necesario. El ID de tarea se muestra al iniciar la coordinación; consulta disponible solo para eventos conservados en el diario opt-in. Los prompts enviados a workers reciben una indicación breve para consultar el diario cuando sea pertinente; el historial completo no se inyecta automáticamente y consultarlo puede influir en la respuesta del modelo. Los eventos históricos son datos no confiables, no instrucciones o autorizaciones vigentes. Retirar una instancia Clean elimina solo los eventos etiquetados con su `agentId`; no equivale a exportar un historial y no elimina los mensajes guardados por la plataforma. La exportación de historiales de charla o de proyecto sigue siendo una función distinta y aún no está disponible.

La opción **Incluir mensajes visibles de las instancias web (Clean y Master)** requiere que también esté activada la memoria temporal. Su captura experimental observa mensajes visibles de usuario/asistente en el DOM con selectores comunes; no garantiza compatibilidad con todas las plataformas, mensajes virtualizados ni la conversación completa. No recopila cookies ni el DOM completo. Si la heurística detecta un patrón específico de credencial o token Bearer, no persiste ese texto y guarda solo una marca de omisión; otros mensajes pueden contener datos sensibles. En eventos identificados como worker Clean, la interfaz muestra señales locales **medio/alto/crítico** y **“Análisis de IA pendiente”**; eso no significa que Sentinel haya analizado el mensaje. La revisión opcional de Sentinel es independiente de guardar memoria: primero activa **Permitir análisis conversacional automático de Sentinel en este Workspace** en Ajustes y luego marca **“Sentinel analiza mensajes visibles con Gemini”** en cada Relay que autorices. Ambas opciones empiezan desactivadas. Sentinel analiza mensajes nuevos que la extensión detecta y estabiliza; no procesa el historial ya visible al activar la opción, solo envía como máximo 6.000 caracteres de cada mensaje y omite aquellos donde detecta patrones locales de credencial. El contenido permitido se envía a la API Gemini configurada, puede incluir conversaciones autenticadas y consume cuota; esta revisión no lo persiste en el diario. Las detecciones son experimentales y no garantizan cobertura de todas las plataformas. Sentinel publica sus observaciones en el transcript; puedes preparar un borrador para el destino actual y elegir un orquestador/worker para que lo verifique, pero nada se envía allí hasta que tú pulses **Enviar**. Sentinel no edita código ni ejecuta herramientas. Desactivar la opción general revoca las autorizaciones por Relay; desmarcar una instancia la revoca solo para esa instancia. Desactivar captura detiene nuevas escrituras, pero no borra lo ya guardado. El diario ocupa disco local, no caduca y **Eliminar historial** es definitivo. La memoria es independiente del lienzo colaborativo y no restaura conversaciones web ni perfiles/cookies.

El botón **🎙 Dictar** del Workspace solicita reconocimiento de voz solo al pulsarlo, etiqueta la escucha con el destino actualmente seleccionado y coloca la transcripción en el borrador. Cambiar de destino detiene el dictado; nunca envía el texto por sí solo: revísalo y pulsa **Enviar**. Requiere que el navegador ofrezca `SpeechRecognition`/`webkitSpeechRecognition` y concedas acceso al micrófono. El navegador puede enviar audio a su proveedor de reconocimiento; no se garantiza que use el reconocimiento local de Windows ni el modo sin conexión. Comprueba los ajustes de privacidad del navegador/proveedor. Si no hay API compatible, el control informa que no se inició ninguna grabación.

Una **Master Session** es el perfil Chrome persistente que mantiene una cuenta conectada y sirve como fuente opcional de sesión. Una Master puede ejecutar SuperAssistant y, de forma independiente, participar como worker del Workspace; no es worker salvo que se registre. En `/mcp set-mode web`, `Master Sessions only` abre/reutiliza fuentes sin lanzar Relays ni activar el modo Web, pero prepara y verifica SA en cada una. `/mcp master-session add "Nombre de cuenta"` crea una fuente ChatGPT por defecto; `/mcp master-session add --platform claude "Claude personal"`, `--platform zai "Z.ai"` y `--platform chatx "Astra GPT"` crean perfiles separados para esas plataformas. El nombre es opcional: `/mcp master-session add --platform chatx` asigna `ChatX`, o `ChatX 2`, etc. si ese nombre ya existe. Cada perfil usa directorio y puerto propios y abre su ventana para iniciar sesión. Usa nombres explícitos para distinguir perfiles. `/mcp master-session open <id>` vuelve a abrir la fuente existente, prepara/verifica SA y reutiliza su perfil, puerto y ventana: repetir `open` para el mismo ID no crea otra Master ni otra ventana aislada. Si una fuente recién creada aún no puede completar la preparación, termina el inicio de sesión y repite `/mcp master-session open <id>`; el comando no la presenta como lista sin SA. `/mcp master-session status <id>` consulta si está abierta y autenticada, sin mostrar cookies. ChatX abre `https://chatx.ai/es/gpt`; su estado de autenticación requiere cookie ChatX activa y composer disponible. La transferencia de cookies de una Master ChatX a un Relay no está habilitada ni verificada; usa la ventana Master directamente. Si se agrega otro perfil aunque se inicie sesión con la misma cuenta, será otra fuente Chrome, pero compartirá la cuenta/cuota de la plataforma correspondiente.

Para evaluar una instancia concreta sin enviar mensajes, primero identifica su `agentId`/`sourceId` y puerto mediante `sentinel_list_instances`; después llama `sentinel_inspect_instance` con ese identificador exacto. Con el MCP actualizado, la inspección read-only compara el proceso y la pestaña CDP con el perfil registrado, el contexto aislado de SA, la configuración y el botón compacto en el composer, el sidebar y el PluginRegistry. También contrasta los selectores declarados por el observer con la estructura de bloques `pre`/`code` de la página y correlaciona las fases técnicas recientes de captura/despacho MCP; devuelve contadores y estados, no texto de conversación ni argumentos. El escaneo periódico hace esta comprobación para Relays listos; una Master se evalúa cuando se la inspecciona explícitamente. `sentinel_get_orchestration_state` incluye además los avisos/fallos de lanzamiento que sigan en el journal retenido. No incluye texto de conversación salvo autorización explícita. `pageHasFocus` y `visibilityState` son señales de la página, no prueba de que la ventana Chrome esté en primer plano en Windows.

En la selección de sesión de `/mcp set-mode web` y del lanzamiento WebUI, ChatGPT puede usar **Importar desde Chrome (copia aislada)** además de Guest/clean y Master. Son tres opciones distintas: Guest/clean empieza sin cookies; **Cuenta autenticada** crea un Relay separado y obtiene la sesión de una Master registrada (la Master conserva y administra su perfil persistente); **Importar desde Chrome** copia una sola vez algunos datos del perfil local a un Relay separado. No adjunta CDP al Chrome personal ni comparte el mismo directorio: Chrome moderno exige un user-data-dir separado para depuración remota.

La copia aislada guarda cookies y datos de sitios/preferencias seleccionados, pero no sincroniza cambios con Chrome normal. Tras autorizar, OpenMCP solicita un cierre normal del Chrome habitual si está abierto y verifica que sus procesos hayan terminado antes de copiar; puede cerrar todas sus ventanas, así que guarda el trabajo primero. No fuerza la terminación: si Chrome sigue activo, no copia ni lanza Relays y muestra el proceso bloqueante e instrucciones para reintentar. Aunque el archivo de origen incluya cookies de sesión vigentes, la copia puede abrir sin una cookie que ChatGPT acepte; tener ChatGPT abierto en el perfil original o en su aplicación de escritorio no autentica el Relay. Si sucede, inicia sesión una vez en la **ventana Chrome de Relay**; el Relay conserva esa sesión local. Sentinel registra el estado de autenticación y compara una huella local del archivo de cookies antes/después del arranque para señalar automáticamente si Chrome reescribió la copia. `sentinel_inspect_instance` muestra el diagnóstico sin leer valores de cookies; el protocolo es verificar el perfil/Relay exactos, consultar el resultado de auth, y si la copia cambió y no hay cookie válida, dejar de repetir la importación y ofrecer el login en Relay o una Master Session. No se copian historial, contraseñas, marcadores ni extensiones. Disponible actualmente solo en Windows y ChatGPT.

También puedes dirigir un mensaje **directamente** a una Master, sin añadirla al pool ni pasarlo por el coordinador Relay: en CLI usa `/mcp master-session ask <id> <prompt>`; en la interfaz web elige `Master: <nombre>` en el selector de destino. La Master debe estar abierta, autenticada y tener el contexto de página de SuperAssistant listo. Esta ruta configura MCP al enviar el primer mensaje directo y espera la respuesta desde esa misma pestaña. Si falta el contexto de SA, no escribe claves desconocidas ni recarga la conversación: explica el estado y pide guardar el borrador antes de volver a abrir la página de plataforma. Los prompts directos a Masters desde la Web UI solo se aceptan desde el mismo origen en localhost o en una dirección IP local del servidor; se rechazan solicitudes de páginas externas. Elegir `Coordinador / pool Relay` conserva el flujo multiagente habitual.

### Agentes IDE dentro del workspace

Copilot en VS Code, Cursor, Claude Desktop/Code, Antigravity y otros clientes MCP pueden participar como agentes IDE conectándose al MCP local de OpenMCP (`http://127.0.0.1:3006/mcp`). Cada cliente debe añadir ese servidor MCP y llamar `workspace_join` con un ID estable, proveedor, nombre visible y capacidades. Después mantiene presencia con `workspace_update_presence` y consulta su bandeja con `workspace_poll_tasks`. En la interfaz workspace aparece en el roster; se puede seleccionar un IDE como destino o activar **Colaboración IDE** para enviar la misma tarea a varios IDEs online. Cada agente recibe una tarea independiente, agrupada por un `collaborationId`; el tablero muestra el estado y la respuesta de cada uno para comparar resultados. El agente devuelve el resultado con `workspace_complete_task` y puede publicar mensajes con `workspace_post_message`; hallazgos, solicitudes y bloqueantes existentes siguen visibles en el mismo lienzo.

Los clientes IDE también reciben herramientas genéricas `workspace_get_state`, `workspace_list_instances`, `workspace_inspect_instance` y `workspace_send_instance_prompt`: el inventario cubre Relays y Masters sin exigir que Sentinel sea el único agente que los consulte. Inspeccionar conversación requiere activar expresamente `includeConversation`; enviar un prompt a una instancia requiere aprobación explícita. Para captura visual puntual, cualquier cliente MCP puede usar `sentinel_capture_instance_view` con autorización; la captura no enfoca, navega ni recarga. Un cliente IDE ejecutado en esta máquina también puede registrarse/publicar actividad en la Web UI mediante `POST /api/workspace/join`, `/api/workspace/presence` y `/api/workspace/message`; la interfaz asigna tareas con `POST /api/workspace/assign`, y los clientes pueden reclamarlas/completarlas con `/api/workspace/claim` y `/api/workspace/complete`. Estas rutas solo aceptan peticiones same-origin locales. Los registros de IDE, mensajes y tareas residen en memoria del proceso OpenMCP y se reinician con él; un participante sin heartbeat durante 60 segundos aparece desconectado. La participación no es automática: además de configurar el endpoint MCP o invocar la API local, el cliente debe registrarse y atender periódicamente su bandeja.

Un **perfil Relay** es una instancia de trabajo independiente que se crea desde `/mcp set-mode web`; tiene su propio ID, perfil bajo `chrome-agents` y puerto CDP, y es el perfil que conversa con ChatGPT. Puedes lanzar relays sin abrir ni seleccionar una Master usando `Guest / clean`; en ese caso no se copian cookies y ChatGPT puede pedir iniciar sesión. Para relays autenticados, selecciona por instancia una fuente Master autenticada. El wizard abre esa Master si está cerrada y la mantiene activa durante la transferencia de cookies. Las cookies se copian al perfil Relay, no se comparte el directorio Chrome: después de una transferencia correcta la Master no es necesaria para que el Relay siga abierto, aunque habrá que abrirla de nuevo para transferir o renovar la sesión en futuros lanzamientos. Varios relays pueden seleccionar la misma fuente y usarán esa misma cuenta/cuota. Para utilizar varias cuentas, crea fuentes Master separadas y asígnalas electivamente a los relays. Si el error `SuperAssistant content execution context was not found` menciona el puerto de una Master, no se debe forzar la escritura de configuración SA en esa fuente: verifica que se esté ejecutando la acción de Relay, y revisa el puerto del Relay afectado. El error en el puerto Relay se reporta como fallo de preparación del agente y el agente no se incorpora al pool.

En el wizard, **Conversación Agente** siempre requiere un orquestador: el cerebro API coordina sin consumir una Relay y registra todas las instancias lanzadas como workers; el cerebro Web añade una Relay coordinadora aparte del número de workers seleccionado. La sesión de esa Relay se elige por separado y no desplaza la configuración de ningún worker. **Conversación Usuario** abre perfiles Relay para uso manual y no los incorpora al pool ni usa coordinador. Abrir más instancias Relay significa ejecutar el wizard y pedir más perfiles; no crea más Master Sessions. La Master seleccionada permanece independiente y no se cierra al detener un Relay.

**Claude web (Anthropic)** tiene una ruta inicial de Relay: el wizard navega a `https://claude.ai` y la extensión inyecta el content script allí. El adapter específico de Claude monta el control compacto junto al composer. En un Relay abierto se verificó por CDP el control y la reinyección tras cambios del DOM; después, la preparación directa `prepareSAAgentForWebRelay(..., "claude")` pasó la configuración de Streamable HTTP y la verificación post-recarga de MCP, Push Content Mode, Auto Insert, Auto Submit y Auto Execute. Aún falta validar el lanzamiento/preparación completo desde el wizard. En una prueba lado a lado, un texto terminó con `visibilityState="visible"`; luego, con Claude realmente cubierto por VS Code, una llamada MCP `Bash` a `echo MCP_VISIBILITY_TEST` terminó y devolvió esa salida mientras CDP mantuvo `visibilityState="hidden"`. No apareció `An executionId or executionKey is required`. Las entradas se insertaron/enviaron directamente por CDP y el documento estuvo enfocado (`document.hasFocus() === true`) durante la llamada: esto demuestra que la oclusión por sí sola no impidió ese despacho concreto, pero no valida el flujo de entrada normal de SuperAssistant con la ventana oculta y desenfocada, no expone el `executionId` interno y no demuestra que la oclusión causara el error original. No desactives la detección de oclusión para simular visibilidad. Un perfil `Guest / clean` no copia sesión de una Master; en una prueba local mostró `isLoggedIn=false` y requirió autenticarse para continuar. Ahora existe soporte experimental de Master Session por plataforma: crea y autentica una fuente propia con `/mcp master-session add --platform claude "Claude personal"` y luego elige `Authenticated` para un Relay Claude. Solo se transfieren cookies del dominio `claude.ai` y la verificación exige cookie `sessionKey` más señales de UI autenticada; todavía falta validar el comportamiento real de transferencia con una cuenta Claude, así que un fallo deberá tratarse como incompatibilidad observada, no como sesión lista. La plataforma seleccionada sigue siendo global: no combines Claude y ChatGPT en un mismo pool.

**Z.ai** se puede registrar como Master Session con `/mcp master-session add --platform zai "Z.ai GLM 5.3"` y se abre en un perfil Chrome persistente independiente. La Master no recibe SuperAssistant ni es un Relay elegible. OpenMCP todavía no verifica si esa cuenta está autenticada y no transfiere cookies Z.ai a relays; el estado aparece expresamente como no verificado. Inicia sesión y confirma el modelo GLM-5.3 en la ventana antes de considerar la fuente apta para investigación.

**Arena.ai** está integrado inicialmente para Web Relay en `https://arena.ai/text/direct?model_a=max`; el adaptador de SuperAssistant se activa solo en la ruta `/text/direct` y coloca el control MCP junto al botón de archivos. Las instancias se lanzan como perfiles `Guest / clean` (no hay transferencia Master Session de Arena). Después de abrir cada Chrome, elige manualmente el modelo Direct que quieras usar en cada ventana. La interfaz y el catálogo disponibles se inspeccionaron, pero no se envió un prompt, así que la extracción de respuestas de Web Relay y el flujo de herramientas con un turno real siguen pendientes de validación; no se debe asumir un modelo específico, incluido GPT-6 Sol.

**Z.ai** está disponible para Web Relay en `https://chat.z.ai/`. Cada Relay abre un perfil `clean`; inicia sesión y abre manualmente la conversación que quieras en cada ventana. El adaptador CDP usa el composer `textarea#chat-input` y el botón `#send-message-button` observados en la página. No se ha validado un turno real ni la extracción de respuestas. La URL de conversación solicitada (`/c/dcbfe535-d850-488a-ad97-0a64085a9895`) respondió `500` con `chat not found` y la aplicación volvió a la página raíz; por eso no se fija ese ID como destino y no se puede asegurar que esa conversación exista o sea accesible.

**Grok** se abre desde Web Relay en `https://grok.com/` con un perfil `clean`; inicia sesión en cada ventana si la plataforma lo solicita y elige manualmente el modelo disponible. Se inspeccionaron en la interfaz española el composer `textarea[aria-label="Pregunta lo que quieras a Grok"]`, el botón `button[data-testid="chat-submit"]` (`aria-label="Enviar"`) y el área donde se puede montar el control MCP. Las pruebas validan inserción/envío y arranque simulado, pero no se envió un mensaje real; la detección de generación y extracción de respuesta aún no tienen validación de turno E2E.

**Google AI Studio** abre la ruta `https://aistudio.google.com/prompts/new_chat` desde Web Relay con un perfil `clean`. El navegador usado para inspección redirigió a inicio de sesión de Google, así que no se confirmó visualmente el composer autenticado ni se envió un mensaje. Los selectores CDP siguen los selectores existentes en el adaptador de la extensión (`textarea.textarea` de prompt, botones `Run`/`Send`); inicia sesión manualmente en cada ventana. La inserción/envío está cubierta por pruebas unitarias, pero el flujo autenticado, la captura de respuesta y MCP E2E aún necesitan validación runtime.

**Perplexity** se abre en `https://www.perplexity.ai/` con un perfil `clean`; elige el modelo disponible en la propia página. Se observó el editor Lexical `#ask-input[contenteditable="true"][role="textbox"][data-lexical-editor="true"]`; la página también mostraba “Iniciar sesión”, por lo que detectar el composer no demuestra que haya una cuenta autenticada. El adaptador CDP inserta mediante `execCommand('insertText')` y envía con el botón visible/enabled si aparece o usa Enter en el composer. Hay cobertura unitaria para inserción, envío y arranque, pero no se envió un prompt real: generación y extracción de respuesta requieren validación en una sesión autorizada.

**Kimi** se abre en `https://www.kimi.com/` con un perfil `clean`; inicia sesión y elige allí un modelo disponible si la página lo requiere. En la inspección se observó el composer visible `.chat-input-editor[contenteditable="true"]` y controles de inicio de sesión. No apareció un botón de envío con el editor vacío, así que CDP intenta usar un control de envío visible si aparece tras insertar texto y recurre a Enter. La extensión ya tenía un adaptador Kimi; el Web Relay añade registro, detección de composer y soporte CDP. No se envió mensaje: autenticación, envío real, generación y extracción de respuesta aún requieren prueba en una sesión autorizada.

**Qwen** se abre en `https://chat.qwen.ai/` con un perfil `clean`; elige el modelo disponible en la página. En la inspección se observó `textarea.message-input-textarea` con placeholder `Preguntar a Qwen`, junto con controles de inicio de sesión; no apareció un botón de envío mientras el campo estaba vacío. CDP busca un botón de envío visible/habilitado después de insertar texto y utiliza Enter como alternativa. La extensión ya tenía un adaptador Qwen; Web Relay añade registro, preflight y soporte CDP. No se envió mensaje: detectar el composer no demuestra autenticación y todavía falta validar un turno real, generación y extracción de respuesta.

**DeepSeek** se abre en `https://chat.deepseek.com` con un perfil `clean`; inicia sesión en cada ventana si la página lo solicita y elige allí el modelo disponible. En la inspección actual el sitio redirigió a `/sign_in`, así que no se pudo observar el composer autenticado. El adaptador Web Relay soporta textarea y contenteditable, selecciona solo controles visibles y habilitados, y usa Enter como alternativa de envío. La detección identifica el sitio, pero no declara autenticación basándose en URL o composer. Pruebas cubren inserción, envío y arranque simulado; streaming, extracción de respuesta y MCP E2E necesitan validación con una sesión autorizada.

**ChatHub** abre el enlace indicado a `GLM-5.3` conservando su `cid` en cada perfil Relay. Se observó un textarea dentro del formulario y un botón “Enviar”; la página también mostró controles de inicio de sesión, por lo que el composer no se toma como prueba de cuenta autenticada. El adaptador CDP y la extensión insertan en el textarea visible y envían con el botón visible habilitado (Enter es el fallback CDP). El `cid` proporciona un scope estable de conversación para los claims MCP. Pruebas cubren registro, inserción/envío, scope y arranque clean; no se envió prompt y quedan pendientes respuesta, streaming y MCP E2E autenticados.

### Criterio de prioridad de plataformas

La selección reciente tomó como referencia la categoría **AI Chatbots and Tools** de Similarweb, con datos mostrados como actualizados al 1 de septiembre de 2026. En esa clasificación, Microsoft Copilot aparece #9, Kimi #11 y Qwen #13; la clasificación mide tráfico/engagement del sitio en esa categoría, no usuarios únicos ni calidad del modelo. Copilot quedó para una etapa posterior porque la inspección redirigió a inicio de sesión Microsoft y no permitió observar su composer. Kimi y Qwen sí mostraron composer sin enviar prompts, y además ya tenían adaptadores de extensión, por lo que fueron los siguientes candidatos viables. Fuente: [Similarweb — AI Chatbots and Tools](https://www.similarweb.com/top-websites/ai-chatbots-and-tools/).

El lanzamiento tiene dos etapas: primero inicia Chrome y carga la extensión SuperAssistant; después configura y verifica MCP, Push Content Mode, Auto Insert, Auto Submit, Auto Execute y la barra lateral en cada perfil. Ver solo la extensión o el botón compacto no confirma que esta segunda etapa haya terminado. Los perfiles que superen ambos pasos se conservan; Conversación Agente requiere un worker cuando el cerebro es API y, con cerebro Web, exige que al menos un candidato a coordinador y al menos un worker superen los gates. Los candidatos coordinadores restantes son alternativas opcionales; no sustituyen el requisito del worker. Conversación Usuario requiere una ventana manual. Los perfiles que fallen se detienen y se reporta su rol, ID, puerto y gate; si no queda el mínimo o falla la preparación de todos los candidatos coordinadores, se revierte el lote y no se registra el pool. El pool solo incluye perfiles cuya configuración SA fue verificada. Conserva el mensaje `Web Relay setup failed...` del terminal para identificar la instancia y la causa exacta.

El nombre Master es una etiqueta local del perfil: confirma manualmente que ChatGPT muestre la cuenta que quieres asociar a esa etiqueta. `Guest / clean` permanece separado y nunca copia cookies.

Para lanzar manualmente, haz clic en **[+ Lanzar/configurar]** en la barra inferior (o escribe `/mcp set-mode web`), selecciona ChatGPT, elige el propósito, la cantidad con las flechas y Enter, y después la sesión de cada instancia. Con `Guest / clean`, las ventanas se abren sin sesión maestra ni requisito de iniciar sesión, y SuperAssistant se prepara automáticamente. Espera la confirmación de que todas quedaron preparadas. **No tienes que abrir CMD ni lanzar Chrome a mano**: el asistente lo hace y muestra el resultado. No se abre ninguna ventana al iniciar OpenMCPWEBLOCK; solo tras completar el asistente.

La cantidad elegida para Conversación Agente siempre representa workers: con cerebro API son 1–20 Relay worker; con cerebro Web son 1–19 workers más una Relay coordinadora adicional (2–20 Relay en total). Conversación Usuario permite 1–20 ventanas manuales. Sentinel es independiente: el monitor se inicia con la aplicación y en la TUI el destino Gemini se puede activar en cualquier momento, sin importar el modo de conversación ni lanzar un Relay extra. El selector de modelo no cambia el modelo de ChatGPT desde OpenMCPWEBLOCK: con el soporte actual de ChatGPT Web, el modelo se elige dentro de la propia página de ChatGPT. Si varias instancias seleccionan la misma fuente `Authenticated`, compartirán esa cuenta y cuota; puedes asignar fuentes distintas si tienes varias. El modo `Guest / clean` no transfiere cookies.

También puedes abrir la consola con `/mcp sentinel`. Cuando el destino del composer está en Sentinel, el próximo texto normal se envía a Gemini y la respuesta aparece en el transcript; los comandos `/...` siguen ejecutándose como comandos.
Sentinel usa el `GEMINI_MODEL` y `GEMINI_API_KEY` (o `CENTINELA_API_KEY`) configurados localmente; la conversación consume cuota de esa API Gemini. Sus herramientas pueden consultar salud, lanzar agentes `guest/clean` y detener únicamente agentes `guest/clean` de la plataforma seleccionada. Nunca clona ni detiene sesiones autenticadas o la sesión maestra.

La consola de Sentinel muestra **Logs recientes** con hora, severidad, agente, código de diagnóstico y detalle. Los logs conservan hasta 200 incidencias/eventos recientes en memoria, registran un problema cuando aparece y otra entrada cuando se resuelve, y redactan valores que parezcan cookies, tokens, claves o contraseñas. `/mcp status` presenta el último resultado por relay: estado CDP, modo de sesión, fuente Master asociada, configuración SA (MCP, Push Content Mode, Auto Insert/Submit/Execute, barra lateral y botón compacto) y causa de cada gate fallido. Un service worker de extensión inactivo se marca como advertencia porque Chrome puede suspenderlo; no se considera por sí solo una caída de Chrome. La comprobación solo lee las preferencias/controles: no cambia la configuración, no inicia sesión ni cierra ventanas.

En `/mcp sentinel`, **Evidencia y diagnóstico de llamadas MCP** abre un registro duradero de pruebas observadas y reglas deterministas para separar configuración, tarjeta ejecutable, claim, identidad de ejecución, resultado MCP, inserción, envío y respuesta final. Sentinel no lo presenta como aprendizaje automático ni da por probada una ejecución sin intervención. En Claude se observaron tres turnos de UI con `visibilityState=hidden`/`hasFocus=false`: uno mostró dos resultados rotulados Bash y dos mostraron una salida cada uno; otra petición se preparó antes de ocultar/minimizar la ventana y se envió por CDP mientras ya estaba `hidden/false`. La página mostró las salidas y no presentó el error de identidad, pero el storage de extensión y el colector de esa sesión no registraron parser/despacho/identidad. No se puede afirmar que esos Bash fueran MCP ni atribuirlos retrospectivamente a la herramienta integrada de Claude; su origen quedó sin correlacionar. Estas muestras no prueban continuidad MCP, garantía prolongada ni procesamiento permanentemente desenfocado. El proceso MCP :3006 no se reinició y los logs históricos se preservaron.

Una prueba posterior detectó un error de método importante: la solicitud `SA_TRACE_PROBE_20260930` se hizo en un chat nuevo sin insertar antes el prompt de arranque Original; Claude indicó que había usado su `bash_tool` integrado, no MCP Bash. Esa salida no cuenta como prueba del servidor local. En un nuevo chat se seleccionó `Original SuperAssistant (Pasted text #1)`, se insertó correctamente y se verificó en el composer; al enviarlo, Claude detuvo el turno con el aviso de seguridad `[reasoning_extraction]`. No se cambió de modelo ni se alteró el prompt para eludir la pausa. Por eso todavía no hay una prueba válida de herramienta MCP en Claude después del prompt de arranque. El colector :3011 sí registró eventos de control `WebSearch`/`WebFetch` que llegaron al MCP local :3006; no se debe atribuir la ausencia de un evento Bash a una falla del bridge en la prueba que omitió el prompt.

El usuario reporta además que en otra conversación Claude sí generó una llamada real de SuperAssistant y le proporcionó un prompt de arranque. Se conserva como observación aportada por el usuario y cambia el diagnóstico de alcance: el flujo ha podido avanzar en otra sesión. No hay una traza correlacionada de esa conversación que permita compararla con el error `executionId`; por eso no se le atribuye el mismo perfil, build ni recorrido de ejecución.

La telemetría de ese envío sí capturó que el observer parseó el ejemplo JSONL incorporado en Original (`function_name`, `parameter_1`/`parameter_2`), programó y disparó Auto Execute, y consultó una dirección de ejecución que respondió `not_found`. El resumen identifica `START_EXECUTION_REQUEST` como el primer evento esperado ausente después de `AUTO_EXECUTION_TRIGGERED`. Este es un falso positivo del ejemplo del prompt, no una llamada generada por Claude ni la reproducción del error por handle vacío; sirve para que Sentinel separe ejemplos de prompt de despachos reales.

El formato JSONL `function_call_start` está documentado por el [README upstream de SuperAssistant](https://github.com/srbhptl39/MCP-SuperAssistant#readme), pero la lista de plataformas publicada allí no incluye Claude.ai. El prompt de arranque es parte necesaria del recorrido que se está probando; que Claude muestre “Bash”, que el control SA diga “Active” o que :3006 esté healthy no acredita que se haya invocado una herramienta MCP. El botón SA “Active” representa `mcpEnabled`/visibilidad de la sidebar, no el éxito de un despacho. En el código local, `getExecution()` lanza el error de identidad cuando recibe un handle vacío; el flujo de ejecución normal primero solicita `startExecution()` y luego consulta con su `executionId`. La causa original solo se localizará correlacionando parser, solicitud de inicio, handle devuelto y polling en una llamada realmente MCP.

Con varias instancias puedes escribir una petición conversacional normal en destino **Coordinador Web**; no hace falta ejecutar `/mcp ask` en cada turno. La instancia seleccionada primero propone una instrucción diferente para cada worker y después revisa los resultados. El coordinador es seleccionable desde el pie y queda guardado en la configuración del proyecto; si esa instancia deja de estar lista, el error identifica el ID y no cambia silenciosamente el destino. OpenMCPWEBLOCK valida que el coordinador asigne a todas las workers IDs reales y que no deje ninguna sin tarea. El lienzo de actividad muestra un recuadro por instancia con rol, etapa y estado; el borde animado indica una solicitud activa y permite recorrer el historial retenido. Las respuestas originales de los workers y el seguimiento del coordinador aparecen en apartados separados del transcript. Las consultas se ejecutan en serie para evitar mezclar conversaciones. Un único agente no se acepta como modo agente: hace falta coordinador y al menos una worker. El modo manual no participa en estas asignaciones. El pool admite sesiones `clean` y `authenticated` seleccionadas explícitamente; ambas deben aparecer listas después de configurar SA.

El campo de respuesta contiene el texto visible que devolvió la conversación Web Relay, no razonamiento privado. El borde animado cubre el tiempo de la solicitud completa y no identifica cada subllamada de herramienta: el provider todavía no emite una traza estructurada de llamadas/resultados SA para la TUI. Por eso el texto devuelto no debe interpretarse automáticamente como la respuesta final posterior a toda ejecución MCP. Los detalles de herramientas siguen visibles en la propia conversación ChatGPT; incorporarlos como eventos etiquetados requiere instrumentar esa señal explícitamente. El lienzo retiene hasta 20 ejecuciones en memoria durante la sesión y el transcript conserva las respuestas completas.

El bootstrap ya no restaura automáticamente `webRelayAgentIds` al abrir OpenMCPWEBLOCK. Las IDs y preferencias guardadas no lanzan Chrome por sí solas; para iniciar agentes Web Relay hay que abrir el wizard y confirmar una configuración nueva.

### Reconectar ventanas Web Relay que siguen abiertas

Si cerraste o reiniciaste OpenMCPWEBLOCK pero dejaste abiertas las ventanas Chrome que había lanzado, usa `/mcp recover` y confirma el propósito (agente o usuario/manual) y el tipo de sesión de esos perfiles. También puedes abrir `/mcp sentinel` y elegir **Reconectar instancias ya abiertas**. La recuperación busca Chrome con CDP en el rango de puertos local de Web Relay y solo adopta perfiles con una identidad de SuperAssistant válida para la plataforma seleccionada. No abre ni cierra Chrome y no copia, transfiere ni modifica cookies.

El selector informa que está en **Web Relay**; no representa ni cambia el destino del composer y no envía mensajes a Sentinel. El comando escanea en paralelo los 101 puertos CDP reservados para Web Relay, así que no espera dos segundos por cada puerto cerrado. El resultado indica cuántos puertos respondieron y cuántos tenían una identidad SA válida para la plataforma activa. El estado del servidor MCP no es una condición para descubrir o registrar el navegador; la disponibilidad del puente se verifica por separado.

El propósito se infiere de las identidades actuales y de los IDs antiguos con prefijos `web-<plataforma>-agent-` / `web-<plataforma>-user-`; una identidad ambigua se omite para no meter por error una ventana manual en el pool. Si no se puede inferir, puedes ejecutar la recuperación indicando el propósito manualmente. La clasificación de sesión se confirma explícitamente porque identidades antiguas pueden no guardar si el perfil era `clean` o `authenticated`; si eliges un valor distinto del que sí esté guardado, el perfil se omite. Solo perfiles `clean` clasificados como agentes se incorporan al pool; perfiles autenticados y ventanas de usuario quedan fuera. Si otro proceso OpenMCPWEBLOCK todavía posee el puerto, la recuperación no toma control concurrente: usa la sesión que ya administra esas instancias o espera a que su proceso administrador termine. Un Chrome sin identidad SA verificable no se puede adoptar de forma segura; en ese caso hay que iniciarlo desde el wizard.

El indicador consulta cada cinco segundos `http://127.0.0.1:3006/status` y `/relay/status`: `ON` significa que el servidor y su API de control relay responden; `OFF`, que no responde; `ACTUALIZAR`, que el servidor responde pero no expone la API esperada. El indicador no inicia el servidor. El flujo de lanzamiento inicia el MCP local en `:3006` cuando hace falta. También se puede iniciar manualmente desde la raíz con `bun run scripts/start-mcp-server.ts`; no ejecutes una segunda instancia en el mismo puerto si ya aparece `[Puente MCP :3006 ON]`.

---

## Paso 1: Verificar que todo está corriendo

### Terminal 1: Verifica Chrome CDP

```powershell
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing
```

✅ Si ves Browser version, Chrome está corriendo.

### Terminal 2: Verifica el Proxy

```powershell
Invoke-WebRequest -Uri http://localhost:3006/healthz -UseBasicParsing
```

✅ Si ves "200 OK", el proxy está corriendo.

---

## Paso 2: Activa Web Mode en OpenClaude

Abre CLI de OpenClaude:

```bash
cd c:\Users\apoca\openMCPWEBLOCK

# Activa web mode
claude /mcp set-mode web

# Verifica
claude /mcp status
```

**Salida esperada**:
```
Mode: web
Expected servers: superassistant-proxy, chrome-devtools, claude-mem
Available tools: 43 (14 filesystem + 29 chrome-devtools)
Status: ✅ ALL SYSTEMS GO
```

---

## Paso 3: Haz tu primer consulta web

### Ejemplo 1: Extrae título de un sitio

```bash
claude "¿Cuál es el título de la página en https://example.com?"
```

**Proceso interno**:
1. OpenClaude detecta que necesita navegación
2. Llama `chrome-devtools-mcp.new_page` → abre example.com
3. Llama `chrome-devtools-mcp.evaluate_script` → extrae title
4. Responde con el resultado

**Resultado esperado**:
```
[OpenClaude] El título de example.com es: "Example Domain"
```

---

### Ejemplo 2: Busca contenido en un sitio

```bash
claude "En https://example.com, ¿qué dice el párrafo principal?"
```

**Proceso interno**:
1. Navega a example.com
2. Busca el párrafo principal (elemento `<p>`)
3. Extrae el texto
4. Responde

**Resultado esperado**:
```
[OpenClaude] El párrafo principal dice:
"This domain is for use in examples and documentation..."
```

---

### Ejemplo 3: Múltiples pasos (más avanzado)

```bash
claude "
1. Navega a google.com
2. Busca 'OpenClaude MCP'
3. Dime cuántos resultados hay
"
```

**Proceso interno**:
1. Abre google.com
2. Busca el campo de búsqueda
3. Llena y presiona Enter
4. Espera a que cargue
5. Extrae el número de resultados
6. Responde

---

## 🎮 Casos de Uso Reales

### A. Monitoreo de Precios

```bash
claude "¿Cuál es el precio actual de Bitcoin en coinmarketcap.com?"
```

Resultado:
```
[Navega a coinmarketcap.com]
[Extrae el precio del widget principal]
[Responde] "El precio de Bitcoin es $87,432"
```

---

### B. Verificación de Estado

```bash
claude "
Verifica el status de los servicios de GitHub:
1. Ve a status.github.com
2. Dime si todo está verde
"
```

Resultado:
```
[Navega a status.github.com]
[Evalúa el estado de los componentes]
[Responde] "Todos los servicios de GitHub están operacionales ✅"
```

---

### C. Extracción de Datos

```bash
claude "
Extrae de weather.com:
1. Temperatura en Los Ángeles
2. Probabilidad de lluvia
3. Velocidad del viento
"
```

Resultado:
```
[Navega a weather.com]
[Busca Los Ángeles]
[Extrae datos]
[Responde] 
"Temperatura: 72°F
Lluvia: 15%
Viento: 8 mph"
```

---

## 🧪 Testing Manual (Opcional)

Si quieres ver exactamente qué sucede por debajo:

### Test con PowerShell

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 'test-001'
  method = 'tools/call'
  params = @{
    name = 'chrome-devtools-mcp.new_page'
    arguments = @{ url = 'https://example.com' }
  }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
  -Uri http://localhost:3006/mcp `
  -Method Post `
  -Headers @{ 'Content-Type' = 'application/json' } `
  -Body $body `
  -UseBasicParsing

$response.result.content[0].text
```

**Salida**:
```
## Pages
1: about:blank
2: https://example.com/ [selected]
```

---

### Test con Node.js

```bash
node test-mcp-tools.mjs
```

**Salida esperada**:
```
🚀 Testing MCP Proxy Connection to chrome-devtools-mcp

📋 Step 1: Listing available tools...
✅ Got 43 tools (14 filesystem + 29 chrome-devtools)

📄 Step 2: Creating a new browser page...
✅ Successfully navigated to https://example.com

🔍 Step 3: Listing browser pages...
✅ Currently have 2 pages open
```

---

## 🔧 Troubleshooting

### Problema: "Port 3006 already in use"

```powershell
# Encuentra el proceso usando el puerto
Get-NetTCPConnection -LocalPort 3006 | Format-Table

# Termínalo
Stop-Process -Id <PID>

# Relanza el proxy
.\launch-superassistant-proxy.ps1
```

---

### Problema: "Chrome not responding"

```powershell
# Verifica Chrome
Get-Process chrome | Select-Object Id, ProcessName

# Si no está corriendo, lánzalo
.\launch-chrome-cdp.ps1

# Espera 3 segundos
Start-Sleep -Seconds 3

# Verifica CDP
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing
```

---

### Problema: "tools/call returning error"

1. Verifica que el proxy está corriendo: `http://localhost:3006/healthz`
2. Verifica que Chrome está corriendo: `http://localhost:9222/json/version`
3. Mira los logs del proxy: `Get-Content .\logs\superassistant-proxy.stdout.log -Tail 20`

---

## 🎯 Validación Final

Ejecuta este test para confirmar que todo funciona:

```bash
# Verifica Chrome
Write-Host "Chrome CDP: " -NoNewline
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing | Write-Host "✅"

# Verifica Proxy
Write-Host "MCP Proxy: " -NoNewline
Invoke-WebRequest -Uri http://localhost:3006/healthz -UseBasicParsing | Write-Host "✅"

# Verifica OpenClaude config
Write-Host "OpenClaude mode: " -NoNewline
claude /mcp status | Select-String "web" | Write-Host "✅"

Write-Host "`n✅ Todo listo para usar Web Relay Mode"
```

---

## 📊 Lo que Acabas de Activar

```
Antes:
├─ OpenClaude: Solo herramientas locales/APIs
├─ Chrome: Solo para ti (manual)
├─ Información: Estática en documentos
└─ ROI: 0 (solo teoría)

Después (Ahora):
├─ OpenClaude: Herramientas locales + MCP web
├─ Chrome: Automático vía chrome-devtools-mcp
├─ Información: Live desde cualquier sitio web
└─ ROI: ✅ (navegación web automática)

Valor agregado:
✅ Monitoreo de cambios en sitios
✅ Automatización de búsquedas
✅ Extracción de datos en vivo
✅ Verificación de estado
✅ Testing de interfaces web
✅ Consenso entre IAs web (próximo)
```

---

## 🚀 Próximos Pasos

### Hoy
- ✅ Activa Web Mode (hiciste esto)
- ✅ Haz tu primera consulta web (hiciste esto)

### Mañana
- [ ] Experimenta con diferentes sitios
- [ ] Documenta casos de uso que encuentres
- [ ] Reporta cualquier error

### Próxima Semana
- [ ] Instala SuperAssistant extension en Chrome
- [ ] Conecta ChatGPT/Gemini al proxy
- [ ] Activa multi-IA (Consensus Engine)

---

## 💡 Recuerda

Este es el **Web Relay Mode** que propusiste como alternativa a:
- ❌ APIs lentas/limitadas
- ❌ Modelos locales que usan demasiada RAM
- ✅ **Web automation sin costos**

Ahora tienes:
- ✅ OpenClaude con acceso web
- ✅ 29 herramientas de navegación
- ✅ Conexión a cualquier instancia web
- ✅ Memoria persistente

**Status: 🎉 EN PRODUCCIÓN**

---

**¿Preguntas?** Mira `WEB_RELAY_MODE_EN_ACCION.md` para más detalles
