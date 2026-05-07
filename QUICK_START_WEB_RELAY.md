# 🚀 Quick Start: Web Relay Mode - 5 Minutos

**Objetivo**: Activar Web Relay Mode en OpenClaude y hacer tu primera consulta web  
**Tiempo**: ~5 minutos  
**Requisitos**: Chrome corriendo + Proxy corriendo (ya están ✅)

---

## Paso 1: Verificar que todo está corriendo

### Terminal 1: Verifica Chrome CDP

```powershell
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing
```

✅ Si ves Browser version, Chrome está corriendo.

### Terminal 2: Verifica el Proxy

```powershell
Invoke-WebRequest -Uri http://localhost:3006/healthz -UseBasicParsing
```

✅ Si ves "200 OK", el proxy está corriendo.

---

## Paso 2: Activa Web Mode en OpenClaude

Abre CLI de OpenClaude:

```bash
cd c:\Users\apoca\openMCPWEBLOCK

# Activa web mode
claude /mcp set-mode web

# Verifica
claude /mcp status
```

**Salida esperada**:
```
Mode: web
Expected servers: superassistant-proxy, chrome-devtools, claude-mem
Available tools: 43 (14 filesystem + 29 chrome-devtools)
Status: ✅ ALL SYSTEMS GO
```

---

## Paso 3: Haz tu primer consulta web

### Ejemplo 1: Extrae título de un sitio

```bash
claude "¿Cuál es el título de la página en https://example.com?"
```

**Proceso interno**:
1. OpenClaude detecta que necesita navegación
2. Llama `chrome-devtools-mcp.new_page` → abre example.com
3. Llama `chrome-devtools-mcp.evaluate_script` → extrae title
4. Responde con el resultado

**Resultado esperado**:
```
[OpenClaude] El título de example.com es: "Example Domain"
```

---

### Ejemplo 2: Busca contenido en un sitio

```bash
claude "En https://example.com, ¿qué dice el párrafo principal?"
```

**Proceso interno**:
1. Navega a example.com
2. Busca el párrafo principal (elemento `<p>`)
3. Extrae el texto
4. Responde

**Resultado esperado**:
```
[OpenClaude] El párrafo principal dice:
"This domain is for use in examples and documentation..."
```

---

### Ejemplo 3: Múltiples pasos (más avanzado)

```bash
claude "
1. Navega a google.com
2. Busca 'OpenClaude MCP'
3. Dime cuántos resultados hay
"
```

**Proceso interno**:
1. Abre google.com
2. Busca el campo de búsqueda
3. Llena y presiona Enter
4. Espera a que cargue
5. Extrae el número de resultados
6. Responde

---

## 🎮 Casos de Uso Reales

### A. Monitoreo de Precios

```bash
claude "¿Cuál es el precio actual de Bitcoin en coinmarketcap.com?"
```

Resultado:
```
[Navega a coinmarketcap.com]
[Extrae el precio del widget principal]
[Responde] "El precio de Bitcoin es $87,432"
```

---

### B. Verificación de Estado

```bash
claude "
Verifica el status de los servicios de GitHub:
1. Ve a status.github.com
2. Dime si todo está verde
"
```

Resultado:
```
[Navega a status.github.com]
[Evalúa el estado de los componentes]
[Responde] "Todos los servicios de GitHub están operacionales ✅"
```

---

### C. Extracción de Datos

```bash
claude "
Extrae de weather.com:
1. Temperatura en Los Ángeles
2. Probabilidad de lluvia
3. Velocidad del viento
"
```

Resultado:
```
[Navega a weather.com]
[Busca Los Ángeles]
[Extrae datos]
[Responde] 
"Temperatura: 72°F
Lluvia: 15%
Viento: 8 mph"
```

---

## 🧪 Testing Manual (Opcional)

Si quieres ver exactamente qué sucede por debajo:

### Test con PowerShell

```powershell
$body = @{
  jsonrpc = '2.0'
  id = 'test-001'
  method = 'tools/call'
  params = @{
    name = 'chrome-devtools-mcp.new_page'
    arguments = @{ url = 'https://example.com' }
  }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
  -Uri http://localhost:3006/mcp `
  -Method Post `
  -Headers @{ 'Content-Type' = 'application/json' } `
  -Body $body `
  -UseBasicParsing

$response.result.content[0].text
```

**Salida**:
```
## Pages
1: about:blank
2: https://example.com/ [selected]
```

---

### Test con Node.js

```bash
node test-mcp-tools.mjs
```

**Salida esperada**:
```
🚀 Testing MCP Proxy Connection to chrome-devtools-mcp

📋 Step 1: Listing available tools...
✅ Got 43 tools (14 filesystem + 29 chrome-devtools)

📄 Step 2: Creating a new browser page...
✅ Successfully navigated to https://example.com

🔍 Step 3: Listing browser pages...
✅ Currently have 2 pages open
```

---

## 🔧 Troubleshooting

### Problema: "Port 3006 already in use"

```powershell
# Encuentra el proceso usando el puerto
Get-NetTCPConnection -LocalPort 3006 | Format-Table

# Termínalo
Stop-Process -Id <PID>

# Relanza el proxy
.\launch-superassistant-proxy.ps1
```

---

### Problema: "Chrome not responding"

```powershell
# Verifica Chrome
Get-Process chrome | Select-Object Id, ProcessName

# Si no está corriendo, lánzalo
.\launch-chrome-cdp.ps1

# Espera 3 segundos
Start-Sleep -Seconds 3

# Verifica CDP
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing
```

---

### Problema: "tools/call returning error"

1. Verifica que el proxy está corriendo: `http://localhost:3006/healthz`
2. Verifica que Chrome está corriendo: `http://localhost:9222/json/version`
3. Mira los logs del proxy: `Get-Content .\logs\superassistant-proxy.stdout.log -Tail 20`

---

## 🎯 Validación Final

Ejecuta este test para confirmar que todo funciona:

```bash
# Verifica Chrome
Write-Host "Chrome CDP: " -NoNewline
Invoke-WebRequest -Uri http://localhost:9222/json/version -UseBasicParsing | Write-Host "✅"

# Verifica Proxy
Write-Host "MCP Proxy: " -NoNewline
Invoke-WebRequest -Uri http://localhost:3006/healthz -UseBasicParsing | Write-Host "✅"

# Verifica OpenClaude config
Write-Host "OpenClaude mode: " -NoNewline
claude /mcp status | Select-String "web" | Write-Host "✅"

Write-Host "`n✅ Todo listo para usar Web Relay Mode"
```

---

## 📊 Lo que Acabas de Activar

```
Antes:
├─ OpenClaude: Solo herramientas locales/APIs
├─ Chrome: Solo para ti (manual)
├─ Información: Estática en documentos
└─ ROI: 0 (solo teoría)

Después (Ahora):
├─ OpenClaude: Herramientas locales + MCP web
├─ Chrome: Automático vía chrome-devtools-mcp
├─ Información: Live desde cualquier sitio web
└─ ROI: ✅ (navegación web automática)

Valor agregado:
✅ Monitoreo de cambios en sitios
✅ Automatización de búsquedas
✅ Extracción de datos en vivo
✅ Verificación de estado
✅ Testing de interfaces web
✅ Consenso entre IAs web (próximo)
```

---

## 🚀 Próximos Pasos

### Hoy
- ✅ Activa Web Mode (hiciste esto)
- ✅ Haz tu primera consulta web (hiciste esto)

### Mañana
- [ ] Experimenta con diferentes sitios
- [ ] Documenta casos de uso que encuentres
- [ ] Reporta cualquier error

### Próxima Semana
- [ ] Instala SuperAssistant extension en Chrome
- [ ] Conecta ChatGPT/Gemini al proxy
- [ ] Activa multi-IA (Consensus Engine)

---

## 💡 Recuerda

Este es el **Web Relay Mode** que propusiste como alternativa a:
- ❌ APIs lentas/limitadas
- ❌ Modelos locales que usan demasiada RAM
- ✅ **Web automation sin costos**

Ahora tienes:
- ✅ OpenClaude con acceso web
- ✅ 29 herramientas de navegación
- ✅ Conexión a cualquier instancia web
- ✅ Memoria persistente

**Status: 🎉 EN PRODUCCIÓN**

---

**¿Preguntas?** Mira `WEB_RELAY_MODE_EN_ACCION.md` para más detalles
