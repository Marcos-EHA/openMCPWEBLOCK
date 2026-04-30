# 📘 GUÍA DE USUARIO - OpenClaude + NVIDIA + DeepSeek v4-pro

## 🎯 ¿QUÉ ES OPENCLAUDE?

OpenClaude es una interfaz de línea de comandos (CLI) que te permite interactuar con múltiples proveedores de IA (OpenAI, Google, Anthropic, NVIDIA, etc.) desde tu terminal. Es como una versión local y personalizable de ChatGPT.

**Con tu configuración actual:**
- 🤖 **Modelo**: DeepSeek v4-pro (modelo chino de IA muy potente)
- 🌐 **Proveedor**: NVIDIA NIM (API de NVIDIA que aloja modelos)
- 💾 **Local**: Se ejecuta en tu máquina
- 🔐 **Privado**: Tus conversaciones no se guardan en servidores

---

## 🚀 CÓMO INICIAR OPENCLAUDE

### Opción 1: Doble clic en el acceso directo (RECOMENDADO)
1. Ve a tu **Escritorio**
2. Busca el icono: **OpenClaude-NVIDIA.lnk**
3. **Doble clic** para abrir
4. Se abrirá una ventana de PowerShell con OpenClaude listo

### Opción 2: Desde la terminal manualmente
1. Abre **PowerShell** o **Terminal de Windows**
2. Copia y pega este comando:

```powershell
$env:CLAUDE_CODE_USE_OPENAI="1"; $env:OPENAI_API_KEY="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"; $env:OPENAI_MODEL="deepseek-ai/deepseek-v4-pro"; $env:OPENAI_BASE_URL="https://integrate.api.nvidia.com/v1"; openclaude
```

3. Presiona **Enter**

### Opción 3: Desde VS Code o cualquier IDE
1. Abre la terminal integrada
2. Ejecuta el comando de la Opción 2

---

## 📖 PRIMEROS PASOS

### 1. Cuando OpenClaude se abre, verás esto:

```
╔════════════════════════════════════════════════════════════╗
│ Provider  NVIDIA NIM                                       │
│ Model     deepseek-ai/deepseek-v4-pro                      │
│ Endpoint  https://integrate.api.nvidia.com/v1              │
╠════════════════════════════════════════════════════════════╣
│ ● cloud    Ready — type /help to begin                     │
╚════════════════════════════════════════════════════════════╝
  openclaude v0.7.0

❯ 
```

### 2. Ver comandos disponibles

Escribe `/help` para ver todos los comandos:

```
❯ /help
```

Verás una lista completa de comandos disponibles.

### 3. Hacer tu primera pregunta

Escribe cualquier pregunta o comando. Ejemplo:

```
❯ ¿Cómo hago un script PowerShell para listar archivos?
```

Presiona **Enter** y DeepSeek responderá.

---

## 🔧 COMANDOS ÚTILES

### Comandos principales:

| Comando | Qué hace | Ejemplo |
|---------|----------|---------|
| `/help` | Ver todos los comandos | `/help` |
| `/mcp` | Ver servidores MCP conectados | `/mcp` |
| `/tools` | Ver herramientas disponibles | `/tools` |
| `/memory` | Acceder a memoria persistente | `/memory` |
| `/provider` | Ver/cambiar proveedor actual | `/provider` |
| `/model` | Ver/cambiar modelo actual | `/model` |
| `exit` | Salir de OpenClaude | `exit` |
| `clear` | Limpiar pantalla | `clear` |

---

## 💬 EJEMPLOS DE PREGUNTAS

### Para programadores:
```
❯ Escribe un script PowerShell que haga backup de mis archivos
❯ ¿Cómo uso Git para fusionar ramas?
❯ Explica por qué mi código Python da error (pega el código)
❯ Optimiza este código SQL para que sea más rápido
```

### Para análisis:
```
❯ Analiza estos datos y explica las tendencias
❯ Resume este documento en 3 puntos clave
❯ Genera un plan de marketing para mi producto
```

### Para creatividad:
```
❯ Escribe un cuento corto sobre...
❯ Genera 10 ideas de nombres para mi startup
❯ Crea un plan de contenido para mi blog
```

---

## ⚙️ CARACTERÍSTICAS ESPECIALES

### 1. Múltiples líneas

Si tu pregunta es muy larga, puedes escribir en varias líneas:

```
❯ Crea un script que:
1. Lea un archivo CSV
2. Filtre los datos
3. Exporte a Excel
```

### 2. Editar messages

Si cometiste un error, usa **flecha arriba** para editar el último mensaje:
```
❯ [flecha arriba] - vuelves al último mensaje
[edita lo que necesites]
[Enter para enviar]
```

### 3. Interrumpir respuestas

Si DeepSeek está respondiendo y quieres detenerlo, presiona **Esc**:
```
[respuesta incompleta...]
Esc → interrumpe la respuesta
```

### 4. Preguntas rápidas sin interrumpir

Si estás en una conversación larga, puedes hacer preguntas laterales:
```
/btw ¿Cuál es la capital de Francia?
```

---

## 🎨 CONSEJOS PARA MEJORES RESPUESTAS

### 1. Sé específico
❌ Mal: "Ayúdame con programación"
✅ Bien: "Escribe una función Python que valide emails"

### 2. Proporciona contexto
```
❯ Necesito un script PowerShell para:
- Buscar archivos .jpg en la carpeta Descargas
- Copiarlos a una carpeta Fotos
- Eliminar los originales
- Mostrar un resumen de lo hecho
```

### 3. Pide verificación
```
❯ ¿Este código está correcto? [pega el código]
❯ ¿Hay algún problema de seguridad en este script?
```

### 4. Pide diferentes formatos
```
❯ Explícame qué es machine learning:
1. De forma muy simple (para mi abuela)
2. De forma técnica (para programadores)
3. Con un ejemplo real
```

---

## ⚡ PRODUCTIVIDAD

### Crear acceso directo en la barra de inicio

1. Busca `OpenClaude-NVIDIA.lnk` en el Escritorio
2. Clic derecho → "Fijar a inicio"
3. Ahora podrás abrirlo desde el menú Inicio

### Abrir en cualquier carpeta

Puedes abrir OpenClaude desde cualquier carpeta:
1. Abre una carpeta
2. Haz clic en la dirección
3. Escribe `powershell`
4. Ejecuta el comando de OpenClaude

### Guardar comandos frecuentes

Crea un archivo `.ps1` con tus comandos:

```powershell
# mi-openclaude.ps1
$env:CLAUDE_CODE_USE_OPENAI="1"
$env:OPENAI_API_KEY="nvapi-..."
$env:OPENAI_MODEL="deepseek-ai/deepseek-v4-pro"
$env:OPENAI_BASE_URL="https://integrate.api.nvidia.com/v1"
openclaude
```

Luego ejecuta: `powershell -File mi-openclaude.ps1`

---

## 🐛 SOLUCIÓN DE PROBLEMAS

### Problema: "OpenClaude command not found"
**Solución**: OpenClaude no está instalado globalmente
```powershell
npm install -g @gitlawb/openclaude@latest
```

### Problema: "Invalid API key"
**Solución**: Tu API key de NVIDIA es incorrecta
1. Ve a https://api.nvidia.com
2. Copia tu API key correcta
3. Reemplaza en el comando

### Problema: DeepSeek responde lentamente
**Solución**: Normal, esto es esperado
- Primeras 30-60 segundos: normal
- Si tarda más: verifica tu conexión a internet

### Problema: No aparece el acceso directo
**Solución**: El acceso directo puede estar en una carpeta diferente
1. Busca en: `C:\Users\apoca\OneDrive\Desktop`
2. O créalo manualmente con nuestro script

### Problema: Quiero cambiar de modelo
**Dentro de OpenClaude**:
```
❯ /model
[elige un modelo de la lista]
```

---

## 🔐 SEGURIDAD Y PRIVACIDAD

✅ **Lo que es seguro:**
- Tu API key se usa solo localmente
- Las conversaciones NO se envían a servidores de terceros
- Puedes ejecutar código en tu máquina
- Tienes control total

⚠️ **Importante:**
- No compartas tu API key (`nvapi-...`) con nadie
- Si la compartes accidentalmente, ve a https://api.nvidia.com y revócala
- Las conversaciones se guardan localmente en tu máquina

---

## 📚 RECURSOS ADICIONALES

- **OpenClaude GitHub**: https://github.com/gitlawb/openclaude
- **Documentación OpenClaude**: https://github.com/gitlawb/openclaude#readme
- **NVIDIA NIM**: https://cloud.nvidia.com/nim
- **DeepSeek API**: https://api-docs.deepseek.com

---

## 💡 CASOS DE USO

### 1. Programación
```
❯ Revisa este código Python y sugiere mejoras
[pega tu código]

❯ ¿Cuál es la mejor forma de hacer este algoritmo?
```

### 2. Escritura
```
❯ Ayúdame a escribir un email profesional para...
❯ Corrige la gramática de este texto
❯ Expande este párrafo con más detalles
```

### 3. Análisis y datos
```
❯ Analiza estos números y dime qué significan
❯ Crea un gráfico de estos datos
❯ Explica las tendencias aquí
```

### 4. Aprendizaje
```
❯ Explícame [concepto] de forma simple
❯ Dame un ejemplo práctico de [tema]
❯ ¿Cuál es la diferencia entre [A] y [B]?
```

---

## 🎉 ¡COMENZAR AHORA!

1. **Doble clic** en el acceso directo del Escritorio
2. **Escribe** tu primera pregunta
3. **Presiona Enter** y espera la respuesta
4. **¡Disfruta!**

---

## 📞 AYUDA RÁPIDA

| Problema | Solución rápida |
|----------|-----------------|
| No sé qué preguntarle | Escribe `/help` |
| Quiero salir | Escribe `exit` |
| Cambiar modelo | Escribe `/model` |
| Ver herramientas | Escribe `/tools` |
| Limpiar pantalla | Escribe `clear` |

---

**¡Listo para empezar! Haz doble clic en el acceso directo y comienza a explorar.**

**Última actualización**: 28 de Abril, 2026  
**Versión**: OpenClaude 0.7.0 + NVIDIA NIM + DeepSeek v4-pro
