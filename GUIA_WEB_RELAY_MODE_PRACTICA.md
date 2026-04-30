# Guía Práctica: Web Relay Mode + SuperAssistant

**Última actualización**: 28 de Abril, 2026  
**Status**: ✅ MVP Listo para usar

---

## 🎯 ¿Qué es Web Relay Mode?

Web Relay Mode permite que tus IAs web (ChatGPT, Gemini, Grok, Perplexity, etc.) ejecuten las **mismas herramientas MCP** que OpenClaude local, sin necesidad de APIs.

```
Tú escribe en ChatGPT/Gemini
    ↓
SuperAssistant extension detecta tool calls
    ↓
Ejecuta herramientas MCP del proxy local
    ↓
El resultado aparece en el navegador
    ↓
La IA web responde basándose en el resultado
```

---

## 📋 Pre-requisitos

1. **OpenClaude actualizado** (con Mode Controller implementado)
2. **Chrome/Firefox** con SuperAssistant extension instalada
3. **Node.js ≥ 22.12** y **bun** (o npm)
4. **Windows PowerShell 5.1+**

---

## 🚀 Instalación Paso a Paso

### Paso 1: Clonar y preparar SuperAssistant

```powershell
# Clonar el repo de SuperAssistant
git clone https://github.com/srbhptl39/MCP-SuperAssistant.git
cd MCP-SuperAssistant

# Instalar dependencias
pnpm install

# Compilar
pnpm build
```

### Paso 2: Instalar la extension en Chrome

```
1. Abre Chrome → chrome://extensions/
2. Activa "Modo de desarrollador" (arriba a la derecha)
3. Haz clic en "Cargar extensión sin empaquetar"
4. Selecciona la carpeta ./chrome-extension/dist
5. La extension aparecerá en tu toolbar
```

### Paso 3: Activar Web Relay Mode en OpenClaude

```powershell
# Abre OpenClaude CLI
cd c:\Users\apoca\openMCPWEBLOCK

# Activa Web Relay Mode
claude /mcp set-mode web

# Verifica el estado
claude /mcp status
```

### Paso 4: Iniciar el proxy

```powershell
# Ejecuta el script de lanzamiento
.\launch-superassistant-proxy.ps1

# Espera hasta ver: "✅ Proxy escuchando en http://localhost:3000"
```

### Paso 5: Conectar SuperAssistant al proxy

```
1. Haz clic en el icono de SuperAssistant en Chrome
2. Abre Settings → Connection
3. URL del proxy: http://localhost:3000
4. Transporte: streamableHttp (recomendado)
5. Haz clic en "Test Connection"
6. Deberías ver: "✅ Connected"
```

---

## ✅ Verificar que funciona

### Test 1: Herramientas disponibles

```
1. Abre ChatGPT (u otra plataforma soportada)
2. Haz clic en el icono de SuperAssistant
3. Deberías ver una lista de herramientas MCP disponibles:
   - filesystem
   - superassistant-proxy
   - claude-mem
   - (otras según tu configuración)
```

### Test 2: Ejecutar una herramienta

```
1. En ChatGPT, pide algo que requiera una herramienta:
   "Lee el archivo README.md de mi proyecto"
   
2. ChatGPT generará algo como:
   <function_calls>
     <invoke name="filesystem">
       <parameter name="path">/home/user/project/README.md</parameter>
     </invoke>
   </function_calls>

3. SuperAssistant detectará el bloque de tool call
4. Mostrará un botón "RUN" en el DOM
5. Al hacer clic (o si auto-execute está activo):
   - Ejecuta la herramienta en tu PC local
   - El resultado aparece en el chat
   - La IA web lo procesa
```

### Test 3: Verificar proxy en terminal

```powershell
# En una terminal separada:
Invoke-WebRequest -Uri http://localhost:3000/health -Method GET
```

Deberías ver: `Status: 200 OK` y JSON con estado del proxy.

---

## 🎮 Uso Práctico

### Caso 1: Consultar archivos locales desde ChatGPT

```
Usuario (en ChatGPT):
"Ayúdame a entender este archivo de configuración"
[adjunta o describe la ruta]

ChatGPT (generará):
<function_calls>
  <invoke name="filesystem">
    <parameter name="path">c:\path\to\config.json</parameter>
  </invoke>
</function_calls>

SuperAssistant + Proxy:
- Lee el archivo localmente
- Devuelve el contenido a ChatGPT
- ChatGPT analiza y responde
```

### Caso 2: Automatización web desde Claude Memory

```
Usuario (en ChatGPT):
"Recuerda que necesito revisar estos 5 puntos diariamente"

Claude Memory:
- Guarda los 5 puntos
- Los recupera en la próxima sesión

Usuario (más tarde):
"¿Cuáles eran los puntos que mencioné?"

ChatGPT (con SuperAssistant + Claude Memory):
- Consulta la memoria persistente
- Devuelve los 5 puntos
```

### Caso 3: Comparar respuestas entre plataformas

```
1. Abre ChatGPT, activa Web Relay Mode
2. Haz una pregunta técnica
3. Abre Gemini en otra pestaña, misma pregunta
4. Ambas pueden ejecutar las MISMAS herramientas MCP
5. Compara las respuestas
```

---

## ⚙️ Configuración Avanzada

### Habilitar Auto-Execute

SuperAssistant puede ejecutar herramientas automáticamente sin pedir confirmación:

```
1. Clic derecho en el icono de SuperAssistant
2. Settings → Automation
3. Activa: "Auto-execute tool calls"
4. Activa: "Auto-submit results"
5. Puedes establecer límites de seguridad por tipo de tool
```

### Cambiar transporte

Si `streamableHttp` tiene problemas:

```
1. SuperAssistant Settings → Connection
2. Transporte: cambia a "WebSocket" o "SSE"
3. Reinicia la connection

Orden de recomendación:
1. streamableHttp (moderna, rápida)
2. WebSocket (baja latencia)
3. SSE (compatible, un poco más lenta)
```

### Limitar herramientas por perfil de seguridad

```json
// En tu .mcp.json, agrega "scope":
{
  "mcpServers": {
    "filesystem": {
      "command": "...",
      "scope": "safe"  // Solo lectura
    },
    "exec": {
      "command": "...",
      "scope": "full"  // Requiere confirmación
    }
  }
}
```

---

## 🐛 Troubleshooting

### Problema: "Connection refused" en SuperAssistant

```powershell
# Verifica que el proxy está corriendo:
netstat -an | findstr :3000

# Si no está, lanza el script:
.\launch-superassistant-proxy.ps1
```

### Problema: Herramientas no aparecen en SuperAssistant

```
1. Revisa que /mcp status muestra "web" mode:
   claude /mcp status
   
2. Verifica que el proxy esté en "connected" en SuperAssistant Settings

3. Recarga la página web (Ctrl+R)

4. Si persiste, revisa los logs del proxy:
   tail -f logs/proxy.log  (si existe)
```

### Problema: Tool call funciona pero demora mucho

```
1. Aumenta el timeout en SuperAssistant Settings
2. Verifica la salud del proxy:
   ./test-superassistant-proxy.ps1

3. Si el proxy está lento:
   - Reinicia con: .\launch-superassistant-proxy.ps1
   - Verifica que no hay procesos bloqueados
```

### Problema: "Auto-execute" no funciona

```
1. Verifica que está activado en Settings
2. Agrega la plataforma a whitelist (ChatGPT, Gemini, etc.)
3. Verifica que la herramienta no está en "scope: full" 
   (full scope requiere confirmación manual)
```

---

## 🔐 Seguridad

### Lo que debes saber

- **El proxy corre localmente** - tus archivos no suben a internet
- **Herramientas se ejecutan en tu PC** - tienes control total
- **SuperAssistant puede leer DOM** - considera si las plataformas te permiten extensiones
- **Memoria (claude-mem)** - se almacena localmente en `./.claude/memory`

### Mejores prácticas

```
1. Nunca compartas URLs del proxy con otros
2. Usa "safe" scope para herramientas de lectura
3. Requiere confirmación manual para escritura/ejecución
4. Revisa qué datos envías a plataformas web (redacta secretos)
5. Mantén la extension actualizada
```

---

## 📊 Monitoreo

### Ver logs del proxy

```powershell
# Si ejecutaste el proxy en terminal:
# Verás logs en tiempo real

# Si lo ejecutaste en background:
Get-Content logs/proxy.log -Tail 50 -Wait
```

### Ver estado de herramientas

```powershell
# En OpenClaude CLI:
claude /mcp status

# Output esperado:
# MCP mode: web
# Configured MCP servers: filesystem, superassistant-proxy, claude-mem
# Active MCP clients: (nombres de los conectados)
# Expected servers for mode: superassistant-proxy
# Reachable servers: superassistant-proxy
# No expected servers are missing.
```

---

## 🚀 Próximos pasos

### Después de verificar que funciona

1. **Integra Playwright MCP** para automatización determinista
2. **Agrega Google MCP** para Drive/Docs/Calendar
3. **Configura perfiles de seguridad** (safe/ops/full)
4. **Implementa consenso IA** (múltiples plataformas, una respuesta)

---

## 📖 Referencia rápida

| Tarea | Comando |
|-------|---------|
| Activar Web Mode | `claude /mcp set-mode web` |
| Ver estado | `claude /mcp status` |
| Lanzar proxy | `.\launch-superassistant-proxy.ps1` |
| Testear proxy | `.\test-superassistant-proxy.ps1` |
| Ver logs | `Get-Content logs/proxy.log -Tail 50` |
| Revertir a API | `claude /mcp set-mode api` |

---

## ❓ FAQ

**P: ¿Puedo usar múltiples plataformas simultáneamente?**
R: Sí, pero cada una necesita su propia instancia de la extension. Ver "Arquitectura Multi-Agente" para consenso.

**P: ¿Pierdo el contexto si cambio de modo?**
R: No si usas `claude-mem`. Se guardará automáticamente en cambios de modo.

**P: ¿Qué pasa si el proxy falla?**
R: OpenClaude fallará a "API Mode" automáticamente si está en "Auto Mode", o mostrará error en "Web Mode".

**P: ¿Puedo dejar el proxy corriendo 24/7?**
R: Sí, es estable. Solo requiere que OpenClaude esté en "web" o "auto" mode.

---

## 📞 Soporte

Si tienes problemas:
1. Lee el Troubleshooting arriba
2. Revisa logs: `Get-Content logs/proxy.log`
3. Abre un issue en GitHub del proyecto
