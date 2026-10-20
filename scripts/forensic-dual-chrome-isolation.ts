/**
 * Prueba de aislamiento REAL (Paso 4) — lanza dos instancias de Chrome usando
 * el código de producción real (WebInstanceRegistry.createWebInstance +
 * ChromeCDP.launchChrome), sin mocks, y verifica a nivel de sistema operativo
 * que los perfiles y puertos son genuinamente distintos.
 *
 * Deliberadamente NO navega a chatgpt.com: usa https://example.com (dominio
 * de prueba de IANA, sin sesión ni ToS de por medio) para ejercer exactamente
 * el mismo camino de aislamiento de perfil/puerto sin automatizar un sitio
 * de terceros autenticado sin supervisión humana.
 *
 * Uso: bun run scripts/forensic-dual-chrome-isolation.ts
 */
import {
  createWebInstance,
  releaseWebInstance,
  listInstanceLeases,
  getRegistryBootId,
} from '../src/services/webRelay/WebInstanceRegistry.ts'
import { launchChrome, isDebugPortActive } from '../src/services/webRelay/ChromeCDP.ts'

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  [OK]   ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`)
  }
}

const TEST_URL = 'https://example.com'

async function chromeProcessesByPort(): Promise<Map<number, string>> {
  // PowerShell: cada chrome.exe vivo con su línea de comandos completa.
  const proc = Bun.spawn([
    'powershell', '-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine",
  ], { stdout: 'pipe' })
  const out = await new Response(proc.stdout).text()
  const byPort = new Map<number, string>()
  for (const line of out.split('\n')) {
    const portMatch = line.match(/--remote-debugging-port=(\d+)/)
    if (portMatch) byPort.set(Number(portMatch[1]), line.trim())
  }
  return byPort
}

async function main() {
  console.log(`bootId de este proceso del runtime: ${getRegistryBootId()}\n`)

  console.log('=== Creando dos instancias vía WebInstanceRegistry real ===')
  const instanceA = createWebInstance('forensic-test', 'forensic-agent-A')
  const instanceB = createWebInstance('forensic-test', 'forensic-agent-B')

  console.log(`Instancia A: instanceId=${instanceA.instanceId} debugPort=${instanceA.debugPort}`)
  console.log(`Instancia B: instanceId=${instanceB.instanceId} debugPort=${instanceB.debugPort}`)

  check('los dos instanceId son distintos', instanceA.instanceId !== instanceB.instanceId)
  check('los dos debugPort son distintos', instanceA.debugPort !== instanceB.debugPort)

  console.log('\n=== Lanzando Chrome real para la instancia A (esto abrirá una ventana visible) ===')
  try {
    await launchChrome(TEST_URL, 'Default', { instanceId: instanceA.instanceId, debugPort: instanceA.debugPort })
    console.log('  launchChrome(A) resolvió sin lanzar excepción.')
  } catch (err) {
    console.log(`  launchChrome(A) lanzó una excepción: ${err instanceof Error ? err.message : String(err)}`)
  }

  console.log('\n=== Lanzando Chrome real para la instancia B (segunda ventana visible) ===')
  try {
    await launchChrome(TEST_URL, 'Default', { instanceId: instanceB.instanceId, debugPort: instanceB.debugPort })
    console.log('  launchChrome(B) resolvió sin lanzar excepción.')
  } catch (err) {
    console.log(`  launchChrome(B) lanzó una excepción: ${err instanceof Error ? err.message : String(err)}`)
  }

  console.log('\n=== Verificación a nivel de SO: ¿existen dos procesos chrome.exe con --user-data-dir distintos? ===')
  const activeA = await isDebugPortActive(instanceA.debugPort)
  const activeB = await isDebugPortActive(instanceB.debugPort)
  check(`el puerto ${instanceA.debugPort} (agente A) responde /json/version`, activeA)
  check(`el puerto ${instanceB.debugPort} (agente B) responde /json/version`, activeB)

  const processes = await chromeProcessesByPort()
  const cmdA = processes.get(instanceA.debugPort)
  const cmdB = processes.get(instanceB.debugPort)
  check('hay un proceso chrome.exe real escuchando en el puerto de A', !!cmdA)
  check('hay un proceso chrome.exe real escuchando en el puerto de B', !!cmdB)

  if (cmdA && cmdB) {
    const udA = cmdA.match(/--user-data-dir="?([^"]+?)"?(?:\s|$)/)?.[1]
    const udB = cmdB.match(/--user-data-dir="?([^"]+?)"?(?:\s|$)/)?.[1]
    console.log(`  --user-data-dir de A: ${udA}`)
    console.log(`  --user-data-dir de B: ${udB}`)
    check('los --user-data-dir son directorios DISTINTOS (no es el mismo perfil compartido)',
      !!udA && !!udB && udA !== udB)
    check('el --user-data-dir de A contiene su propio instanceId', !!udA && udA.includes(instanceA.instanceId))
    check('el --user-data-dir de B contiene su propio instanceId', !!udB && udB.includes(instanceB.instanceId))
  }

  if (activeA && activeB) {
    const [verA, verB] = await Promise.all([
      fetch(`http://127.0.0.1:${instanceA.debugPort}/json/version`).then(r => r.json()),
      fetch(`http://127.0.0.1:${instanceB.debugPort}/json/version`).then(r => r.json()),
    ])
    check('los endpoints CDP devuelven un webSocketDebuggerUrl distinto cada uno (son navegadores separados, no pestañas del mismo proceso)',
      verA.webSocketDebuggerUrl !== verB.webSocketDebuggerUrl,
      `A=${verA.webSocketDebuggerUrl} B=${verB.webSocketDebuggerUrl}`)
  }

  console.log('\n=== Historial de leases (observabilidad: ¿qué Chrome tenía cada agente?) ===')
  console.log('  Agente A:', JSON.stringify(listInstanceLeases('forensic-agent-A')))
  console.log('  Agente B:', JSON.stringify(listInstanceLeases('forensic-agent-B')))

  console.log(`\n=== RESUMEN: ${passed} OK, ${failures} FAIL ===`)

  console.log('\n=== Limpieza: cerrando ambos procesos y liberando instancias/locks ===')
  for (const cmd of [cmdA, cmdB]) {
    if (!cmd) continue
    const pidMatchProc = await Bun.spawn([
      'powershell', '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -eq '${cmd.replace(/'/g, "''")}' } | Select-Object -First 1 -ExpandProperty ProcessId)`,
    ], { stdout: 'pipe' })
    const pidStr = (await new Response(pidMatchProc.stdout).text()).trim()
    const pid = Number(pidStr)
    if (pid) {
      try { process.kill(pid) } catch { /* ya cerrado */ }
    }
  }
  releaseWebInstance(instanceA.instanceId)
  releaseWebInstance(instanceB.instanceId)
  console.log('  Listo.')

  if (failures > 0) process.exit(1)
}

main().catch(err => {
  console.error('ERROR FATAL EN LA PRUEBA DE AISLAMIENTO:', err)
  process.exit(1)
})
