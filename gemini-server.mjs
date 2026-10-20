/**
 * openMCPWEBLOCK Voice v2
 * 
 * Browser SpeechRecognition (STT) + Gemini API (brain) + Browser SpeechSynthesis (TTS)
 * Todo en español. Sin modelos locales. Sin GPU. Sin descargas.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9400;
const PROJECT_DIR = path.resolve(__dirname);
const API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`;

// ─── Tool executor ──────────────────────────────────────────────
function executeTool(name, args) {
  try {
    switch (name) {
      case 'list_files': {
        const dir = args.path || PROJECT_DIR;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        return items.slice(0, 50).map(i => `${i.isDirectory() ? '📁' : '📄'} ${i.name}`).join('\n');
      }
      case 'read_file':
        return fs.readFileSync(args.path, 'utf-8').substring(0, 4000);
      case 'write_file': {
        const dir = path.dirname(args.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(args.path, args.content, 'utf-8');
        return `Escrito: ${args.path}`;
      }
      case 'run_command':
        return execSync(args.command, {
          encoding: 'utf-8', shell: 'powershell.exe', timeout: 20000, cwd: PROJECT_DIR
        }).substring(0, 4000);
      case 'search_code': {
        const dir = args.directory || path.join(PROJECT_DIR, 'src');
        const cmd = `Get-ChildItem "${dir}" -Recurse -Include *.ts,*.tsx,*.js -ErrorAction SilentlyContinue | Select-String "${args.pattern}" | Select-Object -First 15 | ForEach-Object { "$($_.Filename):$($_.LineNumber): $($_.Line.Trim().Substring(0, [Math]::Min(80, $_.Line.Trim().Length)))" }`;
        return execSync(cmd, { encoding: 'utf-8', shell: 'powershell.exe', timeout: 15000 }).substring(0, 3000);
      }
      case 'status': {
        const parts = [`Proyecto: ${PROJECT_DIR}`];
        const pkgPath = path.join(PROJECT_DIR, 'package.json');
        if (fs.existsSync(pkgPath)) { const p = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); parts.push(`${p.name} v${p.version}`); }
        parts.push(fs.existsSync(path.join(PROJECT_DIR, 'dist', 'cli.mjs')) ? 'Compilado' : 'No compilado');
        return parts.join('\n');
      }
      default:
        return `Tool desconocida: ${name}`;
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ─── Gemini Chat with Tools ─────────────────────────────────────
const TOOLS = [
  { type: 'function', function: { name: 'list_files', description: 'Lista archivos y carpetas en un directorio', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta del directorio. Por defecto: openMCPWEBLOCK' } } } } },
  { type: 'function', function: { name: 'read_file', description: 'Lee el contenido de un archivo', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta absoluta del archivo' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Escribe contenido en un archivo', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Ruta del archivo' }, content: { type: 'string', description: 'Contenido' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Ejecuta un comando PowerShell en Windows', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Comando a ejecutar' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search_code', description: 'Busca texto en archivos de código', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Texto a buscar' }, directory: { type: 'string', description: 'Directorio' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'status', description: 'Estado del proyecto openMCPWEBLOCK', parameters: { type: 'object', properties: {} } } },
];

const SYSTEM_MSG = {
  role: 'system',
  content: `Eres el asistente de voz de openMCPWEBLOCK. Hablas SIEMPRE en español. Eres conciso y directo.
El usuario se llama Elías. El proyecto está en C:\\Users\\elias\\Gits\\openMCPWEBLOCK.
Cuando te pidan hacer algo con archivos o el sistema, usa las herramientas. Ejecuta sin pedir confirmación.
Tus respuestas serán LEÍDAS EN VOZ ALTA, así que:
- Sé breve (1-3 oraciones máximo)
- No uses markdown, código, URLs ni rutas completas — nombra las cosas de forma natural
- No hagas listas con viñetas — habla en prosa
- Si muestras resultados de código/archivos, resúmelos en palabras`
};

async function chatWithGemini(messages) {
  const body = {
    model: 'gemini-3.5-flash',
    messages: [SYSTEM_MSG, ...messages],
    tools: TOOLS,
  };

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Sin respuesta de Gemini');

  // Tool call handling
  if (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls) {
    const toolCalls = choice.message.tool_calls;
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    for (const tc of toolCalls) {
      const args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      const result = executeTool(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }

    // Recursive call to get final response after tool execution
    return chatWithGemini(messages);
  }

  return choice.message?.content || 'Sin respuesta';
}

// ─── HTTP Server ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { messages } = JSON.parse(body);
        const reply = await chatWithGemini(messages);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  🎯 openMCPWEBLOCK Voice v2`);
  console.log(`  📡 http://localhost:${PORT}`);
  console.log(`  🗣️  Browser STT/TTS (español nativo)`);
  console.log(`  🧠 Gemini 3.5 Flash (rápido)\n`);
});

// ─── HTML ───────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>openMCPWEBLOCK Voice</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0a0a0f;color:#d0d0d0;height:100vh;display:flex;flex-direction:column}
#top{padding:12px 20px;background:#0d1117;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px}
#top h1{font-size:1em;color:#7dd3fc;font-weight:600}
#top .tag{font-size:.7em;padding:2px 8px;border-radius:8px;background:#1a3a2a;color:#4ade80}
#bar{padding:6px 20px;font-size:.8em;color:#888;background:#0d0d12;border-bottom:1px solid #1a1a25}
#log{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}
.m{max-width:85%;padding:10px 14px;border-radius:12px;line-height:1.5;font-size:.9em;word-wrap:break-word}
.m.u{align-self:flex-end;background:#1c3a5a;color:#93c5fd;border-bottom-right-radius:4px}
.m.a{align-self:flex-start;background:#14191f;border:1px solid #252d38;border-bottom-left-radius:4px}
.m.s{align-self:center;color:#555;font-size:.75em;font-style:italic}
.m.thinking{align-self:flex-start;color:#f59e0b;font-size:.8em;font-style:italic}
#bot{padding:14px 20px;background:#0d1117;border-top:1px solid #21262d;display:flex;gap:10px;align-items:center}
#mic{width:52px;height:52px;border-radius:50%;border:2px solid #2563eb33;background:radial-gradient(circle at 35% 35%,#1e3a5f,#0a1628);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;user-select:none;transition:.3s}
#mic.on{background:radial-gradient(circle at 35% 35%,#7f1d1d,#450a0a);border-color:#dc262680;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 8px #dc262640}50%{box-shadow:0 0 24px #dc262680}}
#inp{flex:1;padding:10px 14px;border-radius:8px;border:1px solid #21262d;background:#0d1117;color:#d0d0d0;font-size:.9em;outline:none}
#inp:focus{border-color:#2563eb}
#send{padding:8px 16px;border-radius:8px;border:none;background:#2563eb;color:white;cursor:pointer;font-size:.9em}
#send:hover{background:#3b82f6}
</style>
</head>
<body>
<div id="top"><h1>🎯 openMCPWEBLOCK</h1><span class="tag">VOZ ACTIVA</span></div>
<div id="bar" id="status">Listo — habla o escribe</div>
<div id="log"></div>
<div id="bot">
  <div id="mic" title="Clic para hablar">🎤</div>
  <input id="inp" placeholder="Escribe algo..." autocomplete="off"/>
  <button id="send">Enviar</button>
</div>
<script>
const log=document.getElementById('log'),mic=document.getElementById('mic'),inp=document.getElementById('inp'),bar=document.getElementById('bar'),send=document.getElementById('send');
let listening=false, speaking=false, recognition=null;
const history=[];

// ── Messages ────────────────────────────────────────────────────
function addMsg(t,cls){
  const d=document.createElement('div');d.className='m '+cls;d.textContent=t;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d;
}

// ── TTS — Browser SpeechSynthesis (español) ─────────────────────
function speak(text, onDone){
  speaking=true;
  bar.textContent='🔊 Hablando...';
  const u=new SpeechSynthesisUtterance(text);
  u.lang='es-ES';
  u.rate=1.1;
  // Prefer a Spanish voice
  const voices=speechSynthesis.getVoices();
  const esVoice=voices.find(v=>v.lang.startsWith('es')&&v.localService)||voices.find(v=>v.lang.startsWith('es'));
  if(esVoice)u.voice=esVoice;
  u.onend=()=>{speaking=false;bar.textContent='🎤 Listo';if(onDone)onDone();};
  u.onerror=()=>{speaking=false;bar.textContent='🎤 Listo';};
  speechSynthesis.speak(u);
}

// ── Chat with server ────────────────────────────────────────────
async function chat(text){
  if(!text.trim())return;
  addMsg(text,'u');
  history.push({role:'user',content:text});
  bar.textContent='🤔 Pensando...';
  const thinkMsg=addMsg('Pensando...','thinking');
  try{
    const resp=await fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:history.slice(-20)})
    });
    const data=await resp.json();
    thinkMsg.remove();
    if(data.error){addMsg('Error: '+data.error,'s');bar.textContent='❌ Error';return;}
    const reply=data.reply;
    history.push({role:'assistant',content:reply});
    addMsg(reply,'a');
    speak(reply);
  }catch(e){
    thinkMsg.remove();
    addMsg('Error de conexión: '+e.message,'s');
    bar.textContent='❌ Error';
  }
}

// ── STT — Browser SpeechRecognition (español) ───────────────────
function initSTT(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){addMsg('Tu navegador no soporta reconocimiento de voz','s');return;}
  recognition=new SR();
  recognition.lang='es-ES';
  recognition.continuous=false;
  recognition.interimResults=true;
  let interim=null;
  recognition.onstart=()=>{listening=true;mic.classList.add('on');bar.textContent='🎤 Escuchando...';};
  recognition.onresult=(e)=>{
    let final='',interimText='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      if(e.results[i].isFinal)final+=e.results[i][0].transcript;
      else interimText+=e.results[i][0].transcript;
    }
    if(interimText&&!interim){interim=addMsg(interimText,'u');interim.style.opacity='0.5';}
    else if(interimText&&interim){interim.textContent=interimText;}
    if(final){
      if(interim){interim.remove();interim=null;}
      chat(final.trim());
    }
  };
  recognition.onend=()=>{listening=false;mic.classList.remove('on');if(!speaking)bar.textContent='🎤 Listo';};
  recognition.onerror=(e)=>{listening=false;mic.classList.remove('on');if(e.error!=='no-speech')bar.textContent='Error: '+e.error;};
}

// ── Controls ────────────────────────────────────────────────────
mic.addEventListener('click',()=>{
  if(!recognition)initSTT();
  if(listening){recognition.stop();}
  else{speechSynthesis.cancel();recognition.start();}
});

send.addEventListener('click',()=>{if(inp.value.trim()){chat(inp.value.trim());inp.value='';}});
inp.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&inp.value.trim()){chat(inp.value.trim());inp.value='';}});

// Load voices
speechSynthesis.onvoiceschanged=()=>speechSynthesis.getVoices();
initSTT();
</script>
</body>
</html>`;
