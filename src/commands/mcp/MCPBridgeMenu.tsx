import React, { useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import { applicationMCPBridge, startApplicationMCPBridge, restartApplicationMCPBridge } from '../../services/mcpServer/ApplicationMCPBridge.js'
import { getCurrentProjectConfig } from '../../utils/config.js'
import { MCP_PORT } from '../../services/mcpServer/mcpPort.js'

export function MCPBridgeMenu({ onComplete }: { onComplete: (message: string) => void }) {
  const [status, setStatus] = useState(() => applicationMCPBridge.status())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const running = useRef(false)
  const describe = status.state === 'owned'
    ? 'Conectado · se cierra al salir de esta aplicación'
    : status.state === 'external'
      ? 'Disponible desde otro proceso · esta aplicación no lo cerrará'
      : status.state === 'error' ? 'No se pudo iniciar la conexión' : 'Detenido'

  const run = async (action: string | undefined) => {
    if (!action || running.current) return
    if (action === 'back') { onComplete('Menú de conexión cerrado'); return }
    running.current = true
    setBusy(true)
    setNotice('')
    try {
      const next = action === 'restart' ? await restartApplicationMCPBridge()
        : action === 'stop' ? await applicationMCPBridge.stop()
        : await startApplicationMCPBridge()
      setStatus(next)
      setNotice(next.state === 'external'
        ? 'La conexión está abierta en otro proceso. Detén ese servidor desde la aplicación o terminal que lo inició; luego elige Iniciar conexión aquí.'
        : action === 'restart' ? 'Conexión reiniciada. Actualiza SuperAssistant si no reconecta automáticamente.'
          : action === 'stop' ? 'Conexión detenida.' : 'Conexión iniciada. Puedes usar la extensión sin abrir una instancia de navegador.')
    } catch (error) {
      setStatus(applicationMCPBridge.status())
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">Conexión con SuperAssistant</Text>
    <Text>Modo: {getCurrentProjectConfig().mcpExecutionMode ?? 'api'} · {describe}</Text>
    <Text dimColor>El puente funciona únicamente en Web. Cambiar a API o Local lo detiene.</Text>
    <Text dimColor>Dirección: http://127.0.0.1:{MCP_PORT}/mcp</Text>
    {notice ? <Text>{notice}</Text> : null}
    {busy ? <Text>Actualizando conexión…</Text> : <Select
      options={[
        { label: 'Iniciar conexión', value: 'start', description: 'Conecta tu extensión sin abrir navegadores.' },
        { label: 'Reiniciar conexión', value: 'restart', description: 'Reinicia el puente de esta aplicación.' },
        { label: 'Detener conexión', value: 'stop', description: 'Detiene únicamente el puente de esta aplicación.' },
        { label: 'Volver', value: 'back' },
      ]}
      onChange={(value: string | undefined) => { void run(value) }}
      onCancel={() => onComplete('Menú de conexión cerrado')}
      visibleOptionCount={4}
    />}
  </Box>
}
