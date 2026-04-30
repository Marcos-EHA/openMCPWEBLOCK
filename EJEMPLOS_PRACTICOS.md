# 🚀 EJEMPLOS PRÁCTICOS - Mode Controller en Acción

**Escenarios reales de uso y comandos**

---

## Ejemplo 1: Cambiar a Web Mode para Automatización

## Verificar composición MCP
```bash
/mcp status
```
Este comando informa el modo actual, los servidores detectados, y los servidores esperados para el modo activo.


### Escenario
Necesitas automatizar tareas en una interfaz web (ej: completar un formulario).

### Pasos

```bash
# 1. Arrancar OpenClaude (en una terminal)
claude

# 2. En otra terminal, iniciar el proxy si no está corriendo
.\launch-superassistant-proxy.ps1

# 3. En OpenClaude, cambiar a Web Mode
/mcp set-mode web
# Respuesta: "MCP execution mode set to 'web'"

# 4. Ahora puedes usar herramientas MCP como:
# - web_scrape (si está disponible)
# - click_element
# - fill_form
# etc.

# Tu prompt
"Abre https://ejemplo.com y llena el formulario de contacto con estos datos..."

# 5. Cuando termines, vuelve a API Mode
/mcp set-mode api
# Respuesta: "MCP execution mode set to 'api'"
```

### Ventajas
- Máxima velocidad para tareas estándar (API mode)
- Flexibilidad para tareas web cuando las necesitas
- Sin necesidad de reiniciar

---

## Ejemplo 2: Análisis con Auto Mode

### Escenario
Necesitas máxima flexibilidad para una tarea compleja que puede requerir múltiples herramientas.

### Pasos

```bash
# 1. En OpenClaude, cambiar a Auto Mode
/mcp set-mode auto
# Respuesta: "MCP execution mode set to 'auto'"

# 2. Ahora todas las herramientas están disponibles:
# - Built-in tools (Bash, FileRead, FileEdit, etc.)
# - MCP tools (filesystem de proxy)
# - Cualquier otro servidor MCP que agregues

# Tu prompt
"Analiza todos los archivos .ts en src/, genera un resumen y propón refactorings"

# 3. Claude tendrá acceso a:
# - read_file (built-in) para leer rápido
# - grep_search (MCP) para buscar patrones
# - bash (built-in) para ejecutar análisis
# etc.

# 4. Cuando termines, puedes volver a tu modo preferido
/mcp set-mode api
```

### Ventajas
- Máxima flexibilidad
- Claude elige las herramientas mejores
- Ideal para tareas exploratorias

---

## Ejemplo 3: Desarrollo Normal (API Mode Default)

### Escenario
Workflow normal de coding sin necesidades especiales.

### Pasos

```bash
# 1. OpenClaude comienza en API Mode (default)
claude

# 2. Las herramientas disponibles son solo built-in:
# - bash (ejecutar comandos)
# - read_file (leer archivos)
# - edit_file (editar código)
# - search_files (buscar patrones)
# - grep_search (grep)
# etc.

# Tu prompt
"Crea una función en TypeScript que valide emails y pruébala"

# 3. Claude tendrá acceso rápido (50-200ms por operación)
# a todas las herramientas necesarias

# 4. No necesitas cambiar nada, sigue siendo productivo
```

### Ventajas
- Comportamiento original preservado
- Máxima velocidad
- Máxima confiabilidad
- Sin configuración extra

---

## Ejemplo 4: Workflow Mixto

### Escenario
Combinar herramientas built-in con MCP según la tarea.

### Pasos

```bash
# Sesión de trabajo mixta en Auto Mode
/mcp set-mode auto

# Tarea 1: Leer y analizar código (rápido con built-in)
# "Lee src/tools.ts y explica qué hace la función assembleToolPool"
# → Usa read_file (built-in) ~50ms

# Tarea 2: Buscar patrones (rápido con built-in)
# "Encuentra todas las funciones que usan 'getCurrentProjectConfig'"
# → Usa grep_search (built-in) ~100ms

# Tarea 3: Automatizar en web (requiere MCP)
# "Abre https://github.com/srbhptl39/MCP-SuperAssistant y busca los últimos releases"
# → Usa herramientas MCP del proxy ~500-1000ms

# Tarea 4: Volver a trabajo local (rápido)
# "Edita src/tools.ts y agrega un comentario en la función..."
# → Usa edit_file (built-in) ~50ms

# Al terminar, deja en modo seguro
/mcp set-mode api
```

### Ventajas
- Máxima productividad
- Elige herramientas según tarea
- Control total

---

## Ejemplo 5: Troubleshooting

### Problema: Las herramientas MCP no aparecen

```bash
# 1. Verificar modo actual
# Ejecuta: /mcp set-mode api
# Resultado: Si estabas en modo 'api', solo tendrás built-in tools
# Solución: Cambiar a web o auto
/mcp set-mode web

# 2. Verificar proxy corriendo
.\test-superassistant-proxy.ps1
# Debería devolver:
# ✅ Initialize OK
# ✅ tools/list OK
# Con 14 herramientas disponibles

# 3. Revisar logs si hay error
Get-Content .\logs\superassistant-proxy.stdout.log
Get-Content .\logs\superassistant-proxy.stderr.log

# 4. Reiniciar proxy si es necesario
.\launch-superassistant-proxy.ps1
```

---

## Ejemplo 6: Caso de Uso Real - Web Scraping

### Escenario
Scraping de datos de una página web.

### Pasos

```bash
# 1. Cambiar a Web Mode (necesita herramientas de proxy)
/mcp set-mode web

# 2. Tu prompt
"""
Abre https://example.com/products
Scrape todos los nombres de productos y precios
Guarda los datos en un archivo CSV
"""

# 3. Claude usará:
# - click_element (navegar, desde MCP)
# - read_element (leer data, desde MCP)
# - write_file (guardar, desde built-in)

# 4. Resultado: archivo con datos scrapeados

# 5. Volver a modo normal
/mcp set-mode api
```

---

## Ejemplo 7: Caso de Uso Real - Análisis de Codebase

### Escenario
Análisis profundo del codebase openMCPWEBLOCK.

### Pasos

```bash
# 1. Cambiar a Auto Mode (máxima flexibilidad)
/mcp set-mode auto

# 2. Tu prompt
"""
Analiza la arquitectura del proyecto openMCPWEBLOCK:
1. Encuentra todos los archivos TypeScript en src/
2. Identifica los patrones de diseño usados
3. Detecta posibles deuda técnica
4. Propón refactorings prioritarios
"""

# 3. Claude usará:
# - find_files (listar archivos)
# - read_file (leer código)
# - grep_search (buscar patrones)
# - bash (ejecutar análisis)
# Para completar el análisis

# 4. Recibirás un análisis completo con:
# - Arquitectura del proyecto
# - Patrones identificados
# - Problemas encontrados
# - Propuestas de mejora

# 5. Volver a modo seguro
/mcp set-mode api
```

---

## Ejemplo 8: Configuración Persistente

### Escenario
Trabajas siempre en Web Mode para tu proyecto.

### Pasos

```bash
# 1. Primera vez, establecer Web Mode
/mcp set-mode web

# 2. Cerrar OpenClaude (sesión termina)

# 3. Abrir OpenClaude nuevamente en el mismo directorio
claude

# 4. ¿Cuál es el modo actual?
# Respuesta: Web Mode (se guardó en la configuración del proyecto)

# 5. Toda tu sesión está en Web Mode automáticamente
# Sin necesidad de cambiar nada

# 6. Si cambias de proyecto
cd otro-proyecto
claude

# 7. Ese nuevo proyecto tendrá el modo default (API)
# Porque tiene su propia configuración

# Ventaja: Cada proyecto puede tener su propio modo default
```

---

## Ejemplo 9: Error Handling

### Escenario
Algo falla en Web Mode.

### Pasos

```bash
# 1. Error en Web Mode
/mcp set-mode web
# Tu prompt: "Scrape datos de ejemplo.com"
# Error: Proxy no responde o herramienta no disponible

# 2. Opciones:

# Opción A: Cambiar a API Mode
/mcp set-mode api
# Ahora puedes usar built-in tools como fallback

# Opción B: Revisar proxy
.\test-superassistant-proxy.ps1
# Si falla, reiniciar proxy

# Opción C: Usar Auto Mode para que Claude elija
/mcp set-mode auto
# Claude intentará usar la mejor herramienta disponible

# 3. Continuar con workflow
```

---

## Ejemplo 10: Integration Testing

### Escenario
Validar que todo funciona correctamente.

### Pasos

```bash
# 1. Verificar proxy
.\test-superassistant-proxy.ps1
# Debería mostrar:
# ✅ Initialize OK
# ✅ tools/list OK

# 2. Probar cada modo
/mcp set-mode api
# Prompt: "ls -la"
# Resultado: Built-in bash tool funciona

/mcp set-mode web
# Prompt: "list files"
# Resultado: MCP tools disponibles

/mcp set-mode auto
# Prompt: "show me files"
# Resultado: Todas las herramientas disponibles

# 3. Validar persistencia
/mcp set-mode web
# Cerrar OpenClaude
# Abrir OpenClaude
# Debe estar en Web Mode

# 4. Limpiar
/mcp set-mode api
# Volver a modo seguro por defecto
```

---

## 💡 Tips y Mejores Prácticas

### Tip 1: Combina Modos en la Misma Sesión
```bash
# Usa API Mode para tareas rápidas
/mcp set-mode api
# "Edita src/main.ts"

# Cambia a Web Mode cuando lo necesites
/mcp set-mode web
# "Scrape datos de la web"

# Vuelve a API Mode para finalizar
/mcp set-mode api
# "Ejecuta los tests"
```

### Tip 2: Usa Auto Mode para Exploración
```bash
# Cuando no sabes qué herramientas necesitarás
/mcp set-mode auto
# Claude tendrá máxima flexibilidad
```

### Tip 3: Monitorea la Latencia
```bash
# API Mode: Espera 50-200ms
# Web Mode: Espera 500ms-2s+
# Ajusta tus expectativas según modo
```

### Tip 4: Documenta tu Workflow
```bash
# En tu proyecto, agregar comentario
# en README.md:
# "Este proyecto usa Web Mode para automatización
#  Cambiar con: /mcp set-mode web"
```

### Tip 5: Respeto a TOS
```bash
# Web Mode tiene riesgos de cumplimiento
# Solo usar en sitios que lo permitan
# Revisar términos de servicio
```

---

**Para más información, consulta la documentación completa en [INDICE_INTEGRACION_MCP.md](INDICE_INTEGRACION_MCP.md)**