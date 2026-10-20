# Transferencia a Claude Desktop: pruebas de Auto Execute para Sentinel

## Objetivo

Continuar las pruebas de Auto Execute y entrega de resultados MCP con el contexto ya reunido. Avanzar una prueba delimitada por vez; no repetir el análisis desde cero ni ejecutar una batería completa sin revisar cada resultado.

## Estado conocido

- T-025 corrigió la selección de Auto Execute: exige una tarjeta coincidente visible con botón Run habilitado, crea el claim después de encontrar el objetivo y solo libera bajo Web Locks el claim propio pre-despacho que sigue sin `executionId`/`executionKey`.
- Sentinel tiene un registro y diagnóstico determinista por etapas en `src/services/webRelay/orchestration/SentinelEvidence.ts`.
- En una prueba real se observaron `AUTO_EXECUTION_TRIGGERED`, `GET_EXECUTION_RESOLVED=success`, `RESULT_INSERTION_SUCCEEDED` y `DELIVERY_MARKED_DELIVERED`. El usuario visualizó la ventana, así que esa ejecución no demuestra funcionamiento desatendido.
- Una prueba en pestaña oculta no aisló el foco: preparar el composer activó el foco y no se observó una nueva tarjeta MCP. No atribuir ese resultado al foco como causa.
- El ciclo auténtico de herramienta oculta ya se reprodujo en OpenMCP; queda capturar la respuesta final del modelo después de Auto Submit y cuantificar fiabilidad. No repetir llamadas pendientes a ciegas ni insertar `executionId` artificial.
- Las últimas validaciones de código: pruebas selección/storage 21/21, Sentinel/evidencia 41/41; build CLI y content script pasan. El navegador disponible para la sesión anterior solo mostró `about:blank`; por tanto, no se pudo observar desde allí la conversación activa. El type-check global todavía reporta errores en `SentinelConsole.tsx`.
- Evidencia T-050 (2026-10-07): dos relays ChatGPT autenticados completaron Read en hidden/unfocused hasta `EXECUTION_CREATED` con ID real, dispatch, completion success, inserción y Auto Submit. El collector entregó una de esas trazas 91 s tarde y la otra hasta 235 s tarde; ordenar por timestamp de origen y calcular `receivedAt - timestamp` antes de llamar fallida a una corrida.
- Nueva repetición PASS (2026-10-08): relay autenticado OpenMCP recién lanzado, Read real de solo lectura, `executionId` y `executionKey` reales, dispatch/completion success, inserción y Auto Submit; 52/52 muestras hidden/unfocused, timer probe oculto disparado, brecha a Auto Submit de 2607 ms y lag diagnóstico máximo de 1774 ms. El harness correlacionó eventos desde `chrome.storage.local` y el collector. La instancia de prueba se cerró (:9222 libre); MCP :3006 y Master :9227 siguieron activos.
- El harness calcula ahora la brecha de visibilidad con la última muestra en o antes del timestamp de Auto Submit. Este caso pasó; si hay futuras discrepancias, comparar la copia durable y `receivedAt - timestamp` antes de repetir. Los relays nuevos se inician minimizados con throttling de timer/background renderer desactivado. No afirmar universalidad, respuesta final del modelo tras Auto Submit ni causa única del error de executionId.
- Concurrencia OpenMCP (2026-10-08): dos relays autenticados recién lanzados recibieron llamadas Read con IDs distintos en el mismo milisegundo; ambas generaciones se observaron activas a la vez. Los dos ciclos llegaron a ejecución MCP exitosa, inserción y Auto Submit con cada relay hidden/unfocused/minimized en 76/76 muestras, timer probes activos, lag del collector máx. 20/28 ms y cero restores. Los dispatches Read duraron ~21/~24 ms y empezaron separados por ~2.2 s: se demuestra trabajo de agentes en paralelo y ejecución oculta de ambos, no solapamiento temporal de las operaciones MCP. Una corrida previa detectó una restauración de ventana no enfocada y se abortó; registrarla, no borrar ni convertir a PASS.
- El acceso directo `C:\Users\elias\OneDrive\Desktop\OpenMCPWEBLOCK.lnk` fue leído y apunta a `node dist\cli.mjs`; el test reutilizó ese servidor MCP ya activo y lanzó dos relays mediante `createAgent/startAgent` del `MultiAgentRunner`. No condujo el menú interactivo con teclas. Para validar el trayecto que usará el usuario, ejecutar `/mcp set-mode web` → **Relay profiles** → **Agent mode** → ChatGPT → 2 instancias autenticadas (misma Master source), y después mantener el procedimiento correlacionado por callId de cada relay. No reportar un PASS del menú por evidencia de la API.
- Intento de probar dispatch MCP simultáneo con dos Bash inocuos que solo esperan 8 s y escriben un token: el preflight encontró la Master `loco-verde` inactiva (`Master session Chrome is not running`) y abortó antes de crear/iniciar agentes. Cero prompts y cero relays; no clasificar como fallo de herramienta. Reanudar cuando la Master se encuentre activa, o después de que el usuario abra la fuente desde el CLI. Entonces exigir intervalos de dispatch/completion solapados, no solo generaciones simultáneas.
- Requisito de reanudación: una lectura final encontró sin listeners tanto :3006 como :9227; el ensayo abortado no había lanzado Chrome ni cerrado procesos existentes. No inferir causa ni volver a probar hasta verificar MCP/relay API en :3006 y una Master autenticada activa en :9227.
- Sentinel ahora presenta `CHATGPT_HIDDEN_EXECUTION_EVIDENCE` y distingue `UNATTENDED_TOOL_DELIVERY_VERIFIED` (entrega de herramienta, respuesta final no capturada) de `UNATTENDED_FLOW_VERIFIED` (ciclo conversacional completo). Si `diagnosticTransportLagMs > 30 s` con ejecución MCP exitosa, clasifica `EXECUTION_DIAGNOSTICS_DELAYED`; inspeccionar origen/almacenamiento durable antes de repetir.

## Ruta para revisar la evidencia de Sentinel

En el CLI:

1. Ejecutar `/mcp sentinel`.
2. Elegir **“Evidencia y diagnóstico de llamadas MCP”**.
3. Revisar por separado **Observado**, **No demostrado**, diagnóstico actual y **Comprobación recomendada**.

Implementación:

- `src/commands/mcp/SentinelConsole.tsx`
- `src/services/webRelay/orchestration/SentinelEvidence.ts`
- `src/services/webRelay/orchestration/SentinelEvidence.test.ts`
- `QUICK_START_WEB_RELAY.md`
- `.agents/BLOQUEANTES.md`

El escaneo de salud de Sentinel es pasivo; no ejecuta herramientas ni certifica ausencia de foco.

## Cómo inventariar las ventanas sin empezar a controlarlas

Primero averiguar qué superficies de observación están realmente disponibles en tu sesión. No asumir que el Chrome personal con la conversación es el Chrome que expone CDP.

1. Si tienes una herramienta de páginas del navegador, listar las páginas abiertas y anotar únicamente ID, host/título no sensible y si aparece la conversación esperada. Esa lista describe solo el navegador que esa herramienta controla; no prueba que sea el Chrome del usuario.
2. Si no ves el Chrome esperado, indicarlo explícitamente. No declarar que la conversación no existe ni tratar `about:blank` como evidencia del estado de otra ventana.
3. Como alternativa de solo lectura, consultar localmente `http://127.0.0.1:<puerto>/json/version` y `/json/list` para los puertos CDP candidatos. El rango gestionado por el proyecto comienza en 9222 y puede asignar puertos superiores; 9222–9227 se han usado en pruebas anteriores, pero no se deben asumir activos ni asignarles identidad por el número.
4. Antes de asociar un puerto a un relay, verificar su propietario y perfil (PID/argumentos `user-data-dir`, identidad del agente registrada). Un puerto es transporte, no identidad.
5. No imprimir ni guardar cookies, local/session storage, tokens, contenido privado de chats ni URLs con identificadores. Basta con registrar estado de conexión, puerto, tipo de target, host y resultado de la asociación, redactando lo demás.
6. No navegar, enfocar, hacer clic, cerrar, lanzar ni enviar mensajes durante el inventario. Cualquier interacción puede alterar el estado de foco que se intenta medir. Si la conversación no expone CDP y no está en la herramienta de navegador, declarar ese límite y detenerse en esta fase.

## Secuencia de contribuciones: ejecutar una sola fase por vez

### Fase 1 — Inventario de accesibilidad (única tarea inicial)

Prompt:

> Continúa T-025 usando `.agents/prompts/claude-desktop-sentinel-testing.md`, `.agents/ESTADO.md`, `.agents/TAREAS.md` y `.agents/BLOQUEANTES.md`; no empieces desde cero. Haz únicamente un inventario de solo lectura de las superficies de navegador y puertos CDP que puedes observar ahora. Determina si puedes observar el Chrome que contiene la conversación activa, sin asumir que una página `about:blank` representa ese Chrome. Si no puedes acceder, dilo claramente. No enfoques, navegues, hagas clic, abras ni cierres ventanas; no envíes prompts ni ejecutes herramientas; no leas cookies, storage ni contenido de chats; no modifiques código. Devuelve: (1) superficies disponibles, (2) ventanas/puertos observables con identidad verificada o “no verificada”, (3) límites, (4) si es seguro pasar a una siguiente fase. Detente al terminar este inventario.

### Fase 2 — Revisión de la evidencia existente

Ejecutar solo después de revisar y aceptar el inventario de Fase 1.

Prompt:

> Lee la evidencia ya guardada para T-025 y la sección `Evidencia y diagnóstico de llamadas MCP` de Sentinel. No abras ni controles ventanas y no ejecutes herramientas. Compara el registro durable con `.agents/BLOQUEANTES.md`; identifica solo discrepancias, afirmaciones que excedan la evidencia o el próximo dato mínimo que falta. No edites archivos. Devuelve una lista breve separando observado, inferido y no observable.

### Fase 3 — Preflight de una sola instancia

Requiere elegir explícitamente una instancia segura y verificar su identidad. No lanzar perfiles nuevos ni cambiar preferencias SA.

Prompt:

> Sobre una única instancia que yo haya identificado y autorizado, haz solo un preflight de lectura: verifica puerto/PID/perfil, host y pestaña objetivo, disponibilidad de SuperAssistant/MCP y toggles relevantes. No alteres preferencias, no navegues, no enfoques la pestaña y no envíes mensajes. Si no puedes verificar que el puerto corresponde al perfil esperado, detente. Devuelve evidencia redactada y una decisión PASS/BLOCKED para preparar una prueba aparte.

### Fase 4 — Diseñar una prueba E2E aislada (no ejecutarla todavía)

Requiere que Fases 1–3 sean PASS y consentimiento explícito antes de cualquier envío.

Prompt:

> Diseña un protocolo para una sola petición inocua que permita registrar solicitud enviada, respuesta del modelo, tarjeta coincidente visible, claim, identidad real, despacho MCP, inserción, auto-submit y respuesta final. Antes de proponer ejecución, explica cómo se mantendrán y medirán visibilidad/foco sin que la instrumentación enfoque o active la página. No modifiques el prompt Original, no repitas una llamada pendiente y no inventes executionId. Si no existe una forma fiable de enviar manteniendo el estado de foco requerido, declara que el experimento no es aislable y no lo ejecutes.

### Fase 5 — Preflight de una instancia Claude web

La base de navegación/inyección para Claude web ya se implementó, pero aún no se ha validado en Chrome real. Esta fase es únicamente de disponibilidad; no enviar un mensaje ni ejecutar una herramienta.

Prompt:

> Continúa el trabajo existente; no repitas T-026 ni vuelvas a implementar el soporte. Revisa los cambios actuales para `claude.ai` y verifica una sola instancia con `/mcp set-mode web`: plataforma Claude, propósito **User mode**, cantidad 1, perfil **Guest / clean**. User mode mantiene la prueba fuera del pool Web Relay existente. Usa la extensión construida con los cambios actuales. Permite que el wizard configure SuperAssistant como parte normal de la preparación; no cambies toggles manualmente. No uses una Master Session, no copies cookies y no envíes mensajes ni ejecutes tools. Comprueba solo que el relay fue a `https://claude.ai`, la identidad del puerto corresponde al perfil recién creado, el content script/SA aparece y Sentinel puede inspeccionar la configuración. Si aparece login, detente y reporta BLOCKED hasta que el usuario decida iniciar sesión manualmente en esa ventana. No cambies el prompt Original ni alteres otra instancia; deja una instancia que pase abierta para inspección y reporta ID, puerto, estado, observaciones redactadas y límites. Detente al concluir.

Claude web no usa la transferencia de Master Session, que actualmente está implementada para ChatGPT. No seleccionar `Authenticated`. La selección de plataforma es global hoy; no asumir que Claude y ChatGPT pueden coexistir todavía en el mismo pool.

### Fase 6 — Una petición inocua en Claude web (pendiente de autorización)

Solo después de que el usuario revise y acepte el preflight de Fase 5, y confirme que hay una sesión Claude utilizable.

Prompt:

> Con la única instancia Claude del preflight ya aprobada, propón primero una petición inocua personalizada y observable para probar una respuesta simple, sin herramientas ni cambios de estado. No envíes nada todavía: muestra el texto exacto y espera confirmación. Después de la aprobación, ejecuta una sola petición, confirma respuesta final y guarda evidencia redactada. No atribuyas éxito de Auto Execute ni de llamadas MCP porque esta fase no las prueba. Detente al reportar.

### Fase 7 — Herramienta MCP en Claude web (posterior, una sola llamada)

Requiere que Fase 6 pase y autorización explícita para la herramienta/recurso concreto.

Prompt:

> Diseña y solicita aprobación para una sola llamada MCP inocua en Claude web. Antes de ejecutar, verifica que el build/instancia corresponda a la extensión actual y explica qué campos/eventos capturarás: llamada observada, identidad de ejecución real, resultado, inserción, envío y respuesta final. No inventes IDs, no repitas llamadas pendientes y no cambies el prompt Original. Ejecuta solo después de mi confirmación explícita; al primer resultado ambiguo detente sin reintentar.

## Reglas de colaboración

- Completar y reportar una fase antes de pedir la siguiente. No combinar fases.
- Separar claramente **hecho observado**, **hecho del código**, **inferencia** y **no observable**.
- Preservar el prompt Original de SuperAssistant; cualquier prompt de prueba debe ser explícitamente personalizado y aprobado.
- No cambiar `ExecutionRegistry`, `mcp-client.ts`, router o bridge para “arreglar” la prueba sin evidencia nueva y autorización específica.
- No tocar ventanas autenticadas, enviar mensajes ni ejecutar tools sin autorización explícita del usuario para esa fase.
- Anotar la evidencia obtenida en Sentinel y en `.agents/BLOQUEANTES.md` solo después de verificarla; no convertir inferencias en hechos.
- Claude web es una plataforma seleccionable, pero su soporte en Chrome real aún requiere validación; la transferencia Master está soportada actualmente solo para ChatGPT.
- El pool/orquestador usa hoy una plataforma seleccionada globalmente; no declarar soporte de un pool mixto ChatGPT+Claude sin implementación y prueba específicas.
