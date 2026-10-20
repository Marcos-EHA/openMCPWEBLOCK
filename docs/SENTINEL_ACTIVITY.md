# Sentinel: actividad técnica de Web Relays

La opción **Ver actividad técnica de un Relay** consulta los eventos recientes
de la extensión SuperAssistant en un agente registrado y listo. Sentinel accede
al Relay seleccionado por su identidad registrada (agente, puerto CDP e ID de
extensión), mediante CDP de solo lectura.

La vista devuelve hitos de ejecución —por ejemplo, parser, creación/consulta de
ejecución, dispatch, completion, inserción y auto-submit— junto con call ID,
herramienta, resultado y las señales de visibilidad/foco. Está limitada a los
últimos 25 eventos (máximo 100 en la API).

## Límite de contenido

La consulta de Sentinel usa una lista permitida de campos técnicos. No devuelve
mensajes del usuario, respuestas del modelo, comandos ni valores de argumentos,
HTML de la conversación, cookies o credenciales. La telemetría se guarda primero
en el almacenamiento local de la extensión. Si está activo el colector local
opcional de diagnósticos en `127.0.0.1:3011`, la extensión también puede
reenviar los metadatos técnicos permitidos; Sentinel no inicia ese colector.

La actividad solo está disponible cuando el Relay está registrado, listo y el
service worker SuperAssistant responde. Durante el preflight de lanzamiento,
`sa_preparing` distingue una instancia que todavía configura SA de una instancia
`ready`; Sentinel no inspecciona el Relay mientras permanece en esa fase. El
estado `ready` confirma que el preflight terminó, no que una llamada MCP
end-to-end haya tenido éxito.

Sentinel no adopta instancias por esta consulta, no navega, no enfoca, no
restaura ni recarga ventanas, y no inicia llamadas MCP.
`document.visibilityState` y `document.hasFocus()` son señales de la página, no
una prueba del estado foreground de Windows.

Esta función es distinta de enviar una solicitud a un agente o pedirle que
resuma una conversación. Esas acciones pueden requerir contenido y deben ser
iniciadas explícitamente por el usuario.

## Snapshot de conversación ChatGPT

La opción **Ver snapshot de conversación (ChatGPT)** es independiente de la
vista técnica. Requiere seleccionar un Relay ChatGPT `ready` y confirmar la
lectura antes de cada consulta. Sentinel lee únicamente el texto renderizado de
la única pestaña ChatGPT de ese Relay: los 30 mensajes visibles más recientes,
con un máximo de 2.000 caracteres por mensaje. Si no hay pestaña o hay más de
una, la consulta informa que no está disponible y no elige una arbitrariamente.

El snapshot es puntual, no una transmisión en vivo. Actualizar vuelve a leerlo
manualmente. La consulta MCP directa no escribe ni envía el texto a Gemini u
otro agente; el snapshot se conserva solo en la memoria del caller. Esta función
no abre, enfoca, navega ni recarga Chrome, y no observa Master Sessions ni otras
plataformas.

## Sentinel desde Workspace

El panel Sentinel del Workspace muestra los resultados de los escaneos periódicos
del monitor central (cada 15 segundos) y permite iniciar un escaneo manual de
todos los Web Relays `ready`. Estos escaneos verifican salud técnica y estado de
SuperAssistant; no leen mensajes ni envían contenido a Gemini. Un puerto CDP
muerto puede provocar que el monitor marque el Relay como perdido; el escaneo no
cierra ventanas.

El roster único del Workspace combina los datos del ciclo de vida del Runner
(rol, modo de sesión, plataforma, puerto CDP, ejecuciones activas/desconocidas e
heartbeat) con la última observación de Sentinel (CDP, service worker, MCP,
preferencias de SA, visibilidad del botón/sidebar y registro de plugins).
Diagnósticos completos aparecen bajo cada instancia, sin abrir Chrome. El estado
de Master se consulta al registro de sesiones (abierta, autenticación y
participación como worker), pero las Masters no se incluyen en el escaneo
técnico periódico de Web Relays. La ausencia de observación se muestra como tal;
no se infiere que una función esté lista.

El estado de cada Relay se marca como pendiente de medición hasta que Sentinel
lo inspeccione; una señal técnica fallida o un diagnóstico visible lo marca para
revisión. Los resultados del escaneo actualizan las tarjetas sin cerrarlas ni
reiniciar sus detalles desplegados. Los refrescos del roster conservan la
expansión, el foco del botón de revisión y la posición de desplazamiento.

Cada mensaje `user` que llega al transcript del Workspace ofrece **Pedir
sugerencia a Sentinel**. Solo después de la confirmación se envía a Gemini el
texto exacto de ese mensaje; el resultado se publica en el Workspace y no se
incorpora a la memoria temporal. También se puede autorizar la revisión
automática, con doble opt-in: primero se habilita en Ajustes para todo el
Workspace y después, Relay por Relay, desde su casilla del roster. La extensión
consulta la autorización efectiva del `agentId` en MCP y revisa mensajes
visibles nuevos ya estabilizados; al activar una instancia, los mensajes que ya
estaban en pantalla se establecen como línea base y no se envían. Se limita cada texto a 6.000
caracteres y la heurística local omite mensajes con patrones de credencial de
severidad crítica. El texto autorizado se envía a la API Gemini configurada,
puede incluir conversación autenticada, consume cuota y no se guarda en el
diario por esta ruta. La detección DOM es experimental, no garantiza cobertura
de plataformas ni mensajes virtualizados y no es supervisión continua de toda
la conversación.

El selector de destino del Workspace también permite escribir directamente a
Sentinel. Antes de enviar, solicita confirmación y muestra que el borrador se
enviará a la API Gemini configurada; la respuesta aparece en el transcript. La
revisión manual y este destino no requieren habilitar la revisión automática
Relay-por-Relay: son acciones iniciadas por el usuario.

En la lista de instancias Relay, **Revisar chat con Sentinel** actúa sobre un
único `agentId` registrado y `ready`. Después de una confirmación explícita,
Sentinel lee por CDP hasta 12 mensajes renderizados recientes (máximo 1.200
caracteres por mensaje), bloquea el envío si la revisión local detecta un valor
con apariencia de credencial y manda el snapshot permitido a la API Gemini
configurada. El chat no se modifica ni se persiste por esta operación; solo la
respuesta de análisis se publica en el Workspace. A día de hoy este atajo cubre
Web Relays ChatGPT, no Master Sessions ni otras plataformas. Para estas últimas,
la inspección disponible sigue siendo la herramienta MCP
`sentinel_inspect_instance` con `sourceId` exacto, de acuerdo con su contrato.

La supervisión periódica de salud sigue separada del análisis conversacional.
En el modo automático, cada mensaje nuevo autorizado se analiza individualmente
con Gemini y la respuesta aparece en el transcript del Workspace. Sentinel no
lee archivos de proyecto ni puede afirmar que verificó código; una tarjeta de
hallazgo ofrece preparar un borrador para que el usuario seleccione orquestador
o worker y pulse Enviar. No se ejecutan herramientas, encargos ni cambios de
código automáticamente. La revisión, el texto sensible y la disponibilidad del
servicio Gemini aún requieren verificación runtime en las plataformas reales.

## Dictado por voz en Workspace

El botón **Dictar** usa `SpeechRecognition` o `webkitSpeechRecognition` del
navegador disponible. Solo empieza tras el clic del usuario; la transcripción
se coloca en el composer asociado al destino activo y requiere un clic aparte
en **Enviar**. Cambiar destino detiene la escucha. El navegador puede enviar
audio a su proveedor de reconocimiento; el Workspace no puede garantizar que
la API use Windows Speech local ni que funcione sin conexión. Se informa esta
limitación en la interfaz y se debe conceder permiso de micrófono. Sentinel
puede elegirse como destino igual que un Relay, Master o participante IDE; el
envío de ese borrador a Gemini también requiere confirmación explícita.

## Consultas compartidas mediante MCP

Para observar los procesos, la vista principal es el journal estructurado
compartido, no la captura de pantalla:

- `openmcp_read_activity`: lee eventos retenidos con secuencia global y cursor
  (`afterSequence`), hasta 200 por consulta. Puede filtrar por agente y fuente.
- `openmcp_watch_activity`: long-poll de 1–20 segundos sobre el mismo journal.
  El caller conserva `nextSequence` y vuelve a llamar para continuar. Si entrega
  `agentIds`, solicita además por CDP los últimos eventos técnicos de esos
  relays durante la espera; lecturas simultáneas se deduplican por agente,
  timestamp, etapa y callId.

El journal, compartido por Sentinel, el coordinador y todos los clientes MCP
conectados al mismo proceso, registra metadatos de dispatch/completion/error MCP,
cambios de ciclo de vida, ejecuciones, diagnósticos y salud Sentinel, cambios
estructurados de colaboración y fases del coordinador/worker. Los eventos
incluyen número secuencial, hora, fuente e identidad disponible del agente;
el diagnóstico CDP incluye callId, etapa, nombre de herramienta, resultado y
presencia de IDs/visibilidad cuando la extensión los registra.

Los lanzamientos Relay que terminan con errores o con instancias parcialmente
disponibles también generan `relay:launch-warning` y, por cada fallo,
`relay:launch-instance-failure`. Incluyen plataforma, propósito, resultado y
texto acotado del diagnóstico, pero no prompts ni argumentos de herramientas.
El Workspace los presenta en **Alertas de lanzamiento** tanto en la vista
Clásica como en Canvas y permite asignar su revisión a las IDEs locales
seleccionadas; la asignación es manual y solicita diagnóstico sin modificar
código ni controlar instancias. Sentinel y otros clientes MCP pueden consultar
los eventos con `openmcp_read_activity` filtrando `sources: ["orchestration"]`.
Este historial es solo el búfer en memoria de hasta 2.000 eventos; no persiste
al reiniciar el proceso.

El cerebro Web admite varios candidatos coordinadores en un mismo lanzamiento,
hasta el límite total de 20 Relays y conservando al menos un worker. Son
alternativas elegibles (seleccionables desde el control del coordinador), no
orquestadores que planifican simultáneamente una misma tarea. Todos tienen rol
distinto (`primary`, `orchestrator-2`, etc.) y ocupan sus propios perfiles de
sesión; el contador de workers no incluye candidatos. No se permite abrir otro
pool Web mientras haya un coordinador activo, para evitar duplicar pools.

No almacena prompts, respuestas de modelos, comandos, valores de argumentos,
contenido de conversación, cookies ni capturas. Del plan coordinador solo
registra la fase y el tamaño de prompt/respuesta, no el texto. Es un buffer
acotado de hasta 2.000 eventos en memoria del proceso: se pierde al reiniciar,
puede indicar `truncated` si el cursor quedó atrás y no pretende ser un archivo
forense durable. El componente de ejecución conserva su propio log local en la
extensión. Para consultar un Relay real, el cliente solicita `agentIds`; no se
hace sondeo CDP continuo mientras ningún cliente esté observando.

El Sentinel Gemini integrado tiene una herramienta nativa
`openmcp_read_activity` que consulta el mismo journal y puede importar la
actividad allowlisted de hasta 10 relays seleccionados. El coordinador recibe
instrucciones para consultar el feed al diagnosticar ejecución; los workers
conectados al MCP comparten las herramientas `openmcp_read_activity` y
`openmcp_watch_activity`. Las fases del coordinador y las operaciones de
instancias iniciadas por Sentinel se escriben en ese journal sin guardar el
texto de prompts o respuestas. La sesión Copilot que responde aquí no queda
conectada automáticamente a ese cliente MCP; una herramienta instalada en el
repositorio no crea por sí sola un canal de eventos hacia esta conversación.

Herramientas puntuales adicionales:

- `sentinel_get_orchestration_state`: agentes/relays registrados, último
  resultado de Sentinel y hasta 50 entradas recientes del espacio de
  colaboración.
- `sentinel_list_instances`: lista agentes Web Relay y fuentes Master Session.
  Para cada Master verifica que el puerto CDP todavía pertenezca al perfil
  registrado y devuelve sus pestañas HTTP(S), incluso si no forma parte del
  pool de workers. Un puerto que no corresponde al perfil queda reportado como
  error de mapeo; no se adopta ni se abre automáticamente.
- `sentinel_inspect_instance`: acepta exactamente un `agentId` de Relay o un
  `sourceId` de Master Session. Para una Master consulta por CDP de solo lectura
  la plataforma/pestaña, título, URL, estado del documento, visibilidad/foco,
  presencia del composer, controles visibles de SuperAssistant, contexto
  aislado de la extensión y estado del registro del adaptador. La ausencia de
  un target de service worker por sí sola no significa que falte la extensión:
  MV3 puede suspender workers inactivos. La conversación se excluye por
  omisión; `includeConversation=true` solicita explícitamente hasta 12.000
  caracteres del texto renderizado del área principal para una Master. Para un
  Relay informa, en capas independientes, identidad/puerto, pestaña inequívoca,
  señales del DOM/composer, preferencias SA, worker activo, contexto de
  ejecución aislado y disponibilidad de `chrome.runtime.sendMessage`; también
  lee de forma read-only el PluginRegistry desde el contexto aislado: estado de
  inicialización, plugins base, fábricas de adaptadores y adaptador activo para
  la plataforma. Los adaptadores de otras plataformas deben estar registrados
  como fábricas, pero se inicializan solo al visitar su plataforma. La
  inicialización diferida consume la fábrica del adaptador activo; este se
  considera presente si su plugin aparece activo y registrado. Si falta una
  parte, Sentinel lo reporta como `sa-plugin-registry-incomplete`. Para el
  control
  visual devuelve por separado visibilidad, ubicación dentro del composer,
  dimensiones y visibilidad de etiqueta; para el sidebar devuelve el estado
  `collapsed` y ancho renderizado. En ChatGPT marca error si el botón no está
  confirmado compacto y dentro del composer, aunque el botón exista. Así no
  confunde preferencias persistidas con la interfaz efectivamente renderizada.
  Un worker MV3
  suspendido no se equipara a una extensión ausente. La salud y número de
  conexiones MCP siguen siendo del proceso completo, no prueban una conexión de
  ese Relay. La lectura de preferencias SA usa el mismo target CDP inequívoco;
  si la pestaña desapareció o hay varias, no elige otra por fallback. Para un
  Relay conserva el snapshot ChatGPT acotado documentado arriba. El texto se
  devuelve solo en la respuesta de la llamada y no se persiste.
- `sentinel_watch_interactions`: mantiene una llamada MCP abierta entre 1 y 20
  segundos y devuelve eventos de ciclo de vida, ejecución, Sentinel y
  colaboración/coordinación observados en ese intervalo. Con `agentIds` consulta
  además los eventos técnicos recientes del Relay cada 2 segundos. Para incluir
  texto de conversación debe indicarse `includeConversation=true` junto con un
  único ID ChatGPT; produce actualizaciones del texto renderizado durante la
  espera. El texto se excluye por omisión y los resultados siguen limitados al
  buffer temporal de la llamada.
- `sentinel_capture_instance_view`: devuelve una única captura JPEG del viewport
  del Relay registrado seleccionado. Exige `userApproved=true` tras aprobación
  explícita del usuario, estado `ready`, una pestaña inequívoca de la plataforma
  registrada y una conexión CDP activa. No enfoca, navega, recarga ni persiste
  la captura; el tamaño se limita a 5 MiB. Al ser una imagen de la página, puede
  contener texto sensible y el cliente MCP receptor puede conservar su propia
  copia. Es contexto visual complementario; no sustituye el journal de eventos
  ni explica causalidad o estados internos.

`openmcp_watch_activity` y `sentinel_watch_interactions` son long-polls, no
suscripciones push permanentes: el cliente debe volver a llamarlos con el
cursor. Solo los verá una IA cuyo cliente esté conectado al mismo MCP que posee
el registro de agentes y fuentes. Así, Sentinel, coordinador, workers y clientes
IDE pueden consultar la misma identidad operativa y la misma observación, sin
tener que adivinar un nombre o inspeccionar otra ventana. Cambios en findings,
requests e issues se reflejan como eventos estructurados, incluso al cambiar un
request a `fulfilled`. La captura es puntual, no una transmisión de pantalla ni
de video.

## Evaluación escalonada de un Relay

Para diagnosticar un Relay sin alterar la conversación, correlaciona primero
`agentId`, `instanceId`, puerto CDP y plataforma. Después valida, en este orden:

1. Estado de ciclo de vida (`sa_preparing` o `ready`) y puerto CDP alcanzable.
2. Una sola pestaña de la plataforma esperada; si hay varias, la inspección no
   selecciona una arbitrariamente.
3. Señales independientes de DOM SA, composer, visibilidad y foco.
4. Registro de plugins SA: inicialización, Remote Config y Sidebar, conjunto
   completo de fábricas integradas y adaptador activo que corresponde al Relay.
5. Preferencias SA frente a controles renderizados; en ChatGPT, ubicación y
   geometría compacta del botón, además del ancho/colapso del sidebar.
6. Worker de extensión y contexto aislado de la página; la
   ausencia del worker puede ser suspensión MV3, pero la ausencia del contexto
   sí se informa por separado.
7. Salud MCP global, sin interpretarla como prueba de conexión del Relay.
8. Solo con autorización explícita, una llamada E2E inocua correlacionada por
   call ID, identidad de Relay y eventos de dispatch/completion.

La inspección es read-only y no ejecuta esa última llamada. Un composer visible,
un worker activo, preferencias persistidas o un servidor MCP saludable son
señales parciales: ninguna por sí sola prueba una ejecución completa.
