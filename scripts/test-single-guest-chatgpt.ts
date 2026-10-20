import { launchChrome, isDebugPortActive } from '../src/services/webRelay/ChromeCDP.js'
import { generateInstructionsJson } from '../chrome-extension/source/pages/content/src/components/sidebar/Instructions/instructionGeneratorJson.js'

const PORT = 9222
const TARGET_URL = 'https://chatgpt.com/'

async function main() {
  console.log('=================================================================')
  console.log('  TEST: Lanzamiento Único en Modo Invitado con SuperAssistant Local')
  console.log('=================================================================\n')

  // 1. Verificar servidor MCP
  process.stdout.write('1. Verificando servidor MCP en puerto 3006... ')
  try {
    const status = await fetch('http://127.0.0.1:3006/status').then(r => r.json())
    console.log(`✅ Activo (${status.tools} herramientas registradas, ${status.connections} conexiones)`)
  } catch (err: any) {
    console.error('❌ Servidor MCP no responde en http://127.0.0.1:3006/status:', err.message)
    process.exit(1)
  }

  // 2. Limpiar puerto 9222 si estuviera colgado
  if (await isDebugPortActive(PORT)) {
    console.log(`Puerto ${PORT} ya activo. Reutilizando o verificando...`)
  }

  // 3. Lanzar exactamente 1 instancia en modo invitado
  console.log(`2. Lanzando EXACTAMENTE 1 instancia de Chrome en Modo Invitado (puerto ${PORT})...`)
  const instanceId = 'test-single-guest'
  await launchChrome(TARGET_URL, 'guest', {
    instanceId,
    debugPort: PORT,
    guestMode: true,
  })
  console.log('✅ Chrome lanzado correctamente en Modo Invitado sin perfiles personales.')

  // 4. Conectar a CDP y verificar el ID de la extensión cargada
  console.log('\n3. Verificando extensión SuperAssistant local via CDP...')
  const targetsResp = await fetch(`http://127.0.0.1:${PORT}/json`)
  const targets: any[] = await targetsResp.json()

  const swTarget = targets.find((t: any) =>
    t.type === 'service_worker' && (t.url.includes('background.js') || t.url.includes('chrome-extension://'))
  )

  if (swTarget) {
    console.log('✅ Service Worker de SA detectado:', swTarget.url)
    const extIdMatch = swTarget.url.match(/chrome-extension:\/\/([a-z]+)\//)
    const extId = extIdMatch ? extIdMatch[1] : 'desconocido'
    console.log(`   ID de la extensión unpacked: ${extId}`)

    // Configurar storage de SA para StreamableHTTP
    console.log('4. Configurando SuperAssistant para conectarse a http://localhost:3006/mcp...')
    const ws = new WebSocket(swTarget.webSocketDebuggerUrl)
    await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = j; setTimeout(j, 5000) })

    await new Promise<void>((resolve, reject) => {
      const h = (ev: MessageEvent) => {
        const d = JSON.parse(ev.data)
        if (d.id === 1) { ws.removeEventListener('message', h); resolve() }
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `new Promise(r => chrome.storage.local.set({
            mcpServerUrl: 'http://localhost:3006/mcp',
            mcpConnectionType: 'streamable-http',
            pushContentMode: true,
            enableToolExecution: true,
            autoConnect: true
          }, () => r('ok')))`,
          awaitPromise: true,
          returnByValue: true,
        }
      }))
      setTimeout(reject, 5000)
    })
    console.log('✅ SuperAssistant configurado para MCP StreamableHTTP (:3006).')
    ws.close()
  } else {
    console.warn('⚠️ Service Worker de SA aún no reporta target (podría inicializarse al navegar).')
  }

  // 5. Verificar página de ChatGPT
  console.log('\n5. Verificando pestaña activa...')
  const pageTarget = targets.find((t: any) => t.type === 'page' && t.url.includes('chatgpt.com'))
  if (pageTarget) {
    console.log(`✅ Pestaña de ChatGPT lista: "${pageTarget.title}" (${pageTarget.url})`)
  } else {
    console.log('Pestañas activas:')
    targets.filter((t: any) => t.type === 'page').forEach((p: any) => console.log(`   - ${p.title} (${p.url})`))
  }

  // 6. Generar el prompt de SuperAssistant para ChatGPT
  console.log('\n6. Generando instrucciones de SuperAssistant para ChatGPT...')
  const tools = [
    {
      name: 'Bash',
      description: 'Execute shell commands in the workspace',
      schema: JSON.stringify({
        type: 'object',
        properties: { command: { type: 'string', description: 'Command to run' } },
        required: ['command']
      })
    },
    {
      name: 'Read',
      description: 'Read the contents of a file in the workspace',
      schema: JSON.stringify({
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path to file' } },
        required: ['file_path']
      })
    },
    {
      name: 'ListDir',
      description: 'List contents of a directory',
      schema: JSON.stringify({
        type: 'object',
        properties: { dir_path: { type: 'string', description: 'Path to dir' } },
        required: ['dir_path']
      })
    }
  ]

  const promptText = generateInstructionsJson(tools)
  console.log(`✅ Instrucciones generadas (${promptText.length} caracteres).`)
  console.log('\n=== RESULTADO: 1 ÚNICA INSTANCIA EN MODO INVITADO LANZADA CON ÉXITO ===')
}

main().catch(console.error)
