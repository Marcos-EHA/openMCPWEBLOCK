# Workspace: propósito, funcionamiento y evolución

Documento de trabajo — 2026-10-14. Exploración y desarrollo mediante ChatGPT y SuperAssistant. Los apartados de diagnóstico corresponden a la revisión estática; las propuestas se distinguen de la implementación indicada a continuación.

## Actualización: organización flexible implementada

Se añadió workspaceLayout.js, compartido por workspace.html y workspace-canvas.html, servido por WebUIServer e incluido por scripts/build.ts. La primera apertura muestra una distribución mínima de conversación. Componentes permite mostrar/ocultar apartados; Trabajo muestra los componentes actuales. Cómo funciona abre una guía visible con propósito, destinos, relación entre componentes y límites. Cada apartado ofrece explicación, movimiento con flechas o arrastre dentro de su vista, tres anchos y altura ajustable. Restaurar distribución vuelve a la presentación mínima. La configuración se guarda en localStorage de este navegador/origen; no está sincronizada entre dispositivos ni vinculada todavía a un proyecto.

Ocultar apartados no cierra instancias ni detiene tareas. Se conservan los nodos y los controles originales; un MutationObserver incorpora paneles de agentes nuevos y elimina envoltorios de paneles retirados. Se mantienen las dos páginas existentes y el cambio instantáneo de vistas de la principal. Los apartados auxiliares comparten una zona inferior; aún no existe movimiento libre entre todas las zonas ni acoplamiento de ventanas.

Validación realizada: 24/24 pruebas PASS, 182 expectativas, combinando WebUIServer.test.ts con ocho pruebas de navegador de workspaceLayout.browser.test.ts. Se probaron ambas páginas con su HTML/CSS real, aislando transporte y despacho: visibilidad de vista activa, cambio de vista, conservación de controles al ocultar/recuperar, paneles dinámicos y retirada, preferencias tras recarga, movimiento con flechas y altura guardada, guía en pantalla estrecha. La prueba de altura establece el valor y comprueba persistencia; no valida el gesto nativo de redimensionar. El arrastre está implementado pero aún no fue probado con interacción física. node --check, bun run build y git diff --check focalizado PASS. Log: logs/workspace-layout-final.txt.

Runtime: /health, /workspaceLayout.js y /api/status de 127.0.0.1:3007 no respondieron al comprobarlos. No hay prueba de uso real ni evaluación visual por el usuario todavía. La aplicación compilada debe abrir el Workspace para continuar. No se han lanzado instancias ni enviado peticiones durante esta implementación.

Siguen pendientes: estados fiables de sistema/curador descritos abajo, componente específico de flujo de trabajo con correlación real, pendientes persistentes, guía de desarrollo completa accesible desde la UI y validación end-to-end con agentes. La ayuda visible resume la documentación; no carga el archivo completo. Las secciones posteriores tituladas propuesta u orden recomendado conservan ese carácter y deben revisarse conforme avance el trabajo.

## Seleccionar y enviar a conversaciones locales de Antigravity

En las secciones locales de ambas vistas de Workspace, abre el historial de conversaciones. Se muestran hasta 100 chats recientes identificados en el índice local de Antigravity. Pulsa **Usar chat** para abrir un chat existente; el botón **Nuevo chat** abre la ruta nueva de la aplicación. La selección también cambia el destino del composer de Workspace a esa instancia.

El envío usa CDP directamente contra la aplicación local, comprueba que el puerto DevTools pertenece al PID de la instancia seleccionada y valida que el ID del chat siga presente en el índice. Antes de escribir y justo al pulsar Enviar vuelve a comprobar que el modelo visible sea **Gemini 3.8**. El modelo no se cambia automáticamente: si la app muestra otro, el envío se rechaza y el borrador de Workspace se conserva.

Workspace solo reporta el despacho; no recibe ni inventa una respuesta del modelo. Si Antigravity no confirma que aceptó el texto, la interfaz advierte que el resultado es incierto y bloquea otro envío hasta revisar y volver a seleccionar el chat. La inspección runtime de esta implementación fue de solo lectura; no se envió un mensaje real.

## Propósito

El Workspace reúne el trabajo realizado con interfaces web de IA y permite colaborar con agentes IDE. Debe permitir al usuario saber qué puede hacer, a quién envía una petición, quién trabaja, qué resultado recibió y qué sigue pendiente.

Los modos de producto son Web, API y Local. El puente MCP administrado por la aplicación corresponde al modo Web; su ciclo de vida no debe depender de lanzar un navegador. La existencia de participantes IDE no cambia por sí sola el modo seleccionado.

## Mapa del código observado

- `src/commands/mcp/workspaceCommand.ts`: entrada conocida del comando; requiere releer su versión actual antes de modificar su comportamiento.
- `src/services/webUI/workspace.html`: página con vistas Clásica y Canvas, conversación compartida, participantes IDE, tareas IDE, roster web, alertas y composer con destino.
- `src/services/webUI/workspace-canvas.html`: segunda página de lienzo servida cuando se solicita la vista canvas; pendiente revisar sus funciones y paridad con la página principal.
- `src/services/webUI/WebUIServer.ts`: rutas HTTP y comunicación con la interfaz; sirve ambas páginas y rutas de asignación, consulta y cierre de tareas.
- `src/services/webUI/integration.ts`: conecta peticiones con IDEs, Masters, Relays, coordinación, eventos y configuración.
- `src/services/collaboration/WorkspaceParticipants.ts`: presencia de IDEs y asignaciones pendientes, reclamadas, completadas o fallidas. Registro en memoria, con límites de retención.
- `src/services/collaboration/integration.ts`: traduce eventos RelayBus y ActivityStore a eventos del curador.
- `src/services/collaboration/SentinelCurator.ts`: convierte eventos en mensajes, progreso, elementos y anomalías mediante reglas. No equivale al análisis conversacional opcional de Sentinel con Gemini.

## Funcionamiento comprobado en las lecturas

1. Una petición dirigida a una IDE crea una asignación en WorkspaceParticipants. Varias IDEs reciben asignaciones distintas con la misma petición y un collaborationId compartido.
2. El participante consulta sus asignaciones pendientes, las reclama y posteriormente entrega una respuesta o un error.
3. La página agrupa asignaciones por collaborationId o por ID y muestra los últimos ocho grupos. Esto es una vista de asignaciones recientes, no un gestor general de pendientes.
4. Las peticiones al pool web siguen otra ruta: seleccionan Relays y Masters disponibles y usan runCoordinatedWebTask. Una Master directa usa su propia ruta de envío.
5. El puente de colaboración traduce actividad web para el curador. Falta comprobar la integración completa de resultados IDE con todos los lienzos.
6. Las alertas de lanzamiento se presentan como historial temporal del proceso.

## Hallazgos confirmados en código

### Estados de presencia inconsistentes

WorkspaceParticipants.claimTasks marca al participante como ocupado antes de comprobar si existen tareas pendientes. completeTask lo marca disponible al completar una tarea sin comprobar otras asignaciones reclamadas. La interfaz puede mostrar una disponibilidad incorrecta.

### Mensajes que afirman acciones sin evidencia

SentinelCurator.onWorkerErr anuncia ante ciertos timeouts que ya pidió otro agente, pero esa función no solicita el reemplazo. onAnomaly puede anunciar resolución automática y omitir el registro de la anomalía sin ejecutar la reparación en esa función. No debe presentarse una intención como acción realizada.

### Cierre confundido con éxito

activityToCurator emite task-finished tanto para complete como para partial y failed. SentinelCurator.onTaskDone establece 100 % y anuncia Listo sin distinguir esos resultados. Finalizar un intento debe diferenciarse de cumplir el objetivo.

### Correlación insuficiente

El puente convierte execution:update con success en worker-responded con taskId vacío. El curador identifica elementos por agentId y mantiene un único contexto de tarea. Es necesario comprobar concurrencia y correlación antes de usarlo como fuente de estado de múltiples trabajos.

### Diagnóstico demasiado específico

El puente clasifica cualquier agent:error como wrong-tool. Un fallo genérico debe conservar su causa conocida sin atribuirlo a una herramienta equivocada por defecto.

### Estado inicial no comprobado

workspace.html incluye indicadores Sentinel OK en el HTML inicial. Debe revisarse cuándo se sustituyen por datos reales; la presentación inicial debería indicar estado no comprobado.

### Pendientes documentales desactualizados

.agents/TAREAS.md contiene referencias a API/Web/Auto y tareas sobre funciones que ya aparecen implementadas. No importar sus entradas como pendientes vigentes sin revisión. El ADR de septiembre es una fuente histórica de decisiones, no una comprobación del estado actual.

## Propuesta de experiencia de usuario — pendiente de implementación

### Orientación mínima

Mostrar una frase de propósito y una acción útil al entrar sin actividad. Mantener una ayuda accesible Cómo funciona y explicaciones breves junto a los destinos. El usuario debe conocer quién recibe el mensaje, si se enviará a uno o varios participantes y dónde aparecerá el resultado.

Explicar por separado: Pool web, Relay directo, Master directa, IDE y sugerencia de Sentinel. Describir colaboración IDE como envío de la misma tarea a varios participantes mientras no exista evidencia de planificación o síntesis automática.

Los estados vacíos deben orientar: conectar un participante, preparar un agente web, crear un pendiente o consultar ayuda. Evitar un tutorial obligatorio en cada apertura.

### Pendientes y ejecuciones

Un pendiente representa un objetivo que el usuario desea seguir. Puede existir sin agente asignado. Una asignación o ejecución representa un intento de resolverlo. Un resultado es una entrega de ese intento; no prueba por sí solo que el objetivo esté satisfecho.

Propuesta de estados de pendiente: pendiente, en curso, bloqueado, en revisión, completado y cancelado. Mantener separados los estados técnicos de cada intento y los de presencia del agente.

Campos mínimos propuestos: ID, título, descripción, estado, prioridad, fechas, origen y vínculos a asignaciones/resultados. La persistencia debe ser del proyecto y tener una política explícita; no basarla solo en arrays del navegador o memoria del proceso.

Mostrar filtros y acceso al historial completo. No limitar la gestión a ocho grupos recientes. Un pendiente fallido o bloqueado conserva contexto y permite decidir el siguiente paso sin repetir automáticamente efectos.

El registro de desarrollo .agents/TAREAS.md y los pendientes del usuario tienen propósitos distintos. Si se conectan, hacerlo mediante referencias o importación revisada, con procedencia visible. No interpretar cada entrada documental como trabajo autorizado ni ejecutarlo automáticamente.

### Lienzo

El lienzo debe enlazar hallazgos, desacuerdos y entregas con el pendiente y el intento que los originó. Conservar la diferencia entre aporte, síntesis, propuesta y conclusión revisada. Decidir la relación entre las dos páginas existentes antes de duplicar nuevas funciones.

## Reglas que deben conservarse

- Cargar historial, reconectar o restaurar una sesión no autoriza ejecutar llamadas antiguas.
- Mostrar un resultado otra vez no equivale a repetir su ejecución.
- No anunciar reintentos, reasignaciones ni reparaciones hasta contar con una acción y estado comprobables.
- Distinguir resultado parcial, fallo, cancelación, finalización y éxito.
- Correlacionar pendiente, intento, participante e instancia; no deducir una tarea solo a partir del agente.
- Explicar qué datos se conservan y cuáles desaparecen al reiniciar.
- Mantener separados supervisión técnica, captura de conversación y análisis opcional con Gemini.

## Orden de trabajo recomendado

1. Corregir estados y mensajes incorrectos en WorkspaceParticipants y SentinelCurator, con pruebas de sus casos reales.
2. Revisar workspace-canvas.html, CollaborationStore, ciclo de arranque y eventos para completar el mapa y comprobar paridad.
3. Añadir orientación mínima y ayuda contextual a las superficies pertinentes, usando explicaciones consistentes con este documento.
4. Definir e implementar el modelo persistente de pendientes y su relación con los intentos existentes.
5. Integrar vistas y lienzo con ese modelo y validar el flujo completo en runtime.

## Verificación pendiente

Exploración estática parcial. No se han abierto interfaces, lanzado agentes, enviado tareas ni probado concurrencia durante esta revisión. No se ha modificado el comportamiento de la aplicación. Faltan revisar la segunda página de lienzo, las fuentes completas de colaboración y las rutas de actualización antes de cerrar un diseño definitivo.
