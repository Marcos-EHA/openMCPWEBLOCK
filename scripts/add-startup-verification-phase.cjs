const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const changes = [];
function patch(relative, replacements) {
  const file = path.join(root, relative);
  const original = fs.readFileSync(file, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  let source = original.replace(/\r\n/g, '\n');
  for (const [oldText, newText] of replacements) {
    const index = source.indexOf(oldText);
    if (index < 0 || source.indexOf(oldText, index + oldText.length) >= 0) throw new Error('Expected unique target in ' + relative + ': ' + oldText);
    source = source.slice(0, index) + newText + source.slice(index + oldText.length);
  }
  changes.push({ file, original, content: source.replace(/\n/g, newline) });
}
patch('src/services/webRelay/orchestration/types.ts', [
  ["  | 'sa_preparing'", "  | 'sa_preparing'\n  | 'startup_verifying'"],
  ["  sa_preparing:         ['ready', 'stopping', 'error', 'lost'],", "  sa_preparing:         ['startup_verifying', 'ready', 'stopping', 'error', 'lost'],\n  startup_verifying:    ['ready', 'stopping', 'error', 'lost'],"],
]);
patch('src/services/webRelay/orchestration/MultiAgentRunner.ts', [
  ['export function setAgentSAConfigurationStatus(', `export function setAgentStartupVerificationStatus(agentId: string): Promise<AgentState> {
  return withAgentLock(agentId, async () => {
    const record = agents.get(agentId)
    if (!record || record.status !== 'sa_preparing') {
      throw new Error('Startup verification requires an agent in SA preparation: ' + agentId)
    }
    transitionAgent(agentId, 'startup_verifying')
    return projectAgentState(agentId)
  })
}

export function setAgentSAConfigurationStatus(`],
  ['    if (record.status !== expectedStatus) {', "    if (record.status !== expectedStatus && !(preparing === false && record.status === 'startup_verifying')) {"],
]);
patch('src/services/webRelay/WebRelayProvider.ts', [
  ["import { listAgents } from './orchestration/MultiAgentRunner.js'", "import { listAgents, setAgentStartupVerificationStatus } from './orchestration/MultiAgentRunner.js'"],
  ['  return performStartupHandshake({', '  await setAgentStartupVerificationStatus(agent.agentId)\n  return performStartupHandshake({'],
]);
patch('src/services/webUI/workspace.html', [
  ["mcp_ready:'busy', sa_preparing:'busy',", "mcp_ready:'busy', sa_preparing:'busy', startup_verifying:'busy',"],
  ["const statusLabels = { sa_preparing:'Preparando SA' }", "const statusLabels = { sa_preparing:'Preparando SA', startup_verifying:'Verificando instrucciones iniciales' }"],
]);
patch('src/services/webUI/workspace-canvas.html', [
  ["const statusLabel = data.status==='sa_preparing'?'Preparando SA':(data.status||'?')", "const statusLabel = data.status==='startup_verifying'?'Verificando instrucciones iniciales':data.status==='sa_preparing'?'Preparando SA':(data.status||'?')"],
]);
for (const change of changes) {
  if (fs.readFileSync(change.file, 'utf8') !== change.original) throw new Error('Concurrent file change; no writes performed');
}
for (const change of changes) fs.writeFileSync(change.file, change.content, 'utf8');
console.log('Updated startup verification phase in ' + changes.length + ' files. Validation pending.');
