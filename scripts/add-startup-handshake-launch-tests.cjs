const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../src/services/webUI/launchAgents.test.ts');
const original = fs.readFileSync(file, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/g, '\n');
function replaceOnce(oldText, newText) {
  const at = source.indexOf(oldText);
  if (at < 0 || source.indexOf(oldText, at + oldText.length) >= 0) throw new Error('Expected one patch target: ' + oldText);
  source = source.slice(0, at) + newText + source.slice(at + oldText.length);
}
replaceOnce('const control = {', `const control = {
  handshakes: [] as Array<{ agentId: string; role?: string; startsAtVerification: number }>,
  failingHandshakeRoles: new Set<string>(),`);
replaceOnce("mock.module('../webRelay/WebRelayProvider.js', () => ({\n  prepareSAAgentForWebRelay,\n}))", `const verifyWebRelayStartup = mock(async (agent: AgentState) => {
  control.handshakes.push({
    agentId: agent.agentId, role: agent.role,
    startsAtVerification: control.starts.length,
  })
  if (control.failingHandshakeRoles.has(agent.role ?? '')) {
    throw new Error('Startup acknowledgement rejected for ' + agent.role)
  }
  return {
    agentId: agent.agentId, instanceId: agent.instanceId,
    platformId: agent.platformId, role: agent.role,
    handshakeId: 'test-' + agent.agentId,
    startedAt: 1, completedAt: 2, status: 'instructions-acknowledged',
  }
})

mock.module('../webRelay/WebRelayProvider.js', () => ({
  prepareSAAgentForWebRelay,
  verifyWebRelayStartup,
}))`);
replaceOnce('  control.saStatusChanges.length = 0', `  control.saStatusChanges.length = 0
  control.handshakes.length = 0
  control.failingHandshakeRoles.clear()
  verifyWebRelayStartup.mockClear()`);
source += `

describe('startup acknowledgement launch gates', () => {
  test('verifies the coordinator before starting workers and verifies every worker', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 3,
      launchCoordinator: true, sessionModes: ['clean', 'clean', 'clean'],
    })
    expect(result.success).toBe(true)
    expect(control.handshakes.map(item => item.role)).toEqual(['primary', 'worker-1', 'worker-2'])
    expect(control.handshakes[0]?.startsAtVerification).toBe(1)
    expect(result.readyAgents).toHaveLength(3)
  })

  test('does not start workers when the coordinator acknowledgement fails', async () => {
    control.failingHandshakeRoles.add('primary')
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 2,
      launchCoordinator: true, sessionModes: ['clean', 'clean'],
    })
    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(control.starts.map(item => item.role)).toEqual(['primary'])
    expect(control.saStatusChanges.filter(item => !item.preparing)).toEqual([])
    expect(result.failures.some(item => item.includes('Startup acknowledgement rejected'))).toBe(true)
  })

  test('does not mark a worker ready when its acknowledgement fails', async () => {
    control.failingHandshakeRoles.add('worker-1')
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'agent', count: 2,
      launchCoordinator: true, sessionModes: ['clean', 'clean'],
    })
    const worker = control.starts.find(item => item.role === 'worker-1')!
    expect(result.success).toBe(false)
    expect(result.readyAgents).toEqual([])
    expect(control.saStatusChanges.some(item => item.agentId === worker.agentId && !item.preparing)).toBe(false)
    expect(control.stops).toContain(worker.agentId)
  })

  test('does not send an automatic startup prompt to manual conversations', async () => {
    const result = await launchWebRelayAgents({
      platformId: 'chatgpt', purpose: 'user', count: 1,
      sessionModes: ['clean'],
    })
    expect(result.success).toBe(true)
    expect(control.handshakes).toEqual([])
  })
})
`;
if (fs.readFileSync(file, 'utf8') !== original) throw new Error('File changed; no write performed');
fs.writeFileSync(file, source.replace(/\n/g, newline), 'utf8');
console.log('Updated launch mocks and added four startup gate tests.');
