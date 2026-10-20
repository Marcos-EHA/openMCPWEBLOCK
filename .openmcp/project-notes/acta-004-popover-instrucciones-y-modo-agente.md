# Acta 004 - Popover de instrucciones, modo agente y diseño del prototipo

Fecha: 2026-10-19
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 a 003. Una acción por turno.
Último número de llamada usado antes de esta acta: 81.
Relación: complementa las actas 001 a 003 sin modificarlas. Sus correcciones están en la sección 6.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado en el código (archivo y función), [I] inferido, [R] corregido, [?] sin verificar. Las líneas se mueven: anclar a nombres de función y a la fecha de modificación.
Alcance: solo lectura de la extensión (carpeta chrome-extension/source/pages/content/src). No se abrió su archivo .env y no debe abrirse. No se modificó nada.
Aviso: este texto no cita a propósito la cabecera literal de la plantilla de capacidades de SuperAssistant del proyecto.

## 1. Las dos interfaces que inyecta la extensión
- [C] Barra lateral (components/sidebar): incluye el panel Instructions (InstructionManager.tsx, instructionGenerator.ts, instructionGeneratorJson.ts, website_specific_instruction con archivos por sitio) y su automatización por CDP desde el proyecto (src/services/webRelay/SAStartupAutomationControls.ts muestra o minimiza la barra, hasta unos 56 píxeles).
- [C] Popover junto al campo de texto del chat (components/mcpPopover/mcpPopover.tsx, componente MCPPopover): acciones Copiar, Insert (handleInsert), Attach (handleAttach) y interruptores de auto-insertar, auto-enviar y auto-ejecutar.
- [C] Ambas vistas leen el mismo estado global en memoria (instructionsState); un comentario del código dice que el panel de la barra lateral es la fuente de verdad.
- [C] Attach crea un archivo llamado superassistant-instructions.txt, o imágenes del texto (mcpPopover.tsx, cerca de la línea 1047).

## 2. Variantes de prompt y selección
- [C] selectPrompt.ts: variantes original, jsonl, claude, custom y agent-dynamic, más guest-image, que toma otra como fuente.
- [C] Si agentPromptEnabled está activo, Insert y Attach usan siempre el texto dinámico y ignoran la variante elegida, incluida custom. No se comprueba si está vacío.
- [C] La variante custom inserta solo preferences.customPrompt (textarea Your prompt, visible con la variante custom).

## 3. Persistencia
- [C] Las preferencias customInstructions, customInstructionsEnabled, customPrompt, agentPromptEnabled, promptVariant y autoInsert se guardan con updatePreferences (useUserPreferences en hooks/useStores.ts).
- [C] stores/ui.store.ts usa persist de zustand con createJSONStorage; el comentario de la línea 305 habla de persistir el estado de la barra y las preferencias de usuario. No vi la lista exacta de campos persistidos ni el backend físico [?].
- [C] utils/storage.ts guarda SidebarPreferences en chrome.storage.local (con customInstructions y customInstructionsEnabled) y los permisos de herramientas en localStorage. No sé si ese guardado y el de zustand son el mismo [?].
- [I] Si el backend es el almacenamiento de la página, las preferencias son por sitio y por perfil de navegador. Los Relay usan perfiles aislados, así que cada instancia necesitaría su propio valor. Sin comprobar.
- [C] El texto dinámico (instructionsDynamic) vive en instructionsState, en memoria; su valor inicial es una cadena vacía. No vi que se guarde.

## 4. Modo agente (prompt dinámico): lógica y fallos
- [C] generateDynamicInstructions llama a generateInstructions con las herramientas habilitadas, customInstructions y customInstructionsEnabled (InstructionManager.tsx, ~línea 210). instructionGenerator.ts añade las instrucciones personalizadas al final si están activadas y no vacías (~líneas 310-312). La variante jsonl las añade bajo el rótulo Additional user instructions (instructionGeneratorJson.ts, ~línea 36).
- [C] La variante claude se genera sin parámetros (generateClaudeInstructionsJson, ~línea 82): no incluye instrucciones personalizadas. Cuándo se elige esa variante: no sé [?].
- [C] Un intervalo de 500 ms regenera los textos y los reemplaza solo si hay herramientas cargadas (InstructionManager.tsx, ~líneas 277-305). Esto afecta al texto generado, no a customInstructions, que es su entrada.
- Fallos de lógica: (a) [C] sin respaldo cuando el texto dinámico está vacío, p. ej. con el servidor MCP sin conectar; Insert diría No Content en vez de usar el prompt estático. (b) [C] prioridad silenciosa del modo agente sobre la variante elegida. (c) [I] el campo Your prompt sigue visible aunque el modo agente lo anule; sin leer su condición completa. (d) [I] el texto dinámico lista todas las herramientas habilitadas en la extensión, mientras que el proyecto manda su propia plantilla (7 herramientas de respaldo para una Master); la instancia podría ver dos listas distintas. (e) [I] preferencia persistente y texto efímero.
- [C] src/services/webRelay/WebRelayProvider.ts no menciona agentPromptEnabled, customInstructions ni customPrompt. Que el proyecto pueda escribir esas preferencias por CDP: no comprobado [?].

## 5. Consecuencias para el diseño (propuestas, nada implementado)
- Enganche candidato para el resumen del proyecto: customInstructions con su interruptor activado, porque entra al generador, sobrevive a la regeneración y llega a las variantes dynamic y jsonl. No llega a custom ni, por la firma, a claude.
- Entrega manual como primera versión: el espacio de trabajo muestra el resumen listo para pegar en ese campo. Entrega automática por CDP: solo si se comprueba que el proyecto puede escribir esa preferencia.
- Panel Proyecto en la página del espacio de trabajo, hermano de Lienzo Curado dentro de Espacio Conjunto (workspace.html, ~línea 275): lista las actas con estado y aprobación mediante un endpoint GET nuevo con validación de origen, copiando el de instance-chat (WebUIServer.ts, ~línea 376).
- Recuadros de instancia: mostrar las notas de cada instancia junto a su chat, reutilizando la clave instanceId más conversationId (workspace.html, instanceChatKey).
- Resumen acotado en tamaño: lo aprobado por el usuario como instrucciones y lo escrito por una IA como dato. El resumen no debe contener la cabecera literal de la plantilla del proyecto.
- Mejoras a la extensión que requieren decisión del usuario: respaldo cuando el texto dinámico esté vacío, desactivar o avisar en el campo Your prompt con el modo agente activo, incluir instrucciones personalizadas en la variante claude, y una sola lista de herramientas.

## 6. Correcciones
- [R] Había tomado la barra inferior de la terminal (PromptInputFooter.tsx) por la interfaz compacta. Es otra cosa: la compacta es el popover del input de la página.
- [R] Había dicho que el popover no guarda las instrucciones. Guarda varias preferencias; lo que no se guarda es el texto dinámico.
- [R] Había dicho que lo que se pisa cada 500 ms impedía poner un resumen desde fuera. Aplica al texto generado, no a customInstructions.
- [R] Había atribuido el marcador sin sustituir del archivo de instrucciones a la plantilla de la extensión. El contenido parece texto escrito por el usuario (variante custom, sin comprobar); el nombre del archivo coincide con el de Attach.
- [R] Había supuesto una escritura de preferencias por CDP a partir de un mensaje de error; no se encontró en WebRelayProvider.ts.
- [R] Había propuesto un segundo mensaje por la terminal para el resumen; queda sustituido por customInstructions como vía candidata.
- [R] Las acciones 74, 78 y 80 se repitieron con el mismo número porque la primera versión no se ejecutó.

## 7. Respaldo y estado
- [C] Copia hecha el 2026-10-19 en .openmcp/backups/pre-prototipo-2026-10-19: 20 archivos de src/services/webUI y 12 de src/services/collaboration. No se comprobó que sea idéntica al original [?].
- [C] Sigue sin tocarse el código del proyecto y de la extensión. Los archivos sin seguimiento en git siguen sin commit (ver acta 003).

## 8. Pendiente
- Leer dónde persiste createJSONStorage en ui.store.ts y qué campos guarda; cuándo se elige la variante claude; de dónde sale el prompt original.
- Comprobar si el proyecto puede escribir preferencias de la extensión por CDP.
- Leer onInstanceChatSend en integration.ts desde la línea 440 y el resto de WorkspaceInstanceChatStore.ts.
- Decisiones del usuario: aprobar las actas, commit o copia de lo no versionado, .gitignore de .openmcp/project-notes, cambios en la extensión, delegación (en pausa) y consumidor de peticiones pendientes.
