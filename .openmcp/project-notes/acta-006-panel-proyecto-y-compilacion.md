# Acta 006 - Panel Proyecto, compilación y ediciones en paralelo

Fecha: 2026-10-20
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 a 005. Una acción por turno.
Último número de llamada usado antes de esta acta: 130.
Relación: complementa las actas 001 a 005 sin modificarlas.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado con la salida de un comando, [I] inferido, [R] corregido, [?] sin verificar.
Aviso: esta acta no contiene valores de claves.

## 1. Panel Proyecto: lo construido
- [C] Archivo nuevo src/services/webUI/projectNotes.ts: lista las actas de .openmcp/project-notes (título, fecha, aprobación, secciones), arma un resumen solo con las actas aprobadas (líneas [C] y [R], máximo 6000 caracteres) y contiene la página del panel. Solo lee; no escribe nada.
- [C] Archivo nuevo src/services/webUI/projectNotes.test.ts: 9 pruebas, todas pasan con bun 1.3.14. Usan actas inventadas en una carpeta temporal que se borra, y leen las actas reales sin escribir.
- [C] src/services/webUI/WebUIServer.ts: un import y dos rutas nuevas antes de la ruta del lienzo: GET /project (página) y GET /api/workspace/project-notes (con la misma validación de origen que el chat de instancia). La edición inicial fue de 17 líneas añadidas y ninguna borrada.
- [C] Commit local ebc2dad con solo esos tres archivos. La rama local respaldo/workspace-2026-10-19 no debe subirse a GitHub (su historial contiene claves de Google; ver acta 005).
- [C] Copia previa de WebUIServer.ts en .openmcp/backups/pre-prototipo-2026-10-19/WebUIServer.before-project-notes.ts, comprobada idéntica al original.
- [C] Con las cinco actas en PENDIENTE el resumen sale vacío. Es el comportamiento previsto.
- [C] La validación de origen frena a otras páginas web, pero no es autenticación. El servidor sigue escuchando en todas las interfaces (acta 001).
- [?] El panel no se ha visto todavía en un navegador.

## 2. Por qué todavía no se ve
- [C] El servidor del puerto 3007 se lanza con node dist/cli.mjs, es decir, desde código compilado. Las rutas nuevas devolvieron 404 porque dist no las contiene y el proceso arrancó antes de la edición.
- [C] Reiniciar con /mcp workspace stop y /mcp workspace no basta: hay que recompilar con bun run build (package.json, script build).
- [C] dist está ignorado por git. El build copia a dist workspace.html, workspace-canvas.html, launchDialog.js y workspaceLayout.js, así que publicará las ediciones en curso de esos archivos.
- [C] El build no borra dist antes de compilar (sin coincidencias de borrado en scripts/build.ts).
- [C] Copia de seguridad de cli.mjs y de los cuatro archivos web en .openmcp/backups/pre-prototipo-2026-10-19/dist-antes-de-recompilar, comprobada idéntica. No se copió el mapa de 47 MB.

## 3. Riesgo de compilar mientras se edita
- [C] scripts/build.ts reescribe temporalmente los archivos .ts y .tsx de src que contienen feature( y los restaura al terminar con su contenido inicial. Un guardado durante esa ventana se perdería en esos archivos.
- [C] 150 archivos de src contienen feature(. Ninguno de los cuatro .ts que se editaban (WebUIServer.ts, integration.ts, WorkspaceInstanceChatStore.ts y la prueba del chat) lo contiene.
- [C] A las 22:43 ningún archivo con feature( se había guardado en las últimas 3 horas, incluidos los sin seguimiento.
- Recomendación: compilar en una pausa, sin guardar archivos durante la compilación, y hacerlo el usuario en su terminal. Compilar a través del puente puede agotar el tiempo (error -32001, visto antes con una búsqueda pesada).

## 4. Desarrollo en paralelo
- [C] El usuario sigue editando el proyecto. Desde el commit ebc2dad, WebUIServer.ts tiene 33 líneas añadidas y 1 borrada que no son de esta sesión; mis rutas y el import siguen presentes. Sintaxis correcta y 9 pruebas pasando con esas ediciones encima.
- [C] Archivos rastreados con cambios sin guardar en git a las 22:30: WebUIServer.ts, WorkspaceInstanceChatStore.ts, integration.ts, workspace-canvas.html, workspace.html, workspaceInstanceChatUi.browser.test.ts y workspaceLayout.js. Se vieron además archivos nuevos: chatHistoryRedaction.ts, una prueba de retención del almacén de chats y los cuatro archivos Laptop de colaboración (acta 003).
- [C] Los archivos Laptop (LaptopGateway, LaptopPairingStore) no estaban conectados a ningún otro archivo cuando se miraron. Guardan solo huellas SHA-256 de tokens, con códigos de emparejamiento que caducan a los 10 minutos.
- [R] Dije varias veces que nadie editaba los archivos en ese momento. Era falso: había ediciones durante la sesión.
- [R] Dije que el tramo del servidor que entrega archivos podía ser un riesgo. Solo entrega dos archivos con nombre fijo (launchDialog.js y workspaceLayout.js).
- [R] La comprobación de 20 segundos con la hora de Windows no valía: la hora se calculó una vez, antes de la pausa.

## 5. Pendiente
- Usuario: compilar y reiniciar el servidor; revocar las cuatro claves (acta 005); aprobar las actas; decidir si .openmcp/backups y .openmcp/workspace-launches van a .gitignore.
- Proyecto: comprobar /project y el punto de lectura tras compilar (esperado: 5 actas, 0 aprobadas, resumen de 0 caracteres); confirmar que el servidor se lanza desde la carpeta del proyecto, porque el panel busca las actas desde la carpeta de arranque.
- Proyecto: sacar las claves del código y de las guías para leerlas desde el .env; solo con confirmación del usuario, porque son archivos que también edita él.
- Siguiente pieza del prototipo: entrega del resumen por customInstructions (acta 004) y notas por recuadro de instancia, usando el par instanceId y conversationId (acta 003).
- Subir esta acta y los commits nuevos a GitHub solo desde la carpeta openMCPWEBLOCK-snapshot, nunca desde la rama local con claves.
