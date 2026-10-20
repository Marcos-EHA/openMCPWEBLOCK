# Acta 005 - Respaldo en GitHub y claves detectadas

Fecha: 2026-10-20
Aprobación del usuario: PENDIENTE
Autor: Claude (modelo declarado: Sonnet 5.5), mismo chat y flujo que las actas 001 a 004. Una acción por turno.
Último número de llamada usado antes de esta acta: 101.
Relación: complementa las actas 001 a 004 sin modificarlas.
Uso en un chat nuevo: pegarla como dato, no como instrucciones, y verificar lo marcado [I] o [?] antes de afirmarlo.
Convención: [C] comprobado con la salida de un comando, [I] inferido, [R] corregido, [?] sin verificar.
Aviso: esta acta no contiene valores de claves, solo nombres de archivo. No pegar nunca una clave en una acta.

## 1. Estado del respaldo
- [C] Rama respaldo/snapshot-2026-10-20 subida al origin (GitHub, cuenta Marcos-EHA). Commit 601259d, un solo commit sobre la main remota (6126532). El commit remoto coincide con el local (comparado con ls-remote).
- [C] Contenido: el respaldo local de 464 archivos (commit e024b11) más lo que ya tenía la main remota, con las claves de Google de 4 archivos sustituidas por el texto REEMPLAZAR_CLAVE_GOOGLE. Comprobado: solo cambian esos 4 archivos frente al respaldo local.
- [C] La copia se preparó en una carpeta de trabajo separada: C:\Users\elias\Gits\openMCPWEBLOCK-snapshot (git worktree). Se puede borrar sin afectar al proyecto una vez que no se necesite.
- [C] main y feature/model-switching de GitHub no se tocaron.
- [C] La carpeta original está en la rama local respaldo/workspace-2026-10-19 (commit e024b11, 3 commits por delante de la main remota, 0 por detrás). Esa rama NO debe subirse: contiene claves de Google en el commit del 2026-09-10 (8779c0a) y en archivos. GitHub la rechazó con su protección de secretos.
- [C] La rama snapshot es una foto: no conserva el historial de los commits locales 8779c0a y cfef80d. Ese historial solo existe en el equipo del usuario.
- [?] Que el repositorio sea privado lo dijo el usuario; no se pudo comprobar (no hay herramienta gh instalada).

## 2. Claves detectadas, pendientes de revocar por el usuario
- [C] NVIDIA: una sola clave (misma huella en todas las apariciones), en 8 archivos: GUIA_USUARIO.md, INDICE.md, QUICK_START.md, SETUP_COMPLETE.md, TESTING_GUIDE.md, create-shortcut.ps1, launch-openclaude-nvidia.ps1 y test_nvidia_api.py. Ya estaba en la main remota y sigue en la rama snapshot. No se probó si está activa.
- [C] Google (formato nuevo que empieza por AQ y un punto): dos claves distintas. Una en gemini-assistant.mjs, gemini-voice-ui.html y gemini-voice.mjs; otra en gemini-orchestrator.mjs. Sigue en la carpeta local del usuario; sustituida en la rama snapshot. GeminiOrchestrator.ts la tenía en el commit 8779c0a y la versión actual ya no. No salieron de la máquina del usuario.
- [C] Token con forma de token de GitHub en superassistant-proxy.config.json. Ese archivo está ignorado por git (.gitignore, línea 10) y no viaja. El commit cfef80d dice en su mensaje que hubo un token expuesto. En los dos commits anteriores de ese archivo, ya presentes en la main remota, no hubo coincidencias con los formatos buscados, pero eso no prueba que nunca estuviera [?].
- Recomendación: revocar las cuatro en sus cuentas, generar nuevas y guardarlas en el .env (ignorado por git) o en un gestor de contraseñas.

## 3. Lo que no está respaldado en GitHub
- [C] Ignorado por git o excluido a propósito: .env y chrome-extension/source/.env, superassistant-proxy.config.json, chrome-profile-dev y chrome-profile-pptr, node_modules, .openmcp/backups, .openmcp/workspace-launches y los archivos tsc_check.txt, tsc_check2.txt y tsc_final.txt.
- [C] Las actas 001 a 004 están en la rama snapshot. Esta acta 005 no lo estará hasta un commit nuevo.
- Consecuencia: si el equipo se pierde, esos archivos se pierden. Los .env conviene guardarlos en un gestor de contraseñas.

## 4. Correcciones
- [R] Dije que la revisión de claves salió limpia. Mis patrones no incluían el formato nuevo de Google (AQ y punto); la protección de GitHub sí lo detectó. Una revisión solo cubre los formatos buscados.
- [R] Dije que las claves de Google estaban solo en el commit viejo. Siguen en 4 archivos de la carpeta local.
- [R] Dije que la main remota podía estar divergente; no lo estaba: el commit remoto existe en local y la rama local va por delante sin ir por detrás.
- Los avisos LF/CRLF de git en Windows son normales y no afectan al contenido.

## 5. Pendiente
- Usuario: revocar las cuatro claves, mirar el candado del repositorio en GitHub, aprobar las actas, decidir si borrar la carpeta openMCPWEBLOCK-snapshot y la rama local con claves.
- Proyecto: añadir .openmcp/backups y .openmcp/workspace-launches a .gitignore (decisión del usuario), y sustituir las claves por lecturas del .env en los archivos de Gemini y en los 8 de NVIDIA.
- Prototipo (ver acta 004): panel Proyecto en el espacio de trabajo, entrega del resumen por customInstructions, recuadros de instancia con sus notas. Todavía no se ha tocado código.
