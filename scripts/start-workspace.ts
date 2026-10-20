import { enableConfigs } from '../src/utils/config.js'

const healthUrl = 'http://127.0.0.1:3007/health'

async function main(): Promise<void> {
  let existingResponse: Response | undefined
  try {
    existingResponse = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
  } catch {
    // No HTTP response: continue with the normal startup path.
  }
  if (existingResponse) {
    throw new Error('Port 3007 already responds. Inspect the existing service before starting another Workspace.')
  }

  enableConfigs()
  const { ensureWebUIStarted, stopWebUI } = await import('../src/services/webUI/index.js')
  ensureWebUIStarted()

  const shutdown = () => {
    stopWebUI()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        console.log('[Workspace] Ready: http://127.0.0.1:3007')
        console.log('[Workspace] Project directory: ' + process.cwd())
        console.log('[Workspace] PID: ' + process.pid)
        return
      }
    } catch {
      // The listener may still be starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  stopWebUI()
  throw new Error('Workspace did not pass its HTTP health check within 20 seconds')
}

main().catch(error => {
  console.error('[Workspace] Startup failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
