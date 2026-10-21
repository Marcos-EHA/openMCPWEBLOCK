# Acta 007 - Dónde viven las instrucciones y cómo se identifica instancia y chat

Fecha: 2026-10-20
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 a 006. Una acción por turno.
Último número de llamada usado antes de esta acta: 137.
Relación: complementa las actas 001 a 006 sin modificarlas. Sus correcciones están en la sección 5.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado con la salida de un comando, [I] inferido, [R] corregido, [?] sin verificar.
Aviso: esta acta no contiene valores de claves.

## 1. Dónde viven las instrucciones de la barra de SuperAssistant
- [C] La tienda de preferencias de la extensión (chrome-extension/source/pages/content/src/stores/ui.store.ts) persiste con zustand sobre el almacenamiento local de la página, bajo el nombre mcp-super-assistant-ui-store. Persiste el estado de la barra lateral, las preferencias del usuario, el tema y el interruptor de MCP.
- [C] Las instrucciones personalizadas, el prompt propio del popover y el interruptor del modo agente son preferencias (actas 004 y 006), así que viven en esa tienda. Lo que no se persiste es el texto dinámico del modo agente.
- [I] El almacenamiento local de una página es propio de cada sitio y de cada perfil de Chrome. Los Relay usan perfiles aislados, así que cada instancia necesitaría su propio resumen.
- [C] utils/storage.ts guarda otras preferencias en chrome.storage.local con otra clave (mcp_sidebar_preferences). En los .ts y .tsx de la extensión solo ese archivo la lee [I: código heredado].
- [C] El proyecto lee la tienda de la página desde SAStartupAutomationControls.ts y SAHealthCheck.ts. En src/services/webRelay no encontré escrituras reales en ella: las que aparecen están en una prueba [?: búsqueda limitada a .ts de esa carpeta].
- [I] Escribir en esa tienda desde fuera con la página abierta no sería fiable: la tienda carga su valor al abrir y podría sobrescribirlo en su próximo guardado. Habría que recargar la página, lo que interrumpe una Master. No se probó.

## 2. Identidad de instancia (la estampa el sistema, no la IA)
- [C] src/services/webRelay/ChromeCDP.ts define la clave mcp:instance-identity (cerca de la línea 1474). stampInstanceIdentity abre una sesión de depuración con el proceso de fondo de SuperAssistant, escribe en chrome.storage.local un objeto con número de esquema, hora de estampado y los campos de identidad, y lo vuelve a leer para comprobarlo.
- [C] Es idempotente. El comentario del código explica que sobrevive a los reinicios del proceso de fondo, a diferencia de un identificador en memoria, y que sirve para poder dirigirse de nuevo a ese agente más tarde.
- [C] La estampan MultiAgentRunner.ts (cerca de la línea 1061) y WebRelayProvider.ts (cerca de la 1041). La leen MultiAgentRunner.ts (cerca de la 695 y la 753) y WebInstanceRegistry.ts, cuya función verifyInstanceIdentity (cerca de la 251) se describe como obligatoria antes de enviar órdenes.
- [C] Las fuentes de la extensión que se buscaron no contienen la clave literal: la lee el proyecto por CDP, no la extensión.
- [?] No se leyó qué campos tiene la interfaz InstanceIdentity (ChromeCDP.ts, cerca de la línea 1461).
- [?] No se sabe si una Master recibe el sello.

## 3. Identificador de chat
- [C] chrome-extension/source/pages/content/src/services/pageConversationCapture.ts usa location.pathname como conversationId y lo actualiza cuando cambia. El archivo estaba sin seguimiento en git.
- [I] En un chat nuevo ese camino probablemente es la raíz del sitio y cambia al enviar el primer mensaje. Sin comprobar.
- [C] El almacén de chats del workspace (acta 003) usa main por defecto como conversationId de una Master. No vi que lo enlace con el camino de la página [I: son dos capas de identificación separadas].

## 4. Consecuencias para el diseño (propuestas, nada implementado)
- Clave de chat para las notas: sello de instancia más conversationId. El sello lo pone el sistema; el conversationId sale de la página, no de la IA.
- Cada nota guardaría el par y marcaría lo desconocido como desconocido. Hay que tratar un camino igual a la raíz como chat aún sin identificar.
- Entrega del resumen: manual en la primera versión. El panel Proyecto lo muestra y el usuario lo pega en las instrucciones personalizadas de la barra, que no interrumpe la conversación. La entrega automática exigiría escribir la tienda de la página y recargarla.
- Antes de implementar: enlazar el conversationId de la página con el del almacén de chats del workspace.

## 5. Correcciones
- [R] Acta 004, sección 3: el soporte físico de las preferencias era desconocido. Es el almacenamiento local de la página.
- [R] Actas 001 y 003 decían que no se sabía cómo se calcula el conversationId capturado desde la página. Es el camino de la URL.
- [R] Dije que nadie leía el sello de identidad porque mi búsqueda en la extensión salió vacía. Lo leen el proyecto (por CDP) y el registro de instancias.
- [R] Acta 004 dejó abierto si el proyecto puede escribir preferencias de la extensión. Escribe la identidad en chrome.storage.local, que es un almacenamiento distinto del de las instrucciones.

## 6. Estado y pendiente
- [C] En GitHub, rama respaldo/snapshot-2026-10-20, commit 8b8515a: acta 006, projectNotes.ts y su prueba. Las rutas del panel en WebUIServer.ts siguen solo en el commit local ebc2dad, porque ese archivo lleva ediciones del usuario.
- [C] El panel no se ve hasta compilar: el servidor corre desde dist y la compilación la hace el usuario en una pausa.
- Usuario: compilar y reiniciar, revocar las cuatro claves (acta 005) y aprobar las actas.
- Proyecto: leer la interfaz InstanceIdentity, comprobar si una Master recibe el sello y enlazar los dos identificadores de chat.
- Esta acta no está en GitHub todavía. Se sube solo desde la carpeta openMCPWEBLOCK-snapshot.
