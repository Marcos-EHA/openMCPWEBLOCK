const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../src/services/webRelay/WebRelayCoordinator.test.ts');
const original = fs.readFileSync(file, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
let source = original.replace(/\r\n/g, '\n');
function replaceTest(name, nextName, replacement) {
  const startMarker = `  test('${name}'`;
  const endMarker = `  test('${nextName}'`;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start || source.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`Unexpected test boundaries: ${name}; no file written`);
  }
  source = source.slice(0, start) + replacement + '\n\n' + source.slice(end);
}
replaceTest('uses the selected secondary coordinator and excludes every coordinator candidate from workers', 'does not send a malformed or incomplete plan to workers', `  test('uses the selected secondary coordinator and excludes every coordinator candidate from workers', async () => {
    const secondary: AgentState = {
      ...agents[0]!, agentId: 'relay-orchestrator-2',
      role: 'orchestrator-2', instanceId: 'instance-orchestrator-2',
    }
    const calls: Array<{ agentId: string; prompt: string }> = []
    const beforeSequence = sharedActivityJournal.latestSequence
    const workerResponse = 'Worker found two entrypoints.'
    const result = await runCoordinatedWebTask({
      prompt: 'Investiga la arquitectura', platformId: 'chatgpt',
      agents: [...agents, secondary], coordinatorAgentId: secondary.agentId,
      sendPrompt: async (prompt, _platformId, agentId) => {
        calls.push({ agentId, prompt })
        if (calls.length === 1) return JSON.stringify({
          tasks: [{ agentId: 'relay-worker-2', prompt: 'Revisa los puntos de entrada.' }],
        })
        return agentId === 'relay-worker-2' ? workerResponse : 'Review complete'
      },
    })
    expect(result.coordinatorId).toBe(secondary.agentId)
    expect(result.workerResponses.map(response => response.agentId)).toEqual(['relay-worker-2'])
    expect(calls.map(call => call.agentId)).toEqual([secondary.agentId, 'relay-worker-2', secondary.agentId])
    expect(calls[0]?.prompt).toContain('openmcp_read_activity')
    expect(calls[0]?.prompt).toContain('openmcp_watch_activity')
    const activity = sharedActivityJournal.read({
      afterSequence: beforeSequence, agentIds: ['relay-worker-2'], sources: ['coordinator'],
    }).events
    expect(activity.some(event => event.details?.responseLength === workerResponse.length)).toBe(true)
    expect(JSON.stringify(activity)).not.toContain(workerResponse)
  })`);
replaceTest('allows the user-selected worker to coordinate instead of the default primary', 'routes to explicitly authenticated agents as well as clean agents', `  test('rejects a worker selected as coordinator before dispatching any prompt', async () => {
    const calls: string[] = []
    await expect(runCoordinatedWebTask({
      prompt: 'Revisa esto', platformId: 'chatgpt', agents,
      coordinatorAgentId: 'relay-worker-2',
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        return 'Unexpected dispatch'
      },
    })).rejects.toThrow('relay-worker-2')
    expect(calls).toEqual([])
  })`);
replaceTest('routes to explicitly authenticated agents as well as clean agents', 'reports a stale selected coordinator rather than silently selecting another instance', `  test('routes work to an authenticated worker under a dedicated clean coordinator', async () => {
    const calls: string[] = []
    const mixedSessionAgents = agents.map(agent => agent.agentId === 'relay-worker-2'
      ? { ...agent, sessionMode: 'authenticated' as const } : agent)
    const result = await runCoordinatedWebTask({
      prompt: 'Revisa esto', platformId: 'chatgpt', agents: mixedSessionAgents,
      coordinatorAgentId: 'relay-primary',
      sendPrompt: async (_prompt, _platformId, agentId) => {
        calls.push(agentId)
        if (calls.length === 1) return JSON.stringify({
          tasks: [{ agentId: 'relay-worker-2', prompt: 'Inspect the entrypoint.' }],
        })
        return 'Resultado'
      },
    })
    expect(result.coordinatorId).toBe('relay-primary')
    expect(result.workerResponses).toEqual([{
      agentId: 'relay-worker-2', task: 'Inspect the entrypoint.', response: 'Resultado',
    }])
    expect(calls).toEqual(['relay-primary', 'relay-worker-2', 'relay-primary'])
  })`);
if (fs.readFileSync(file, 'utf8') !== original) throw new Error('File changed during preparation; no file written');
fs.writeFileSync(file, source.replace(/\n/g, newline), 'utf8');
console.log('Updated all three test blocks. Tests still need to run.');
