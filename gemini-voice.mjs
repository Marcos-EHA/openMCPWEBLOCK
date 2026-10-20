/**
 * Gemini Voice Assistant — openMCPWEBLOCK
 * Conecta a Gemini Live API via WebSocket para conversación por voz/texto.
 * Soporta tool calls para ejecutar comandos en tu sistema.
 * 
 * Uso: node gemini-voice.mjs
 */

import WebSocket from 'ws';
import { execSync } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

const API_KEY = process.env.GEMINI_API_KEY || 'REEMPLAZAR_CLAVE_GOOGLE';
const MODEL = 'gemini-3.1-flash-live-preview';
const WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;

// Tools available to Gemini
const TOOLS = [
  {
    name: 'list_files',
    description: 'List files in a directory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    description: 'Read contents of a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' }
      },
      required: ['path']
    }
  },
  {
    name: 'run_command',
    description: 'Execute a PowerShell command and return output',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to execute' }
      },
      required: ['command']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for information',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  }
];

// Execute tool calls
function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': {
        const dirPath = args.path || '.';
        const items = fs.readdirSync(dirPath, { withFileTypes: true });
        return items.map(i => `${i.isDirectory() ? '📁' : '📄'} ${i.name}`).join('\n');
      }
      case 'read_file': {
        const content = fs.readFileSync(args.path, 'utf-8');
        return content.substring(0, 2000); // Limit output
      }
      case 'run_command': {
        const output = execSync(args.command, { 
          encoding: 'utf-8', 
          shell: 'powershell.exe',
          timeout: 15000 
        });
        return output.substring(0, 2000);
      }
      case 'web_search': {
        return `[Search "${args.query}" - requires browser integration]`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// Main
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  Gemini Voice Assistant - openMCPWEBLOCK       ║');
  console.log('║  Model: ' + MODEL.padEnd(39) + '║');
  console.log('║  Habla por micrófono o escribe texto          ║');
  console.log('║  Ctrl+C para salir                            ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');

  console.log('🔌 Conectando a Gemini Live API...');
  
  const ws = new WebSocket(WS_URL);
  let sessionReady = false;
  let keepAliveInterval;
  
  ws.on('open', () => {
    console.log('✅ Conectado. Enviando configuración...');
    
    // Setup message with tools
    const setup = {
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Aoede'
              }
            }
          },
          temperature: 0.7,
        },
        systemInstruction: {
          parts: [{
            text: `Eres un asistente de voz para openMCPWEBLOCK. 
            Responde en español, de forma concisa y útil.
            Tienes acceso a herramientas para interactuar con el sistema del usuario.
            El directorio principal del proyecto es C:\\Users\\elias\\Gits\\openMCPWEBLOCK.
            Puedes listar archivos, leer archivos, y ejecutar comandos PowerShell.
            Cuando el usuario pida algo que requiera acceso al sistema, usa las herramientas.`
          }]
        },
        tools: [{
          functionDeclarations: TOOLS
        }]
      }
    };
    
    ws.send(JSON.stringify(setup));
    
    // Keep-alive ping every 15 seconds
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Setup complete
      if (msg.setupComplete) {
        sessionReady = true;
        console.log('🎤 Sesión activa. Escribe tu mensaje:');
        console.log('');
        promptUser();
        return;
      }

      // Server content (response)
      if (msg.serverContent) {
        const parts = msg.serverContent.modelTurn?.parts || [];
        
        for (const part of parts) {
          // Text response
          if (part.text) {
            process.stdout.write(`\n🤖 ${part.text}\n\n`);
          }
          
          // Function call
          if (part.functionCall) {
            const { name, args } = part.functionCall;
            console.log(`\n🔧 Ejecutando: ${name}(${JSON.stringify(args)})`);
            
            const result = executeTool(name, args);
            console.log(`📤 Resultado: ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`);
            
            // Send tool result back
            const toolResponse = {
              toolResponse: {
                functionResponses: [{
                  response: { output: result },
                  id: part.functionCall.id || name,
                  name: name,
                }]
              }
            };
            ws.send(JSON.stringify(toolResponse));
          }
        }
        
        // Turn complete — prompt for next input
        if (msg.serverContent.turnComplete) {
          promptUser();
        }
      }
    } catch (e) {
      // Binary audio data or parse error — ignore for now
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(keepAliveInterval);
    console.log(`\n🔌 Desconectado (${code}): ${reason || 'sesión terminada'}`);
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('❌ Error:', err.message);
  });

  // User input
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  function promptUser() {
    rl.question('> ', (input) => {
      if (!input || !input.trim()) {
        promptUser();
        return;
      }
      
      if (input.trim().toLowerCase() === 'salir' || input.trim().toLowerCase() === 'exit') {
        ws.close();
        rl.close();
        return;
      }
      
      if (!sessionReady || ws.readyState !== WebSocket.OPEN) {
        console.log('⏳ Esperando conexión...');
        promptUser();
        return;
      }
      
      // Send text message
      const clientMsg = {
        clientContent: {
          turns: [{
            role: 'user',
            parts: [{ text: input.trim() }]
          }],
          turnComplete: true
        }
      };
      
      ws.send(JSON.stringify(clientMsg));
    });
  }
}

main().catch(console.error);
