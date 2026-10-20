import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_COMPACT_CONTROL_EVIDENCE,
  CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE,
  CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE,
  CHATGPT_AUTO_EXECUTION_EVIDENCE,
  CHATGPT_AUTO_EXECUTION_DIAGNOSIS,
  CHATGPT_HIDDEN_EXECUTION_EVIDENCE,
  diagnoseExecutionFlow,
  SENTINEL_EVIDENCE_MENU_OPTION,
  type SentinelExecutionFlowSnapshot,
} from './SentinelEvidence.js'

const baseSnapshot = (): SentinelExecutionFlowSnapshot => ({
  requestSubmitted: true,
  assistantResponseObserved: true,
  functionCallObserved: true,
  turnSettled: true,
  autoExecuteEnabled: true,
  matchingVisibleExecuteButton: true,
  claimCreated: true,
  executionTriggered: true,
  executionIdentityPresent: true,
  executionStatus: 'success',
  resultInserted: true,
  autoSubmitEnabled: true,
  resultSubmitted: true,
  assistantResponded: true,
  visibility: 'hidden',
  focus: 'unfocused',
  userIntervention: 'not-observed',
})

describe('Sentinel execution-flow evidence', () => {
  test('exposes the evidence notebook as a Sentinel console action', () => {
    expect(SENTINEL_EVIDENCE_MENU_OPTION).toMatchObject({
      value: 'evidence',
      label: 'Evidencia y diagnóstico de llamadas MCP',
    })
  })

  test('retains the observed case and explicitly marks unattended execution as unproven', () => {
    expect(CHATGPT_AUTO_EXECUTION_EVIDENCE.observed).toContain(
      'El usuario informó que visualizó la ventana durante esa interacción; por ello no cuenta como prueba sin intervención.',
    )
    expect(CHATGPT_AUTO_EXECUTION_EVIDENCE.notProven).toContain(
      'Que ChatGPT genere y ejecute la llamada MCP si nadie visualiza o enfoca la página.',
    )
  })

  test('teaches Sentinel the hidden execution evidence and collector-delivery delay', () => {
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('EXECUTION_CREATED con executionId real')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('91 segundos')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('235 segundos')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('52/52 muestras hidden/unfocused')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('retraso máximo de entrega diagnóstica 1774 ms')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('Ambas generaciones se observaron activas en paralelo')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('76/76 muestras')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('no ejecución simultánea de esos dispatches')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('se detuvo sin declarar éxito')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('no se automatizaron las pulsaciones del menú TUI')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('no estaba activa')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('tampoco tenían listener')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('Reporte del usuario (aún no correlacionado con telemetría)')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.observed.join(' ')).toContain('el único CDP activo encontrado fue :9402')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.notProven.join(' ')).toContain('Que cada llamada y cada plataforma funcionen siempre en background')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.notProven.join(' ')).toContain('reporte reciente de dependencia de visualización')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.notProven.join(' ')).toContain('flujo de selección interactiva')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('timestamp de origen')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('no enviar otra llamada')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('/mcp set-mode web')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('call IDs independientes')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('responda en :3006')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('Distinguir la ventana Master (fuente de sesión) de la instancia Relay')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('marcarla no observable')
    expect(CHATGPT_HIDDEN_EXECUTION_EVIDENCE.nextCheck).toContain('no afirmar 100%')
  })

  test('records Claude compact-control preflight without claiming tool execution support', () => {
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('data-adapter="ClaudeAdapter"')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('observer lo volvió a montar')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('VS Code (PID 3864) como ventana foreground')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('z-order puso explícitamente la ventana VS Code por encima de Chrome')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('document.hasFocus=true')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.observed.join(' ')).toContain('visibilityState')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.notProven.join(' ')).toContain('executionId')
    expect(CLAUDE_COMPACT_CONTROL_EVIDENCE.conclusion).toContain('no se ejecutaron prompts ni herramientas')
  })

  test('records hidden and unfocused Claude MCP continuity without overstating internal traces', () => {
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('visibilityState="hidden"')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('OCULTO')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('MCP_VISIBILITY_TEST')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('hasFocus=true')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('MCP_LINK_STEP_ONE')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('MCP_LINK_REPEAT')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('MCP_SEND_HIDDEN_UNFOCUSED')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('30 `RUNTIME_IDENTITY`, 16 `STREAM_MONITORING_STOPPED`')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('0 eventos de parser')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('PID 28232')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.notProven.join(' ')).toContain('ni el almacenamiento de la extensión ni el colector aislado recibieron eventos de ejecución')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.observed.join(' ')).toContain('Usa Opus 5.5 con Claude Pro')
    expect(CLAUDE_HIDDEN_TEXT_RESPONSE_EVIDENCE.conclusion).toContain('hasFocus=false')
  })

  test('records the missing startup prompt and the blocked follow-up without treating it as an MCP test', () => {
    const observed = CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.observed.join(' ')
    expect(observed).toContain('El usuario informa que en una conversación previa Claude sí produjo una llamada real')
    expect(observed).toContain('se hizo antes de insertar el prompt de arranque')
    expect(observed).toContain('Prompt version=original')
    expect(observed).toContain('11,345 caracteres')
    expect(observed).toContain('[reasoning_extraction]')
    expect(observed).toContain('JSONL_PARSER_OUTPUT')
    expect(observed).toContain('AUTO_EXECUTION_TRIGGERED')
    expect(observed).toContain('START_EXECUTION_REQUEST')
    expect(observed).toContain('executionKeyPresent=true')
    expect(CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.conclusion).toContain('omitió Original')
    expect(CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.notProven.join(' ')).toContain(
      'el turno quedó pausado por seguridad',
    )
    expect(CLAUDE_EXECUTION_IDENTITY_DIAGNOSIS_EVIDENCE.nextCheck).toContain(
      'no cambiar de modelo ni modificarlo para saltar esa protección',
    )
  })

  test('keeps the current observed call inconclusive because the user visualized the window', () => {
    expect(CHATGPT_AUTO_EXECUTION_DIAGNOSIS.code).toBe('FOCUS_INDEPENDENCE_UNPROVEN')
    expect(CHATGPT_AUTO_EXECUTION_DIAGNOSIS.confidence).toBe('inconclusive')
  })

  test('does not treat a pre-dispatch claim as proof of a tool execution', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      executionTriggered: false,
      executionIdentityPresent: false,
      executionStatus: 'unknown',
      resultInserted: false,
      resultSubmitted: false,
      assistantResponded: false,
    })

    expect(result.code).toBe('CLAIM_WITHOUT_DISPATCH')
  })

  test('distinguishes an unsent request from a failure in Auto Execute', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      requestSubmitted: false,
      assistantResponseObserved: false,
      functionCallObserved: false,
      turnSettled: false,
      autoExecuteEnabled: false,
    })

    expect(result.code).toBe('USER_REQUEST_NOT_SUBMITTED')
  })

  test('does not attribute a settled request with no model response to Auto Execute or focus', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      assistantResponseObserved: false,
      functionCallObserved: false,
      turnSettled: true,
      autoExecuteEnabled: false,
    })

    expect(result.code).toBe('MODEL_RESPONSE_NOT_OBSERVED')
    expect(result.confidence).toBe('inconclusive')
    expect(result.summary).not.toContain('foco')
  })

  test('distinguishes a model response without a tool call from a dispatch failure', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      functionCallObserved: false,
      claimCreated: false,
      executionTriggered: false,
      executionIdentityPresent: null,
      executionStatus: null,
      resultInserted: null,
      resultSubmitted: null,
      assistantResponded: false,
    })

    expect(result.code).toBe('MODEL_DID_NOT_REQUEST_TOOL')
  })

  test('detects when automatic execution was disabled', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      autoExecuteEnabled: false,
      claimCreated: false,
      executionTriggered: false,
      executionIdentityPresent: null,
      executionStatus: null,
      resultInserted: null,
      resultSubmitted: null,
      assistantResponded: null,
    })

    expect(result.code).toBe('AUTO_EXECUTE_DISABLED')
  })

  test('identifies missing execution identity at the dispatch boundary', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      executionIdentityPresent: false,
      executionStatus: 'missing',
    })

    expect(result.code).toBe('EXECUTION_IDENTITY_MISSING')
  })

  test('rejects a hidden or disabled duplicate card as an executable target', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      matchingVisibleExecuteButton: false,
      claimCreated: false,
      executionTriggered: false,
      executionIdentityPresent: null,
      executionStatus: null,
      resultInserted: null,
      resultSubmitted: null,
      assistantResponded: null,
    })

    expect(result.code).toBe('EXECUTABLE_TARGET_NOT_VISIBLE')
  })

  test('separates successful MCP execution from result insertion failure', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      resultInserted: false,
      resultSubmitted: false,
      assistantResponded: false,
    })

    expect(result.code).toBe('RESULT_NOT_INSERTED')
  })

  test('reports a tool failure separately from result insertion', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      executionStatus: 'error',
      resultInserted: false,
      resultSubmitted: false,
      assistantResponded: false,
    })

    expect(result.code).toBe('MCP_EXECUTION_NOT_SUCCESSFUL')
  })

  test('distinguishes delayed collector diagnostics from a successful MCP execution', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      diagnosticTransportLagMs: 234_700,
    })

    expect(result.code).toBe('EXECUTION_DIAGNOSTICS_DELAYED')
    expect(result.confidence).toBe('inconclusive')
    expect(result.summary).toContain('MCP terminó correctamente')
    expect(result.nextCheck).toContain('chrome.storage.local')
  })

  test('explains a result that was inserted but awaits manual submit', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      autoSubmitEnabled: false,
      resultSubmitted: false,
      assistantResponded: false,
    })

    expect(result.code).toBe('RESULT_WAITING_FOR_USER_SUBMIT')
  })

  test('does not recommend replay when the result was submitted but the model did not continue', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      visibility: 'visible',
      assistantResponded: false,
    })

    expect(result.code).toBe('MODEL_DID_NOT_CONTINUE')
    expect(result.nextCheck).toContain('no reenviar la llamada MCP a ciegas')
  })

  test('detects an unconfirmed automatic submission after successful insertion', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      resultSubmitted: false,
      assistantResponded: false,
    })

    expect(result.code).toBe('AUTO_SUBMIT_NOT_CONFIRMED')
  })

  test('only confirms an unattended flow when focus, visibility, and intervention evidence agree', () => {
    const result = diagnoseExecutionFlow(baseSnapshot())

    expect(result.code).toBe('UNATTENDED_FLOW_VERIFIED')
  })

  test('confirms unattended tool delivery without claiming the final model response', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      assistantResponded: false,
    })

    expect(result.code).toBe('UNATTENDED_TOOL_DELIVERY_VERIFIED')
    expect(result.confidence).toBe('inconclusive')
    expect(result.summary).toContain('no se capturó la respuesta final')
  })

  test('marks a successful flow inconclusive if the user intervened', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      userIntervention: 'occurred',
    })

    expect(result.code).toBe('FOCUS_INDEPENDENCE_UNPROVEN')
    expect(result.confidence).toBe('inconclusive')
  })

  test('does not infer focus from page visibility alone', () => {
    const result = diagnoseExecutionFlow({
      ...baseSnapshot(),
      focus: 'unknown',
    })

    expect(result.code).toBe('EXECUTION_FLOW_INCOMPLETE')
    expect(result.confidence).toBe('inconclusive')
  })
})
