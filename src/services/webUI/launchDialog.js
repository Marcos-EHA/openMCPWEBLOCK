function createLaunchDialog() {
  const overlay = document.createElement('div')
  overlay.id = 'launch-modal'
  overlay.className = 'launch-overlay'
  overlay.innerHTML = `
    <style>
      .launch-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:#050914d9;color:#e4ebf7;font:13px system-ui,sans-serif}
      .launch-panel{box-sizing:border-box;width:min(680px,100%);max-height:90vh;overflow:auto;padding:20px;border:1px solid #34445f;border-radius:14px;background:#111b2c;box-shadow:0 20px 70px #0009}
      .launch-panel h2{margin:0 0 4px;color:#d5cbff;font-size:19px}
      .launch-help{margin:4px 0 14px;color:#9baac1;font-size:12px;line-height:1.45}
      .launch-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      .launch-field{display:flex;flex-direction:column;gap:5px;margin:9px 0}
      .launch-field>span,.launch-section-title{color:#aab9d0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
      .launch-panel select,.launch-panel input[type=number]{box-sizing:border-box;width:100%;min-height:36px;padding:7px 9px;border:1px solid #34445f;border-radius:6px;background:#0b1321;color:#e4ebf7}
      .launch-section{margin-top:14px;padding:12px;border:1px solid #263750;border-radius:9px;background:#0d1727}
      .launch-profiles{display:grid;gap:8px;margin-top:9px}
      .launch-profile{display:grid;grid-template-columns:minmax(90px,.55fr) minmax(135px,1fr) minmax(170px,1.3fr);align-items:center;gap:9px}
      .launch-profile-name{color:#d5cbff;font-size:12px;font-weight:650}
      .launch-check{display:flex;align-items:center;gap:8px;padding:8px 4px;color:#dce5f4}
      .launch-check input{accent-color:#a995ff}
      .launch-error{min-height:18px;margin-top:10px;color:#ff9494;white-space:pre-wrap}
      .launch-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
      .launch-actions button{padding:8px 14px;border:1px solid #425575;border-radius:7px;background:#17243a;color:#dce5f4;cursor:pointer}
      .launch-actions .launch-submit{border-color:#806ae0;background:#6b56c8;color:#fff;font-weight:700}
      .launch-actions button:disabled{opacity:.45;cursor:not-allowed}
      .launch-no-options{padding:10px 4px;color:#a9b6c9}
      @media(max-width:560px){.launch-grid{grid-template-columns:1fr}.launch-profile{grid-template-columns:1fr}.launch-overlay{padding:8px}}
    </style>
    <section class="launch-panel" role="dialog" aria-modal="true" aria-labelledby="launch-title">
      <h2 id="launch-title">Lanzar instancias</h2>
      <p class="launch-help">Elige por separado el tipo de conversación y el rol de las instancias. En modo Agente siempre hay orquestación (cerebro API o Relay Web); modo Usuario abre ventanas para uso manual. Sentinel es un supervisor independiente: su monitor ya se inicia con la aplicación; en la TUI, el destino Gemini puede elegirse en cualquier momento, sin depender de este lanzamiento.</p>
      <label class="launch-field">
        <span>Interfaz de lanzamiento</span>
        <select id="launch-target">
          <option value="relay">Lanzar workers Relay — SA obligatorio</option>
          <option value="master">Abrir cuentas Master — no crea workers Relay</option>
          <option value="local">Lanzar instancia local — Antigravity, Claude Desktop, VS Code</option>
        </select>
      </label>
      <div id="launch-relay-settings">
        <p class="launch-help">Cada Relay debe pasar la preparación y verificación de SuperAssistant antes de que el lanzamiento se informe como listo. En modo Agente, elige el cerebro del orquestador; en modo Usuario, las ventanas son manuales y no reciben tareas del Workspace. Para usar una cuenta Master como worker, selecciona aquí una sesión autenticada para ese Relay.</p>
        <div class="launch-grid">
          <label class="launch-field"><span>Plataforma</span><select id="launch-platform"></select></label>
          <label class="launch-field"><span>Uso</span>
            <select id="launch-purpose">
            <option value="agent">Conversación Agente — coordinador + workers</option>
            <option value="user">Conversación Usuario — ventanas manuales</option>
            </select>
          </label>
          <label class="launch-field" id="launch-coordinator-field"><span>Modo del orquestador (Agente)</span>
            <select id="launch-coordinator">
              <option value="api">Cerebro API — sin Relay dedicado</option>
              <option value="web">Cerebro Web — asignar un Relay como orquestador</option>
            </select>
          </label>
          <label class="launch-field" id="launch-coordinator-count-field"><span>Orquestadores Web candidatos</span><input id="launch-coordinator-count" type="number" min="1" max="19" value="1"></label>
          <label class="launch-field"><span id="launch-count-label">Número de workers</span><input id="launch-count" type="number" min="1" max="20" value="2"></label>
        </div>
        <p id="launch-coordinator-help" class="launch-help"></p>
        <p class="launch-help">Sentinel no consume una instancia de esta lista. Sus invitados guest se lanzan y gestionan por separado desde la consola Sentinel y no se registran como workers de este Workspace.</p>
        <p id="launch-platform-help" class="launch-help"></p>
        <div id="launch-coordinator-session-section" class="launch-section" hidden>
          <div class="launch-section-title">Sesión del orquestador Web</div>
          <p class="launch-help">Cada candidato es una Relay adicional. Para una tarea se elige un coordinador; los demás quedan disponibles para selección manual o respaldo, no se suman a los workers.</p>
          <div id="launch-coordinator-session" class="launch-profiles"></div>
        </div>
        <div class="launch-section">
          <div id="launch-profiles-title" class="launch-section-title">Sesión de cada worker</div>
          <p class="launch-help">Cada opción crea o usa una instancia Relay separada; ninguna controla la ventana normal de Chrome que ya tienes abierta.</p>
          <p id="launch-session-help" class="launch-help" aria-live="polite"></p>
          <label id="launch-profile-copy-consent" class="launch-check" hidden>
            <input id="launch-profile-copy-approved" type="checkbox">
            <span>Autorizo copiar datos a un perfil Relay separado y que OpenMCP solicite el cierre normal de Chrome si sigue abierto. Puede cerrar todas las ventanas; guardaré mi trabajo antes. No se forzará el cierre. La sesión del perfil original y la app ChatGPT no se comparten; la copia puede requerir login en la ventana Relay.</span>
          </label>
          <div id="launch-profiles" class="launch-profiles"></div>
        </div>
      </div>
      <div id="launch-master-settings" class="launch-section" hidden>
        <div class="launch-section-title">Sesiones Master registradas</div>
        <p class="launch-help">Toda Master Session abierta integra y verifica SuperAssistant. Puedes decidir por separado si también la registras como worker de Workspace. La transferencia de sesión a un Relay solo está disponible para plataformas compatibles (ChatGPT y Claude).</p>
        <fieldset class="launch-section" style="margin-top:8px;padding:8px 12px">
          <legend class="launch-section-title">Participación en Workspace</legend>
          <label class="launch-check"><input id="launch-master-register-worker" type="checkbox" checked><span>Registrar las Master seleccionadas como workers de Workspace</span></label>
        </fieldset>
        <div id="launch-masters"></div>
      </div>
      <div id="launch-local-settings" class="launch-section" hidden>
        <div class="launch-section-title">Instancias locales</div>
        <p class="launch-help">Lanza aplicaciones IA instaladas en tu equipo. Cada app usa su propia sesión y autenticación; el Workspace no almacena credenciales. Si la app ya está abierta, se adjunta sin relanzarla. Al desconectar, la app sigue abierta.</p>
        <label class="launch-field"><span>Aplicación</span><select id="launch-local-platform"></select></label>
        <p id="launch-local-help" class="launch-help"></p>
        <p id="launch-local-model-help" class="launch-help" hidden></p>
        <div id="launch-local-status" class="launch-help"></div>
      </div>
      <div id="launch-error" class="launch-error" role="status" aria-live="polite"></div>
      <div class="launch-actions">
        <button id="launch-cancel" type="button">Cancelar</button>
        <button id="launch-submit" class="launch-submit" type="button" disabled>Lanzar</button>
      </div>
    </section>`
  document.body.appendChild(overlay)

  const byId = id => overlay.querySelector('#' + id)
  const target = byId('launch-target')
  const platform = byId('launch-platform')
  const purpose = byId('launch-purpose')
  const coordinator = byId('launch-coordinator')
  const count = byId('launch-count')
  const coordinatorCountInput = byId('launch-coordinator-count')
  const profiles = byId('launch-profiles')
  const coordinatorProfile = byId('launch-coordinator-session')
  const masters = byId('launch-masters')
  const error = byId('launch-error')
  const submit = byId('launch-submit')
  let options = { platforms: [], masterSessions: [], chromeProfiles: [], localPlatforms: [] }
  let plans = []
  let coordinatorPlans = [{ mode: 'clean', sourceId: '' }]
  let submitting = true
  let optionsReady = false
  let closed = false
  let refreshTimer
  let latestOperations = []
  let missingPendingLaunch = false
  const pendingKey = 'workspace.pending-launch.v1'
  const tracking = document.createElement('section')
  tracking.className = 'launch-section'
  const trackingText = document.createElement('div')
  trackingText.style.whiteSpace = 'pre-wrap'
  trackingText.setAttribute('role', 'status')
  trackingText.setAttribute('aria-live', 'polite')
  trackingText.textContent = 'Consultando lanzamientos anteriores...'
  const recover = document.createElement('button')
  recover.type = 'button'
  recover.textContent = 'Consultar estado'
  tracking.append(trackingText, recover)
  error.before(tracking)
  byId('launch-cancel').textContent = 'Cerrar'

  function pendingLaunch() {
    const raw = localStorage.getItem(pendingKey)
    if (!raw) return null
    const saved = JSON.parse(raw)
    if (!saved || typeof saved.id !== 'string' || !saved.payload) {
      throw new Error('La solicitud local pendiente no se puede interpretar. Revisa el historial antes de lanzar otra.')
    }
    return saved
  }

  function selectedLaunchScope() {
    const targetId = byId('launch-target').value
    if (targetId === 'local') {
      return { target: targetId, platformId: byId('launch-local-platform').value }
    }
    if (targetId === 'master') return { target: targetId, platformId: 'master' }
    return { target: 'relay', platformId: byId('launch-platform').value }
  }

  function launchScopeLabel(operation) {
    const operationTarget = operation.target || 'relay'
    const platformId = operation.platformId || 'unknown'
    const platform = operationTarget === 'local'
      ? options.localPlatforms.find(item => item.id === platformId)
      : options.platforms.find(item => item.id === platformId)
    const targetLabel = operationTarget === 'local' ? 'Instancia local'
      : operationTarget === 'master' ? 'Master'
        : 'Relay'
    return `${targetLabel} · ${platform?.name || platformId}`
  }

  function renderLaunchHistory(operations, missing) {
    const scope = selectedLaunchScope()
    const unresolved = operations.filter(operation =>
      ['running', 'unknown'].includes(operation.status),
    )
    const scoped = operations.filter(operation =>
      (operation.target || 'relay') === scope.target &&
      (scope.target === 'master' || !scope.platformId ||
        !operation.platformId || operation.platformId === scope.platformId),
    )
    const visible = [...unresolved, ...scoped.filter(operation => !unresolved.includes(operation))]
      .slice(0, 5)
    const labels = { running: 'En curso', succeeded: 'Completado', failed: 'Fallo', unknown: 'Resultado desconocido' }
    trackingText.textContent = (missing
      ? 'Solicitud pendiente de confirmar. Recuperarla usa el mismo identificador.\n\n'
      : '') + (visible.map(operation => {
        const seconds = Math.max(0, Math.floor(((operation.finishedAt || Date.now()) - operation.createdAt) / 1000))
        return `${labels[operation.status] || operation.status} · ${seconds} s · ${new Date(operation.createdAt).toLocaleString()} · ${launchScopeLabel(operation)}\n${operation.id}${operation.error ? '\n' + operation.error : ''}`
      }).join('\n\n') || 'No hay lanzamientos anteriores para esta aplicación y tipo.')
  }

  async function sendStoredLaunch(saved) {
    const response = await fetch('/api/launch?async=1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...saved.payload, requestId: saved.id }),
      signal: AbortSignal.timeout(15000),
    })
    const result = await response.json()
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        const current = pendingLaunch()
        if (current?.id === saved.id) localStorage.removeItem(pendingKey)
      }
      throw new Error(result.error || `No se pudo confirmar la solicitud (HTTP ${response.status}).`)
    }
  }

  async function refreshLaunches(recoverMissing = false) {
    if (closed) return
    clearTimeout(refreshTimer)
    recover.disabled = true
    try {
      const response = await fetch('/api/launch-operations', {
        cache: 'no-store', signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`No se pudo consultar el historial (HTTP ${response.status}).`)
      const result = await response.json()
      if (!Array.isArray(result.operations)) throw new Error('El servidor no devolvio un historial valido.')
      const operations = result.operations
      latestOperations = operations
      const saved = pendingLaunch()
      const known = saved && operations.find(operation => operation.id === saved.id)
      if (known) localStorage.removeItem(pendingKey)
      const missing = saved && !known
      missingPendingLaunch = Boolean(missing)
      if (missing && recoverMissing) {
        await sendStoredLaunch(saved)
        return await refreshLaunches(false)
      }
      submitting = Boolean(missing || operations.some(operation => ['running', 'unknown'].includes(operation.status)))
      renderLaunchHistory(operations, missing)
      recover.textContent = missing ? 'Recuperar solicitud pendiente' : 'Consultar estado'
      submit.textContent = submitting ? 'Lanzamiento pendiente' : 'Lanzar'
      submit.disabled = !optionsReady || submitting
      if (operations.some(operation => operation.status === 'running') || missing) {
        refreshTimer = setTimeout(() => { void refreshLaunches() }, 2000)
      }
    } catch (caught) {
      submitting = true
      submit.disabled = true
      trackingText.textContent = 'Estado no confirmado. Consultar o recuperar la solicitud no crea un nuevo identificador.'
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      recover.disabled = false
    }
  }
  target.addEventListener('change', () => renderLaunchHistory(latestOperations, missingPendingLaunch))
  byId('launch-platform').addEventListener('change', () =>
    renderLaunchHistory(latestOperations, missingPendingLaunch),
  )
  byId('launch-local-platform').addEventListener('change', () =>
    renderLaunchHistory(latestOperations, missingPendingLaunch),
  )
  recover.addEventListener('click', () => { void refreshLaunches(true) })
  void refreshLaunches()

  let onKey
  const close = () => {
    closed = true
    clearTimeout(refreshTimer)
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  byId('launch-cancel').addEventListener('click', close)
  overlay.addEventListener('click', event => { if (event.target === overlay) close() })
  onKey = event => {
    if (event.key === 'Escape' && document.body.contains(overlay)) {
      close()
    }
  }
  document.addEventListener('keydown', onKey)

  const supportsMaster = platformId => platformId === 'chatgpt' || platformId === 'claude'
  const coordinatesTasks = () => purpose.value === 'agent'
  const launchesWebCoordinator = () => purpose.value === 'agent' && coordinator.value === 'web'
  const requestedCoordinatorCount = () => launchesWebCoordinator()
    ? Number(coordinatorCountInput.value)
    : 0
  const maximumWorkerCount = () => 20 - requestedCoordinatorCount()
  const matchingSources = () => options.masterSessions.filter(source =>
    source.platformId === platform.value,
  )
  const matchingChromeProfiles = () => platform.value === 'chatgpt'
    ? options.chromeProfiles
    : []

  function renderSessionProfile(container, plan, label) {
    const row = document.createElement('div')
    row.className = 'launch-profile'
    const name = document.createElement('div')
    name.className = 'launch-profile-name'
    name.textContent = label
    const mode = document.createElement('select')
    mode.setAttribute('aria-label', `Sesión de ${label.toLocaleLowerCase()}`)
    const guest = document.createElement('option')
    guest.value = 'clean'
    guest.textContent = 'Guest / clean'
    mode.appendChild(guest)
    if (supportsMaster(platform.value)) {
      const authenticated = document.createElement('option')
      authenticated.value = 'authenticated'
      authenticated.textContent = 'Cuenta autenticada'
      mode.appendChild(authenticated)
    }
    if (matchingChromeProfiles().length) {
      const chromeProfile = document.createElement('option')
      chromeProfile.value = 'chrome-profile'
      chromeProfile.textContent = 'Importar desde Chrome (copia aislada)'
      mode.appendChild(chromeProfile)
    }
    mode.value = plan.mode
    mode.addEventListener('change', () => {
      plan.mode = mode.value
      if (mode.value !== 'authenticated') plan.sourceId = ''
      if (mode.value !== 'chrome-profile') plan.chromeProfileDirectory = ''
      renderProfiles()
    })
    row.append(name, mode)
    if (plan.mode === 'authenticated' && supportsMaster(platform.value)) {
      const source = document.createElement('select')
      source.setAttribute('aria-label', `Master Session de ${label.toLocaleLowerCase()}`)
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = matchingSources().length
        ? 'Selecciona una Master Session'
        : `Sin sesiones ${platform.value} registradas`
      source.appendChild(placeholder)
      for (const item of matchingSources()) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = `${item.name} (${item.id})${item.active ? (item.authenticated ? ' · activa' : ' · requiere inicio de sesión') : ' · se abrirá al lanzar'}`
        source.appendChild(option)
      }
      source.value = plan.sourceId
      source.addEventListener('change', () => { plan.sourceId = source.value })
      row.appendChild(source)
    } else if (plan.mode === 'chrome-profile' && matchingChromeProfiles().length) {
      const source = document.createElement('select')
      source.setAttribute('aria-label', `Perfil local de Chrome de ${label.toLocaleLowerCase()}`)
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = 'Selecciona un perfil de Chrome'
      source.appendChild(placeholder)
      for (const item of matchingChromeProfiles()) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = `${item.name} (${item.id})`
        source.appendChild(option)
      }
      source.value = plan.chromeProfileDirectory
      source.addEventListener('change', () => { plan.chromeProfileDirectory = source.value })
      row.appendChild(source)
    } else {
      const note = document.createElement('span')
      note.className = 'launch-help'
      note.textContent = supportsMaster(platform.value)
        ? plan.mode === 'chrome-profile'
          ? 'Elige un perfil Chrome detectado para copiarlo.'
          : 'Usa perfil aislado sin cookies Master.'
        : 'Esta plataforma usa un perfil limpio.'
      row.appendChild(note)
    }
    container.appendChild(row)
  }

  function renderProfiles() {
    const nextCount = Number(count.value)
    const max = maximumWorkerCount()
    count.min = '1'
    count.max = String(max)
    byId('launch-count-label').textContent = purpose.value === 'user'
      ? 'Número de instancias'
      : 'Número de workers'
    byId('launch-profiles-title').textContent = purpose.value === 'user'
      ? 'Sesión de cada instancia'
      : 'Sesión de cada worker'
    const coordinatorSessionSection = byId('launch-coordinator-session-section')
    coordinatorSessionSection.hidden = !launchesWebCoordinator()
    coordinatorProfile.replaceChildren()
    if (launchesWebCoordinator()) {
      const coordinatorCount = requestedCoordinatorCount()
      while (coordinatorPlans.length < coordinatorCount) coordinatorPlans.push({ mode: 'clean', sourceId: '' })
      coordinatorPlans = coordinatorPlans.slice(0, coordinatorCount)
      coordinatorPlans.forEach((plan, index) => {
        renderSessionProfile(coordinatorProfile, plan, `Orquestador Web ${index + 1}`)
      })
    }
    const hasChromeProfilePlan = [...plans, ...(launchesWebCoordinator() ? coordinatorPlans : [])]
      .some(plan => plan.mode === 'chrome-profile')
    byId('launch-profile-copy-consent').hidden = !hasChromeProfilePlan
    const selectedModes = [...new Set(
      [...plans, ...(launchesWebCoordinator() ? coordinatorPlans : [])]
        .map(plan => plan.mode),
    )]
    const sessionHelp = byId('launch-session-help')
    const sessionDescriptions = {
      clean: 'Guest / clean inicia un Relay separado sin copiar cookies del perfil normal ni de una Master; tendrás que iniciar sesión manualmente si el servicio lo requiere.',
      authenticated: 'Cuenta autenticada crea un Relay separado y obtiene la sesión de la Master seleccionada. La Master administra esa sesión persistente; no se comparte la carpeta de datos de Chrome. Ambas instancias usan la misma cuenta y cuota.',
      'chrome-profile': 'Importa cookies y datos de sitio seleccionados a un perfil Relay aislado; no usa la ventana Chrome normal ni la app ChatGPT. Tras autorizar, OpenMCP solicitará un cierre normal de Chrome si hace falta, pero no lo forzará. La copia puede requerir login en la propia ventana Relay; después la sesión persiste solo allí. Para reutilizar una sesión sin importar datos, usa una Master Session.',
    }
    sessionHelp.textContent = selectedModes
      .map(mode => sessionDescriptions[mode])
      .filter(Boolean)
      .join(' ')
    if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > max) {
      profiles.replaceChildren()
      return
    }
    while (plans.length < nextCount) plans.push({ mode: 'clean', sourceId: '' })
    plans = plans.slice(0, nextCount)
    profiles.replaceChildren()
    plans.forEach((plan, index) => {
      const label = purpose.value === 'user'
        ? `Instancia ${index + 1}`
        : `Worker ${index + 1}`
      renderSessionProfile(profiles, plan, label)
    })
  }

  function renderMasterSessions() {
    masters.replaceChildren()
    if (!options.masterSessions.length) {
      const empty = document.createElement('div')
      empty.className = 'launch-no-options'
      empty.textContent = 'No hay fuentes Master registradas.'
      masters.appendChild(empty)
      return
    }
    for (const source of options.masterSessions) {
      const label = document.createElement('label')
      label.className = 'launch-check'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.value = source.id
      const text = document.createElement('span')
      text.textContent = `${source.name} · ${source.platformId} · :${source.debugPort}${source.active ? (source.authenticated ? ' · autenticada' : ' · requiere inicio de sesión') : ' · se abrirá al lanzar'}`
      label.append(input, text)
      masters.appendChild(label)
    }
  }

  function renderTarget() {
    const isMaster = target.value === 'master'
    const isLocal = target.value === 'local'
    byId('launch-relay-settings').hidden = isMaster || isLocal
    byId('launch-master-settings').hidden = !isMaster
    byId('launch-local-settings').hidden = !isLocal
    const registerMasterWorkers = byId('launch-master-register-worker').checked
    if (isLocal) {
      const localPlatform = byId('launch-local-platform')
      submit.textContent = localPlatform && localPlatform.value ? 'Lanzar ' + (localPlatform.selectedOptions[0]?.textContent || 'instancia') : 'Selecciona una app'
      submit.disabled = !optionsReady || submitting || !localPlatform?.value
    } else {
      submit.textContent = isMaster
        ? (registerMasterWorkers ? 'Abrir con SA y registrar workers' : 'Abrir cuentas con SA')
        : purpose.value === 'user'
          ? 'Abrir ventanas de usuario'
          : launchesWebCoordinator()
            ? 'Lanzar orquestador Web + workers'
            : 'Lanzar workers + orquestador API'
    }
  }

  function renderCoordinatorControl() {
    const agentMode = purpose.value === 'agent'
    byId('launch-coordinator-field').hidden = !agentMode
    byId('launch-coordinator-count-field').hidden = !launchesWebCoordinator()
    byId('launch-coordinator-help').hidden = !agentMode
    byId('launch-coordinator-help').textContent = !agentMode
      ? ''
      : coordinator.value === 'api'
        ? 'El orquestador planifica y revisa usando el modelo API configurado; no ocupa una Relay. El número indicado corresponde a workers (mínimo uno).'
        : 'Se lanzará el número de coordinadores Web indicado, además de los workers. En cada tarea se usa un coordinador; los candidatos adicionales no cuentan como workers. Todas las instancias deben pasar la preparación de SuperAssistant.'
  }

  function enforceMinimumCount() {
    const max = maximumWorkerCount()
    count.min = '1'
    count.max = String(max)
    if (Number(count.value) < 1) count.value = '1'
    if (Number(count.value) > max) count.value = String(max)
  }

  function renderPlatformHelp() {
    const selected = options.platforms.find(item => item.id === platform.value)
    byId('launch-platform-help').textContent = selected?.description || ''
  }

  target.addEventListener('change', renderTarget)
  overlay.querySelectorAll('input[name="launch-master-mode"]').forEach(input =>
    input.addEventListener('change', renderTarget),
  )
  purpose.addEventListener('change', () => {
    enforceMinimumCount()
    renderCoordinatorControl()
    renderProfiles()
    renderTarget()
  })
  coordinator.addEventListener('change', () => {
    if (coordinator.value === 'web' && Number(coordinatorCountInput.value) < 1) {
      coordinatorCountInput.value = '1'
    }
    enforceMinimumCount()
    renderCoordinatorControl()
    renderProfiles()
    renderTarget()
  })
  coordinatorCountInput.addEventListener('input', () => {
    const next = Number(coordinatorCountInput.value)
    if (Number.isInteger(next) && next >= 1 && next < 20) {
      enforceMinimumCount()
      renderProfiles()
      renderTarget()
    }
  })
  count.addEventListener('input', renderProfiles)
  platform.addEventListener('change', () => {
    plans = plans.map(() => ({ mode: 'clean', sourceId: '', chromeProfileDirectory: '' }))
    coordinatorPlans = coordinatorPlans.map(() => ({ mode: 'clean', sourceId: '', chromeProfileDirectory: '' }))
    renderPlatformHelp()
    renderProfiles()
  })
  async function submitLaunch(payload) {
    if (submitting || !optionsReady) return
    submitting = true
    submit.disabled = true
    submit.textContent = 'Registrando lanzamiento...'
    try {
      const saved = pendingLaunch() || { id: crypto.randomUUID(), payload }
      localStorage.setItem(pendingKey, JSON.stringify(saved))
      await sendStoredLaunch(saved)
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    }
    await refreshLaunches()
  }

  submit.addEventListener('click', () => {
    error.textContent = ''
    if (target.value === 'local') {
      const localPlatformSelect = byId('launch-local-platform')
      if (!localPlatformSelect?.value) {
        error.textContent = 'Selecciona una aplicación local.'
        return
      }
      void submitLaunch({
        type: 'launch',
        target: 'local',
        platformId: localPlatformSelect.value,
        registerAsWorkspaceWorker: true,
      })
      return
    }
    if (target.value === 'master') {
      const masterSessionSourceIds = [...masters.querySelectorAll('input:checked')].map(input => input.value)
      if (!masterSessionSourceIds.length) {
        error.textContent = 'Selecciona al menos una Master Session.'
        return
      }
      void submitLaunch({
        type: 'launch',
        target: 'master',
        platformId: 'master',
        masterSessionSourceIds,
        registerAsWorkspaceWorker: byId('launch-master-register-worker').checked,
      })
      return
    }
    const coordinatorNumber = requestedCoordinatorCount()
    if (launchesWebCoordinator() &&
      (!Number.isInteger(coordinatorNumber) || coordinatorNumber < 1 || coordinatorNumber > 19)) {
      error.textContent = 'Selecciona entre 1 y 19 candidatos a orquestador Web.'
      return
    }
    const number = Number(count.value)
    const max = maximumWorkerCount()
    if (!Number.isInteger(number) || number < 1 || number > max) {
      error.textContent = launchesWebCoordinator()
        ? `Selecciona entre 1 y ${max} workers para que quepan junto a los orquestadores Web (máximo 20 instancias en total).`
        : `Selecciona entre 1 y ${max} ${purpose.value === 'user' ? 'instancias' : 'workers'}.`
      return
    }
    const workerInstances = plans.slice(0, number).map(plan => ({
      sessionMode: plan.mode,
      ...(plan.mode === 'authenticated' && plan.sourceId
        ? { masterSessionSourceId: plan.sourceId }
        : {}),
      ...(plan.mode === 'chrome-profile' && plan.chromeProfileDirectory
        ? { chromeProfileDirectory: plan.chromeProfileDirectory }
        : {}),
    }))
    const missingWorkerSource = workerInstances.findIndex(instance =>
      instance.sessionMode === 'authenticated' && !instance.masterSessionSourceId,
    )
    if (missingWorkerSource !== -1) {
      error.textContent = `Selecciona la Master Session para el worker ${missingWorkerSource + 1}.`
      return
    }
    const missingWorkerChromeProfile = workerInstances.findIndex(instance =>
      instance.sessionMode === 'chrome-profile' && !instance.chromeProfileDirectory,
    )
    if (missingWorkerChromeProfile !== -1) {
      error.textContent = `Selecciona el perfil Chrome para el worker ${missingWorkerChromeProfile + 1}.`
      return
    }
    const coordinatorInstances = launchesWebCoordinator()
      ? coordinatorPlans.slice(0, requestedCoordinatorCount()).map(plan => ({
        sessionMode: plan.mode,
        ...(plan.mode === 'authenticated' && plan.sourceId
          ? { masterSessionSourceId: plan.sourceId }
          : {}),
        ...(plan.mode === 'chrome-profile' && plan.chromeProfileDirectory
          ? { chromeProfileDirectory: plan.chromeProfileDirectory }
          : {}),
      }))
      : []
    const missingCoordinatorSource = coordinatorInstances.findIndex(instance =>
      instance.sessionMode === 'authenticated' && !instance.masterSessionSourceId,
    )
    if (missingCoordinatorSource !== -1) {
      error.textContent = `Selecciona la Master Session para el orquestador Web ${missingCoordinatorSource + 1}.`
      return
    }
    const missingCoordinatorChromeProfile = coordinatorInstances.findIndex(instance =>
      instance.sessionMode === 'chrome-profile' && !instance.chromeProfileDirectory,
    )
    if (missingCoordinatorChromeProfile !== -1) {
      error.textContent = `Selecciona el perfil Chrome para el orquestador Web ${missingCoordinatorChromeProfile + 1}.`
      return
    }
    const hasChromeProfile = [...coordinatorInstances, ...workerInstances]
      .some(instance => instance.sessionMode === 'chrome-profile')
    if (hasChromeProfile && !byId('launch-profile-copy-approved').checked) {
      error.textContent = 'Confirma que autorizas copiar el perfil Chrome seleccionado.'
      return
    }
    const instances = [...coordinatorInstances, ...workerInstances]
    void submitLaunch({
      type: 'launch',
      target: 'relay',
      platformId: platform.value,
      purpose: purpose.value,
      ...(purpose.value === 'agent'
        ? {
          coordinateTasks: coordinatesTasks(),
          orchestratorBrain: launchesWebCoordinator() ? 'web' : 'api',
          launchCoordinator: launchesWebCoordinator(),
          ...(launchesWebCoordinator() ? { coordinatorCount: coordinatorInstances.length } : {}),
        }
        : {}),
      count: instances.length,
      instances,
      ...(hasChromeProfile ? { allowChromeProfileCopy: true } : {}),
    })
  })

  fetch('/api/status')
    .then(response => {
      if (!response.ok) throw new Error(`No se pudo cargar el estado del workspace (HTTP ${response.status}).`)
      return response.json()
    })
    .then(data => {
      options = {
        platforms: Array.isArray(data.platforms) ? data.platforms : [],
        masterSessions: Array.isArray(data.masterSessions) ? data.masterSessions : [],
        chromeProfiles: Array.isArray(data.chromeProfiles) ? data.chromeProfiles : [],
        localPlatforms: Array.isArray(data.localPlatforms) ? data.localPlatforms : [],
      }
      if (options.platforms.length === 0) throw new Error('El servidor no anunció plataformas web disponibles.')
      for (const item of options.platforms) {
        const option = document.createElement('option')
        option.value = item.id
        option.textContent = item.name
        platform.appendChild(option)
      }
      // Populate local platforms
      const localPlatformSelect = byId('launch-local-platform')
      if (localPlatformSelect && options.localPlatforms.length) {
        const placeholder = document.createElement('option')
        placeholder.value = ''
        placeholder.textContent = 'Selecciona una aplicación...'
        localPlatformSelect.appendChild(placeholder)
        for (const item of options.localPlatforms) {
          const option = document.createElement('option')
          option.value = item.id
          option.textContent = `${item.name}${item.installed ? '' : ' (no instalado)'}`
          option.disabled = !item.installed
          localPlatformSelect.appendChild(option)
        }
        localPlatformSelect.addEventListener('change', () => {
          const selected = options.localPlatforms.find(p => p.id === localPlatformSelect.value)
          byId('launch-local-help').textContent = selected?.description || ''
          const modelHelp = byId('launch-local-model-help')
          modelHelp.hidden = selected?.id !== 'antigravity'
          modelHelp.textContent = selected?.id === 'antigravity'
            ? 'Modelo: se elige dentro de Antigravity, en el selector bajo el cuadro de conversación, y queda asociado a esa conversación. OpenMCP no puede preseleccionarlo ni verificarlo al lanzar. Antes de enviar tareas, confirma allí que esté activo el modelo que quieres usar (por ejemplo, Gemini 3.8 si aparece disponible en tu cuenta).'
            : ''
          const statusEl = byId('launch-local-status')
          if (selected) {
            if (selected.installed) {
              const location = selected.launchMethod === 'msix'
                ? (selected.version ? `v${selected.version} (Microsoft Store)` : 'Microsoft Store')
                : (selected.executablePath || 'ruta detectada')
              statusEl.textContent = `✓ Instalado · ${location}`
            } else {
              statusEl.textContent = '✗ No detectado en el sistema'
            }
          } else {
            statusEl.textContent = ''
          }
          renderTarget()
        })
      } else if (localPlatformSelect) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = 'No se detectaron aplicaciones locales'
        localPlatformSelect.appendChild(option)
      }
      renderMasterSessions()
      renderPlatformHelp()
      renderCoordinatorControl()
      renderProfiles()
      renderTarget()
      optionsReady = true
      submit.disabled = submitting
    })
    .catch(caught => {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    })
}

if (typeof window !== 'undefined') window.createLaunchDialog = createLaunchDialog
