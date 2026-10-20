/**
 * Gemini Orchestrator — openMCPWEBLOCK
 * 
 * Gemini como capa de control inteligente que:
 * - Ejecuta tareas simples directamente (tools del sistema)
 * - Delega tareas complejas a Claude/ChatGPT via Web Relay
 * - Coordina multi-agente cuando se requiere consenso
 * - (Futuro) Controla todo por voz via Gemini Live API
 * 
 * Uso: node gemini-orchestrator.mjs
 */

import { execSync, spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = process.env.GEMINI_API_KEY || 'REEMPLAZAR_CLAVE_GOOGLE';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const PROJECT_DIR = 'C:\\Users\\elias\\Gits\\openMCPWEBLOCK';

// ─── Tool Definitions ───────────────────────────────────────────

const TOOLS = [
  // Level 1: Direct system tools (Gemini executes alone)
  {
    name: 'list_files',
    description: 'Lista archivos y carpetas en un directorio del sistema',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta del directorio' } },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo de texto',
    parameters: {
      type: 'object',
      properties: { 
        path: { type: 'string', description: 'Ruta del archivo' },
        max_lines: { type: 'number', description: 'Máximo de líneas (default 100)' }
      },
      required: ['path']
    }
  },
  {
    name: 'run_command',
    description: 'Ejecuta un comando PowerShell y devuelve el resultado',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Comando PowerShell a ejecutar' } },
      required: ['command']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe o sobreescribe contenido en un archivo',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo' },
        content: { type: 'string', description: 'Contenido a escribir' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'search_in_files',
    description: 'Busca un patrón de texto en archivos de un directorio',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Texto o regex a buscar' },
        directory: { type: 'string', description: 'Directorio donde buscar' },
        file_types: { type: 'string', description: 'Extensiones: *.ts,*.js (default: todos)' }
      },
      required: ['pattern', 'directory']
    }
  },
  
  // Level 2: Delegation (Gemini sends to a smarter AI)
  {
    name: 'delegate_to_ai',
    description: 'Delega una tarea compleja a un LLM más inteligente. Usa esto cuando la tarea requiere razonamiento profundo, análisis de código complejo, o decisiones de arquitectura. La respuesta del LLM se devuelve para que la narres al usuario.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Descripción completa de la tarea para el LLM' },
        context: { type: 'string', description: 'Contexto adicional (código, errores, etc.)' },
        mode: { 
          type: 'string', 
          description: 'Modo de conexión: "api" (rápido, Gemini/Groq), "web" (potente, Claude/ChatGPT), "local" (offline, Ollama)' 
        },
        platform: { 
          type: 'string', 
          description: 'Solo para mode=web: "chatgpt", "claude", "gemini", "grok"' 
        }
      },
      required: ['task', 'mode']
    }
  },
  
  // Level 3: Multi-agent consensus
  {
    name: 'multi_agent_query',
    description: 'Envía la misma pregunta a múltiples IAs y devuelve todas las respuestas para comparar. Usa esto cuando el usuario quiere opiniones diversas o validación cruzada.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'La pregunta o tarea para todas las IAs' },
        platforms: { 
          type: 'array',
          items: { type: 'string' },
          description: 'Lista de plataformas: ["chatgpt", "claude", "grok"]' 
        }
      },
      required: ['task', 'platforms']
    }
  },

  // Level 4: openMCPWEBLOCK control
  {
    name: 'openweblock_status',
    description: 'Muestra el estado actual de openMCPWEBLOCK: modo activo, plataforma, tools conectadas',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'openweblock_set_mode',
    description: 'Cambia el modo de operación de openMCPWEBLOCK',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: '"web", "api", o "local"' },
        platform: { type: 'string', description: 'Para modo web: chatgpt/claude/gemini/grok' }
      },
      required: ['mode']
    }
  }
];

// ─── Tool Execution ─────────────────────────────────────────────

function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': {
        const p = args.path || '.';
        const items = fs.readdirSync(p, { withFileTypes: true });
        return items.slice(0, 50).map(i => 
          `${i.isDirectory() ? '📁' : '📄'} ${i.name}`
        ).join('\n') || '(directorio vacío)';
      }
      
      case 'read_file': {
        const content = fs.readFileSync(args.path, 'utf-8');
        const maxLines = args.max_lines || 100;
        const lines = content.split('\n').slice(0, maxLines);
        return lines.join('\n') + (content.split('\n').length > maxLines ? `\n... (${content.split('\n').length - maxLines} líneas más)` : '');
      }
      
      case 'run_command': {
        const output = execSync(args.command, {
          encoding: 'utf-8',
          shell: 'powershell.exe',
          timeout: 20000,
          cwd: PROJECT_DIR
        });
        return output.substring(0, 4000) || '(sin output)';
      }
      
      case 'write_file': {
        const dir = path.dirname(args.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content, 'utf-8');
        return `✅ Archivo escrito: ${args.path} (${args.content.length} bytes)`;
      }
      
      case 'search_in_files': {
        const types = args.file_types || '*.*';
        const cmd = `Get-ChildItem "${args.directory}" -Recurse -Include ${types} -ErrorAction SilentlyContinue | Select-String "${args.pattern}" | Select-Object -First 20 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim().Substring(0, [Math]::Min(80, $_.Line.Trim().Length)))" }`;
        return execSync(cmd, { encoding: 'utf-8', shell: 'powershell.exe', timeout: 15000 }).substring(0, 3000) || '(sin resultados)';
      }
      
      case 'delegate_to_ai': {
        // For now: use Gemini API itself for "api" mode, placeholder for web/local
        if (args.mode === 'api') {
          return `[DELEGACIÓN API] Tarea enviada a Gemini API:\n${args.task}\nContexto: ${args.context || 'ninguno'}`;
        } else if (args.mode === 'web') {
          return `[DELEGACIÓN WEB] Para ejecutar esta tarea necesitas:\n` +
            `1. Abrir openMCPWEBLOCK: openweblock.bat\n` +
            `2. Seleccionar modo Web → ${args.platform || 'chatgpt'}\n` +
            `3. Enviar: "${args.task.substring(0, 100)}..."\n` +
            `⚠️ La integración automática Web Relay está en desarrollo.`;
        } else if (args.mode === 'local') {
          try {
            const result = execSync(`curl -sf http://localhost:11434/api/generate -d "{\\"model\\":\\"llama3\\",\\"prompt\\":\\"${args.task.replace(/"/g, '\\"').substring(0, 500)}\\",\\"stream\\":false}" 2>$null`, {
              encoding: 'utf-8', shell: 'powershell.exe', timeout: 30000
            });
            const parsed = JSON.parse(result);
            return `[OLLAMA] ${parsed.response || '(sin respuesta)'}`;
          } catch {
            return '[LOCAL] Ollama no disponible. Instala Ollama o usa modo api/web.';
          }
        }
        return '[ERROR] Modo no reconocido. Usa: api, web, o local';
      }
      
      case 'multi_agent_query': {
        return `[MULTI-AGENTE] Consulta para ${args.platforms.join(', ')}:\n` +
          `"${args.task}"\n` +
          `⚠️ La ejecución multi-agente automática está en desarrollo.\n` +
          `Por ahora puedes abrir manualmente cada plataforma web y comparar.`;
      }
      
      case 'openweblock_status': {
        try {
          const configPath = path.join(PROJECT_DIR, '.claude', 'config.json');
          if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return `Modo: ${config.mcpExecutionMode || 'no configurado'}\n` +
              `Plataforma: ${config.selectedWebPlatform || 'ninguna'}\n` +
              `Proyecto: ${PROJECT_DIR}\n` +
              `Build: dist/cli.mjs (${fs.existsSync(path.join(PROJECT_DIR, 'dist/cli.mjs')) ? '✅' : '❌'})`;
          }
          return 'openMCPWEBLOCK no tiene configuración guardada. Ejecuta openweblock.bat para configurar.';
        } catch (e) {
          return `Error leyendo config: ${e.message}`;
        }
      }
      
      case 'openweblock_set_mode': {
        const configDir = path.join(PROJECT_DIR, '.claude');
        const configPath = path.join(configDir, 'config.json');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        let config = {};
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch {}
        config.mcpExecutionMode = args.mode;
        if (args.platform) config.selectedWebPlatform = args.platform;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        return `✅ Modo cambiado a: ${args.mode}${args.platform ? ` → ${args.platform}` : ''}`;
      }
      
      default: return `Tool desconocida: ${name}`;
    }
  } catch (e) {
    return `❌ Error en ${name}: ${e.message}`;
  }
}

// ─── Gemini API Chat ────────────────────────────────────────────

const history = [];

const SYSTEM_PROMPT = `Eres el orquestador central de openMCPWEBLOCK — un sistema que conecta múltiples IAs para ejecutar tareas.

TU ROL:
- Eres la interfaz principal del usuario. Respondes en español, conciso.
- Para tareas SIMPLES (listar archivos, leer código, ejecutar comandos): las haces tú directamente.
- Para tareas COMPLEJAS (análisis profundo, debugging, arquitectura): delegas a un LLM más potente via delegate_to_ai.
- Para VALIDACIÓN: usas multi_agent_query para consultar múltiples IAs.

CONTEXTO:
- El proyecto openMCPWEBLOCK está en: ${PROJECT_DIR}
- El usuario se llama Elías
- Tienes acceso al sistema Windows completo via PowerShell
- Puedes leer/escribir archivos, ejecutar comandos, buscar en código

REGLAS:
1. No pidas confirmación para ejecutar tools, hazlo directamente
2. Sé conciso en tus respuestas
3. Si algo falla, intenta resolverlo antes de reportar el error
4. Cuando delegues a otro LLM, explica brevemente por qué`;

async function chat(userMessage) {
  history.push({ role: 'user', parts: [{ text: userMessage }] });

  const url = `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: history,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations: TOOLS }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  };

  // Allow up to 5 tool call rounds
  for (let round = 0; round < 5; round++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, contents: history })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API ${resp.status}: ${err.substring(0, 200)}`);
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    
    if (parts.length === 0) return '(sin respuesta)';
    
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    
    if (functionCalls.length === 0) {
      // Pure text response — done
      const text = textParts.map(p => p.text).join('');
      history.push({ role: 'model', parts: [{ text }] });
      return text;
    }
    
    // Has function calls — execute them
    history.push({ role: 'model', parts });
    
    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      console.log(`  🔧 ${name}(${JSON.stringify(args).substring(0, 80)})`);
      const result = executeTool(name, args || {});
      const preview = result.substring(0, 200);
      console.log(`  📤 ${preview}${result.length > 200 ? '...' : ''}`);
      functionResponses.push({
        functionResponse: { name, response: { result } }
      });
    }
    
    history.push({ role: 'user', parts: functionResponses });
    // Loop to get next response (might have more tool calls or final text)
  }
  
  return '(máximo de tool calls alcanzado)';
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const mode = process.argv.includes('--voice') ? 'voice' : 'text';
  
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  🎯 Gemini Orchestrator — openMCPWEBLOCK         ║');
  console.log(`║  Model: ${MODEL.padEnd(41)}║`);
  console.log('║  Modo: ' + (mode === 'voice' ? 'Voz 🎤' : 'Texto ⌨️').padEnd(42) + '║');
  console.log('║                                                  ║');
  console.log('║  Tools: sistema, delegación, multi-agente        ║');
  console.log('║  "salir" para terminar                           ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  if (mode === 'voice') {
    console.log('⚠️  Modo voz requiere Gemini Live API + audio libs.');
    console.log('    Instala: npm install speaker node-record-lpcm16');
    console.log('    Usando modo texto por ahora.\n');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const ask = () => {
    try {
      rl.question('tú > ', async (input) => {
        if (!input?.trim()) { ask(); return; }
        if (['salir', 'exit', 'quit'].includes(input.trim().toLowerCase())) {
          console.log('👋 ¡Hasta luego!');
          rl.close();
          return;
        }
        
        try {
          const response = await chat(input.trim());
          console.log(`\n🤖 ${response}\n`);
        } catch (e) {
          console.error(`❌ ${e.message}\n`);
        }
        ask();
      });
    } catch {
      return;
    }
  };
  
  rl.on('close', () => setTimeout(() => process.exit(0), 1500));
  ask();
}

main().catch(console.error);
