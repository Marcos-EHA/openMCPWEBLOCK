# Acta 008 - Sello de identidad: quién lo recibe y qué significa para las Masters

Fecha: 2026-10-21
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 a 007. Una acción por turno.
Último número de llamada usado antes de esta acta: 143.
Relación: complementa las actas 001 a 007 sin modificarlas. Sus correcciones están en la sección 4.
Nota de fecha: el reloj de la máquina marcó 2026-10-20 22:43 en la última medición; la fecha de esta acta es la de la sesión.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado con la salida de un comando, [I] inferido, [R] corregido, [?] sin verificar. Las líneas se mueven: anclar a nombres de función.
Aviso: esta acta no contiene valores de claves.

## 1. Campos del sello de identidad
- [C] La interfaz InstanceIdentity (src/services/webRelay/ChromeCDP.ts) tiene diez campos: versión del formato, instanceId, agentId, role, platformId, profileDir, sessionMode (authenticated, clean o chrome-profile), masterSessionSourceId, chromeProfileDirectory y stampedAt.
- [C] No incluye ningún identificador de chat. Ese dato sale de la página (acta 007, sección 3).
- [C] En MultiAgentRunner.ts el sello se estampa con los diez campos útiles: instanceId, agentId, role, platformId, profileDir, sessionMode, masterSessionSourceId y chromeProfileDirectory.
- [C] En WebRelayProvider.ts (función ensureInitialized) el sello lleva solo instanceId, agentId, platformId y profileDir: sin rol, sin modo de sesión y sin masterSessionSourceId.
- [?] Si los dos estampados actúan sobre la misma instancia, el segundo (más pobre) podría sobrescribir al primero, porque ambos escriben la misma clave y el código dice que estampar es idempotente y sobrescribe. No se comprobó.

## 2. Quién estampa y quién no
- [C] stampInstanceIdentity solo se llama desde MultiAgentRunner.ts y desde ensureInitialized en WebRelayProvider.ts (búsqueda en los .ts de src/services; sin resultados en el controlador de Master ni en los comandos de mcp).
- [C] ensureInitialized se llama en dos sitios de WebRelayProvider.ts: en la función que atiende al modelo web (webRelayCallModel) y en sendWebPrompt, que envía a un Relay.
- [C] sendWebPromptToMaster es otra función. Arma una instancia mínima con instanceId master-session:ID y entra a handleSAMode sin llamar a ensureInitialized (WebRelayProvider.ts, cerca de la línea 1639).
- [C] El controlador de Master (src/services/webRelay/session/MasterSessionController.ts) solo abre la sesión y pide preparar SuperAssistant en el puerto; no menciona identidad ni sello.
- [I] Una Master abierta desde la interfaz no recibe sello de identidad. Es una inferencia por ausencia de llamadas; no se probó en ejecución, y la búsqueda no cubrió todos los tipos de archivo.
- [?] Se desconoce si las Masters quedan identificadas por otro camino (por ejemplo el registro de fuentes de SessionBroker).

## 3. Consecuencias para el diseño (propuestas, nada implementado)
- Identidad de una Master para las notas: el identificador master-session:ID (instanceId que usa el almacén de chats y los envíos), más el camino de la URL de la página como conversationId. El primero lo pone el sistema desde el registro de fuentes, no la IA.
- El almacén de chats del workspace usa main por defecto para una Master (acta 003): conviene enlazarlo con el camino de la página antes de depender de él.
- Estampar a las Masters con el sello completo sería un cambio de código en el envío a Master o en el controlador. No se hace sin visto bueno del usuario, y hay que cuidar no sobrescribir un sello más completo con uno pobre.
- Cada nota llevaría el par de identidad y marcaría lo desconocido como desconocido.
- La entrega del resumen del proyecto sigue siendo manual en la primera versión (actas 004 y 007).

## 4. Correcciones
- [R] Acta 007, secciones 2 y 6: dejaba abierto si una Master recibe el sello. Ahora es inferido que no lo recibe (sección 2 de esta acta).
- [R] Dije que la preparación de SuperAssistant que usan las Masters podría estampar la identidad. Las primeras líneas de prepareSAAgentForWebRelay solo comprueban el servidor MCP local; el estampado está en ensureInitialized.
- [R] Acta 007 decía que MultiAgentRunner.ts y WebRelayProvider.ts estampaban el mismo contenido. El primero estampa más campos que el segundo.

## 5. Estado y pendiente
- [C] En GitHub, rama respaldo/snapshot-2026-10-20: actas 001 a 007 y el módulo projectNotes (commits hasta 3be3384). Esta acta 008 no está todavía; se sube solo desde la carpeta openMCPWEBLOCK-snapshot.
- [C] La última comprobación mostró 7 archivos rastreados con ediciones del usuario sin guardar en git, entre ellos WebUIServer.ts, integration.ts y workspace.html. No se tocan.
- Usuario: revocar las cuatro claves (acta 005); compilar con bun run build en una pausa y reiniciar con /mcp workspace stop y /mcp workspace; aprobar actas.
- Proyecto: comprobar /project tras compilar; enlazar el conversationId de la página con el almacén de chats; decidir si estampar el sello completo a las Masters.
