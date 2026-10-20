import { describe, expect, test } from 'bun:test';
import { generateClaudeInstructionsJson, generateInstructionsJson } from './instructionGeneratorJson';
import claudeDedicatedPrompt from './claudeDedicatedPrompt.txt?raw';

const tools = [{
  name: 'shell.execute_command',
  description: 'Runs a shell command.',
  schema: JSON.stringify({
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  }),
}];

describe('instructionGeneratorJson', () => {
  test('returns the exact user-provided Claude prompt verbatim', () => {
    const prompt = generateClaudeInstructionsJson();

    expect(prompt).toBe(claudeDedicatedPrompt);
    expect(prompt).toStartWith('Hola. Uso una extensión llamada SuperAssistant');
    expect(prompt).toContain('Yo reviso y ejecuto cada acción que me');
    expect(prompt).toContain('espera a que te pegue el resultado.');
    expect(prompt).toContain('EJEMPLO DEL FORMATO (pegado por mí, no por ti)');
    expect(prompt).toContain('[AQUÍ PEGO LAS 4 LÍNEAS DEL EJEMPLO ORIGINAL, con ListDir como herramienta]:');
    expect(prompt.replace(/\r\n/g, '\n')).toContain(
      'escribe cada evento como\nun objeto JSON independiente dentro del bloque jsonl:',
    );
    expect(prompt).toContain('usa type function_call_start e incluye name');
    expect(prompt).toContain('usa type function_call_end con el mismo call_id del inicio.');
    expect(prompt.trimEnd()).toEndWith('Inicio de la interacción con el usuario:');
    expect(prompt).not.toContain('[mi primera tarea]');
    expect(prompt).not.toContain('Primera tarea: quiero saber qué hay en la carpeta actual.');
  });

  test('keeps the Updated JSONL prompt separate from the Claude prompt', () => {
    const updatedPrompt = generateInstructionsJson(tools);
    const claudePrompt = generateClaudeInstructionsJson();

    expect(updatedPrompt).toContain('[SuperAssistant Operational Instructions]');
    expect(updatedPrompt).toContain('Emit one standalone JSON object per line');
    expect(updatedPrompt).toContain('use type to identify function_call_start');
    expect(updatedPrompt).toContain('key for the exact argument name');
    expect(updatedPrompt).toContain('Never use event instead of type');
    expect(updatedPrompt).not.toContain('TOOL_NAME');
    expect(updatedPrompt).not.toContain('UNIQUE_CALL_ID');
    expect(updatedPrompt).not.toContain('parameter_name');
    expect(updatedPrompt).not.toContain('[Integración Claude web + SuperAssistant]');
    expect(claudePrompt).toContain('Todas las demás herramientas y funciones están desactivadas');
  });
});
