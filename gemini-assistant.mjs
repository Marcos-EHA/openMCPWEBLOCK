/**
 * Gemini Assistant — openMCPWEBLOCK
 * 
 * Dos modos:
 * 1. TEXTO: Usa Gemini API normal (chat completions) con tool calling
 * 2. VOZ: Usa Gemini Live API con WebSocket + audio (futuro)
 * 
 * Uso: node gemini-assistant.mjs [--voice]
 */

import { execSync } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';

const API_KEY = process.env.GEMINI_API_KEY || 'REEMPLAZAR_CLAVE_GOOGLE';
const MODEL = 'gemini-3.5-flash';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Tools
const TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'Lista archivos y carpetas en un directorio',
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
      properties: { path: { type: 'string', description: 'Ruta del archivo' } },
      required: ['path']
    }
  },
  {
    name: 'run_command',
    description: 'Ejecuta un comando PowerShell y devuelve el resultado',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Comando PowerShell' } },
      required: ['command']
    }
  },
  {
    name: 'write_file',
    description: 'Escribe contenido a un archivo',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo' },
        content: { type: 'string', description: 'Contenido a escribir' }
      },
      required: ['path', 'content']
    }
  }
];

function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': {
        const items = fs.readdirSync(args.path || '.', { withFileTypes: true });
        return items.slice(0, 50).map(i => `${i.isDirectory() ? '📁' : '📄'} ${i.name}`).join('\n');
      }
      case 'read_file': {
        return fs.readFileSync(args.path, 'utf-8').substring(0, 3000);
      }
      case 'run_command': {
        return execSync(args.command, { encoding: 'utf-8', shell: 'powershell.exe', timeout: 15000 }).substring(0, 3000);
      }
      case 'write_file': {
        fs.writeFileSync(args.path, args.content, 'utf-8');
        return `✅ Archivo escrito: ${args.path}`;
      }
      default: return `Tool desconocida: ${name}`;
    }
  } catch (e) {
    return `❌ Error: ${e.message}`;
  }
}

// Conversation history
const history = [];
const SYSTEM_PROMPT = `Eres un asistente inteligente de openMCPWEBLOCK. 
Responde en español, conciso y útil.
Tienes acceso a herramientas para interactuar con el sistema Windows del usuario.
El proyecto principal está en C:\\Users\\elias\\Gits\\openMCPWEBLOCK.
Cuando necesites información del sistema, usa las herramientas disponibles.
Si el usuario pide algo que requiere ejecutar comandos, hazlo sin pedir confirmación.`;

async function chat(userMessage) {
  history.push({
    role: 'user',
    parts: [{ text: userMessage }]
  });

  const body = {
    contents: history,
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    tools: [{ functionDeclarations: TOOL_DEFS }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  };

  const url = `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`;
  
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`API Error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const candidate = data.candidates?.[0];
  
  if (!candidate) {
    return '(sin respuesta)';
  }

  const parts = candidate.content?.parts || [];
  
  // Check for function calls
  const functionCalls = parts.filter(p => p.functionCall);
  
  if (functionCalls.length > 0) {
    // Add model response to history
    history.push({ role: 'model', parts });
    
    // Execute each function call
    const functionResponses = [];
    for (const part of functionCalls) {
      const { name, args } = part.functionCall;
      console.log(`  🔧 ${name}(${JSON.stringify(args).substring(0, 80)})`);
      const result = executeTool(name, args);
      console.log(`  📤 ${result.substring(0, 150)}${result.length > 150 ? '...' : ''}`);
      functionResponses.push({
        functionResponse: { name, response: { result } }
      });
    }
    
    // Send results back and get final response
    history.push({ role: 'user', parts: functionResponses });
    
    const resp2 = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, contents: history })
    });
    
    const data2 = await resp2.json();
    const parts2 = data2.candidates?.[0]?.content?.parts || [];
    
    // Check for more function calls (recursive)
    const moreCalls = parts2.filter(p => p.functionCall);
    if (moreCalls.length > 0) {
      history.push({ role: 'model', parts: parts2 });
      const moreResponses = [];
      for (const part of moreCalls) {
        const { name, args } = part.functionCall;
        console.log(`  🔧 ${name}(${JSON.stringify(args).substring(0, 80)})`);
        const result = executeTool(name, args);
        console.log(`  📤 ${result.substring(0, 150)}${result.length > 150 ? '...' : ''}`);
        moreResponses.push({ functionResponse: { name, response: { result } } });
      }
      history.push({ role: 'user', parts: moreResponses });
      const resp3 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, contents: history })
      });
      const data3 = await resp3.json();
      const text3 = data3.candidates?.[0]?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '';
      history.push({ role: 'model', parts: [{ text: text3 }] });
      return text3;
    }
    
    const text2 = parts2.filter(p => p.text).map(p => p.text).join('') || '';
    history.push({ role: 'model', parts: [{ text: text2 }] });
    return text2;
  }
  
  // Text response only
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  history.push({ role: 'model', parts: [{ text }] });
  return text;
}

// Main loop
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Gemini Assistant - openMCPWEBLOCK             ║');
  console.log(`║  Model: ${MODEL.padEnd(39)}║`);
  console.log('║  Escribe o habla (modo voz: --voice)          ║');
  console.log('║  "salir" para terminar                        ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');

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
    } catch (e) {
      // readline closed (piped input ended)
      return;
    }
  };
  
  rl.on('close', () => {
    // Graceful exit when stdin ends
    setTimeout(() => process.exit(0), 2000);
  });
  
  ask();
}

main().catch(console.error);
