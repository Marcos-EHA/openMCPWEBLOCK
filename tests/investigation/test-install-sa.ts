/**
 * SA Setup: One-time installation via chrome://extensions
 * After this, SA persists in the relay profile for all future sessions.
 */
import { 
  CDPConnection, 
  checkSAInstalled, 
  installSAExtension,
  prepareSAExtension 
} from './src/services/webRelay/ChromeCDP.ts'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('╔════════════════════════════════════════════════════╗')
  console.log('║   SA Extension — Setup (una sola vez)              ║')
  console.log('╚════════════════════════════════════════════════════╝\n')

  // 1. Prepare SA
  console.log('1. Preparando SA extension...')
  const saPath = prepareSAExtension()
  if (!saPath) {
    console.log('   ✗ No se encontró SA en ningún perfil de Chrome')
    process.exit(1)
  }
  console.log(`   ✓ SA lista en: ${saPath}`)

  // 2. Connect CDP
  console.log('\n2. Conectando a Chrome...')
  const cdp = new CDPConnection()
  await cdp.connect()
  console.log('   ✓ Conectado')

  // 3. Check if already installed
  console.log('\n3. Verificando si SA ya está instalada...')
  await cdp.send('Page.navigate', { url: 'chrome://extensions' })
  await sleep(3000)
  
  const existing = await checkSAInstalled(cdp)
  if (existing.installed) {
    console.log(`   ✓ ¡SA ya está instalada! ID: ${existing.id}`)
    console.log('   → No necesitas hacer nada más.')
    
    // Verify on ChatGPT
    console.log('\n4. Verificando SA en ChatGPT...')
    await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' })
    await sleep(6000)
    const state = await cdp.checkPageState()
    console.log(`   SA en DOM: ${state.hasSA ? '✓ ACTIVA' : '✗ No inyectada'}`)
    console.log(`   Login: ${state.isLoggedIn ? '✓' : '✗'}`)
    
    cdp.close()
    process.exit(0)
  }

  // 4. Install SA
  console.log('   → SA NO instalada. Iniciando instalación...')
  console.log('')
  console.log('   ╔═══════════════════════════════════════════════════╗')
  console.log('   ║  📂 Se abrirá un diálogo de selección de carpeta ║')
  console.log('   ║                                                   ║')
  console.log('   ║  Navega a:                                        ║')
  console.log(`   ║  ${saPath.padEnd(49)}║`)
  console.log('   ║                                                   ║')
  console.log('   ║  y haz click en "Seleccionar carpeta"             ║')
  console.log('   ║  (solo necesitas hacer esto UNA VEZ)              ║')
  console.log('   ╚═══════════════════════════════════════════════════╝')
  console.log('')

  const saId = await installSAExtension(cdp)

  if (saId) {
    console.log(`\n   ✓ ¡SA INSTALADA! ID: ${saId}`)
    console.log('   → Permisos de host otorgados (todos los sitios)')
    console.log('   → Chrome recordará esta extensión en futuras sesiones')

    // Navigate to ChatGPT and verify
    console.log('\n5. Verificando SA en ChatGPT...')
    await cdp.send('Page.navigate', { url: 'https://chatgpt.com/' })
    await sleep(8000)
    
    const state = await cdp.checkPageState()
    console.log(`   SA en DOM: ${state.hasSA ? '✓ ACTIVA' : '✗ Aún no inyectada (puede necesitar recarga)'}`)
    console.log(`   Login: ${state.isLoggedIn ? '✓' : '✗ Necesitas loguearte'}`)

    if (!state.hasSA) {
      console.log('\n   Recargando página...')
      await cdp.evaluate('window.location.reload()')
      await sleep(6000)
      const state2 = await cdp.checkPageState()
      console.log(`   SA en DOM: ${state2.hasSA ? '✓ ACTIVA' : '✗ No inyectada'}`)
    }
  } else {
    console.log('\n   ✗ Timeout — SA no se instaló.')
    console.log('   Verifica que seleccionaste la carpeta correcta.')
  }

  cdp.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
