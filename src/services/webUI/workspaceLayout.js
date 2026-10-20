/* Shared presentation controls. Never dispatches tasks or changes agent lifecycle. */
(() => {
  'use strict';
  if (window.workspaceLayout) return;
  const key = 'openmcp-workspace-layout-v1';
  let saved = {};
  let storageAvailable = true;
  try { saved = JSON.parse(localStorage.getItem(key) || '{}'); } catch { storageAvailable = false; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  let currentPreset = saved.__preset === 'work' ? 'work' : 'conversation';
  const entries = new Map();
  const groups = new Map();
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action, label) => {
    const node = el('button', text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', action);
    return node;
  };
  const style = el('style');
  style.textContent = `
    .wl-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 16px;background:#111b2c;border-bottom:1px solid #30435c;font-size:12px}
    .wl-toolbar button,.wl-controls button,.wl-controls select,.wl-picker button{font:inherit;color:#dbe7f5;background:#20334d;border:1px solid #405978;border-radius:5px;padding:4px 8px;cursor:pointer}
    .wl-toolbar button:focus-visible,.wl-controls button:focus-visible,.wl-controls select:focus-visible{outline:2px solid #64d7ff;outline-offset:2px}
    .wl-toolbar [role=status]{color:#a9bdd4;font-size:11px}
    .wl-root{display:grid!important;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px;padding:12px;overflow:auto!important;align-content:start;min-height:0;flex:1}
    .wl-through{display:contents!important}
    .wl-component{grid-column:span 6;min-width:0;min-height:150px;max-width:none!important;max-height:80vh;display:flex;flex-direction:column;border:1px solid #314761;border-radius:8px;background:#121e30;overflow:auto;resize:vertical;height:320px;flex:none!important}
    .wl-component[data-size=wide]{grid-column:span 12}
    .wl-component[data-size=compact]{grid-column:span 4}
    .wl-component[hidden]{display:none!important}
    .wl-controls{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid #314761;background:#1a2b42;font-size:11px;flex-shrink:0}
    .wl-controls strong{margin-right:auto;font-size:12px}
    .wl-controls .wl-grip{cursor:grab}
    .wl-component>.wl-content{flex:1!important;min-height:0;overflow:auto;max-width:none!important;width:auto!important;margin:0!important;border:0!important}
    .wl-component>.panel{min-width:0!important;max-width:none!important;flex:1!important}
    .wl-help{padding:9px 12px;color:#c2d2e5;font-size:12px;line-height:1.5;border-bottom:1px solid #314761}
    .wl-help[hidden]{display:none}
    .wl-picker{width:min(700px,calc(100vw - 32px));max-height:85vh;margin:auto;padding:20px;background:#132137;color:#dfebf7;border:1px solid #496481;border-radius:12px;overflow:auto}
    .wl-picker::backdrop{background:#0009}
    .wl-picker h2{font-size:18px;margin-bottom:8px}
    .wl-picker p{line-height:1.5;margin:8px 0;color:#bacde1;font-size:13px}
    .wl-picker label{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-size:13px}
    .wl-picker small{display:block;color:#a9bdd4;line-height:1.4;margin-top:4px}
    .wl-guide{padding:14px;font-size:13px;line-height:1.6;color:#c5d5e8}
    .wl-guide h3{font-size:14px;color:#e7f1ff;margin:10px 0 5px}
    .wl-guide p{margin:6px 0}
    #header{flex-wrap:wrap;gap:8px}#inputbar{flex-wrap:wrap}#inputbar #prompt{min-width:180px}
    @media(max-width:760px){.wl-component,.wl-component[data-size=compact]{grid-column:span 12}.wl-root{padding:8px;gap:8px}.wl-toolbar{padding:8px}}
  `;
  document.head.appendChild(style);
  const toolbar = el('nav', undefined, 'wl-toolbar');
  toolbar.setAttribute('aria-label', 'Organización del Workspace');
  const status = el('span');
  status.setAttribute('role', 'status');
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(saved)); storageAvailable = true; }
    catch { storageAvailable = false; }
    status.textContent = storageAvailable ? 'Distribución guardada en este navegador.' : 'Distribución temporal: no se pudo guardar en este navegador.';
  }
  function remember(entry) {
    saved[entry.id] = { hidden: entry.wrapper.hidden, size: entry.wrapper.dataset.size, order: Number(entry.wrapper.style.order) || 0, height: entry.wrapper.style.height || '' };
    persist();
  }
  function move(entry, delta) {
    const siblings = [...entries.values()].filter(item => item.group === entry.group && item.wrapper.isConnected && !item.wrapper.hidden)
      .sort((a,b) => Number(a.wrapper.style.order)-Number(b.wrapper.style.order));
    const index = siblings.indexOf(entry);
    const other = siblings[index + delta];
    if (!other) return;
    [siblings[index], siblings[index+delta]] = [other,entry];
    siblings.forEach((item,i) => { item.wrapper.style.order = String(i); saved[item.id] = {...saved[item.id], order:i}; });
    persist();
    status.textContent = entry.title + ' movido. La actividad continúa.';
  }
  function apply(entry, state) {
    const value = state && typeof state === 'object' ? state : {};
    entry.wrapper.hidden = typeof value.hidden === 'boolean' ? value.hidden : currentPreset === 'conversation' ? !entry.id.endsWith('-conversation') : entry.id.endsWith('-guide');
    entry.wrapper.dataset.size = ['wide','compact','normal'].includes(value.size) ? value.size : entry.defaultSize;
    entry.size.value = entry.wrapper.dataset.size;
    entry.wrapper.style.order = String(Number.isFinite(value.order) ? value.order : entry.defaultOrder);
    entry.wrapper.style.height = typeof value.height === 'string' && /^\d+(\.\d+)?px$/.test(value.height) ? value.height : '';
  }
  function register(node, id, title, description, group, defaultSize = 'normal') {
    if (!node || entries.has(id)) return;
    const wrapper = el('section', undefined, 'wl-component');
    wrapper.setAttribute('aria-label', title);
    const controls = el('div', undefined, 'wl-controls');
    controls.appendChild(el('strong', title));
    const help = el('div', description, 'wl-help');
    help.hidden = true;
    const explain = button('¿Qué hace?', () => { help.hidden = !help.hidden; explain.setAttribute('aria-expanded', String(!help.hidden)); });
    explain.setAttribute('aria-expanded','false');
    const size = el('select');
    size.setAttribute('aria-label', 'Ancho de ' + title);
    for (const [value,label] of [['compact','Compacto'],['normal','Medio'],['wide','Amplio']]) {
      const option = el('option',label); option.value=value; size.appendChild(option);
    }
    const entry = { id,title,description,node,wrapper,size,group,defaultSize,defaultOrder: entries.size };
    const grip = el('span','⠿','wl-grip');
    grip.draggable = true;
    grip.tabIndex = 0;
    grip.setAttribute('aria-label','Arrastrar '+title+'; también puedes usar las flechas');
    grip.title='Arrastrar para cambiar de posición en esta vista';
    grip.addEventListener('dragstart',event=>{event.dataTransfer.setData('application/x-workspace-component',id);event.dataTransfer.effectAllowed='move';});
    controls.prepend(grip);
    wrapper.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('application/x-workspace-component')) event.preventDefault();});
    wrapper.addEventListener('drop',event=>{
      const source=entries.get(event.dataTransfer.getData('application/x-workspace-component'));
      if(!source||source===entry||source.group!==entry.group) return;
      event.preventDefault();event.stopPropagation();
      const items=[...entries.values()].filter(item=>item.group===group&&item.wrapper.isConnected).sort((a,b)=>Number(a.wrapper.style.order)-Number(b.wrapper.style.order));
      items.splice(items.indexOf(source),1);items.splice(items.indexOf(entry),0,source);
      items.forEach((item,index)=>{item.wrapper.style.order=String(index);saved[item.id]={...saved[item.id],order:index};});
      persist();
    });
    size.addEventListener('change', () => { wrapper.dataset.size=size.value; remember(entry); });
    controls.append(explain,button('←',()=>move(entry,-1),'Mover antes: '+title),button('→',()=>move(entry,1),'Mover después: '+title),size,button('Ocultar',()=>{wrapper.hidden=true;remember(entry);},'Ocultar '+title+' sin detener su actividad'));
    node.before(wrapper);
    node.classList.add('wl-content');
    wrapper.append(controls,help,node);
    entries.set(id,entry);
    apply(entry,saved[id]);
    wrapper.addEventListener('pointerup',()=>{ if(wrapper.style.height) remember(entry); });
    wrapper.addEventListener('pointercancel',()=>{ if(wrapper.style.height) remember(entry); });
  }
  function arrangeRoot(root, group) {
    if (!root) return;
    root.classList.add('wl-root');
    groups.set(group,root);
  }
  const guideText = [
    ['Empieza por una conversación','Selecciona un destino en la barra inferior. Puedes dirigirte al pool web, a una instancia preparada o a una IDE conectada. Escribe y envía una petición; observa su respuesta en Conversación.'],
    ['Qué significa cada destino','Pool web utiliza la coordinación configurada o un envío directo. Un Relay o una Master seleccionados reciben la petición directamente. Colaboración IDE envía la misma tarea a las IDEs seleccionadas; no implica por sí sola una síntesis automática.'],
    ['Organiza tu espacio','Arrastra desde el asa o usa las flechas para cambiar el orden dentro de la vista, el selector para ajustar el ancho y el borde inferior para cambiar la altura. Ocultar conserva la actividad; Componentes permite recuperar apartados. La distribución se guarda en este navegador.'],
    ['Sistema y Sentinel','El sistema informa de conexiones, asignaciones y resultados. Sentinel ofrece supervisión técnica y, cuando está autorizado, sugerencias con Gemini. Una sugerencia no confirma que se haya ejecutado una reparación.'],
    ['Tareas y pendientes','Tareas IDE muestra asignaciones y entregas recientes del proceso. El gestor de pendientes persistentes aún está por implementar: esta vista no garantiza conservar objetivos al reiniciar.'],
    ['Cómo se relacionan los componentes','La petición sale del destino elegido hacia una IDE, Master o pool web. Los eventos actualizan participantes, conversación y actividad. El lienzo muestra los aportes que recibe del sistema de colaboración; la integración de todas las rutas sigue en revisión.'],
    ['Estado de esta versión','La guía describe el funcionamiento revisado en código. Continúa pendiente validar el recorrido completo con instancias reales y corregir indicadores heredados del curador. La referencia de desarrollo es docs/WORKSPACE.md.']
  ];
  const dual = !!document.getElementById('view-classic');
  const roots = dual ? [['classic',document.getElementById('view-classic')],['canvas',document.getElementById('view-canvas')]] : [['canvas',document.getElementById('main')]];
  for (const [group,root] of roots) {
    arrangeRoot(root,group);
    if (!root) continue;
    const shared = document.getElementById(dual ? group+'-shared' : 'shared');
    const instances = document.getElementById(dual ? group+'-instances' : 'instances');
    if (group === 'canvas') {
      for (const id of dual ? ['canvas-main','canvas-right'] : ['right-area']) document.getElementById(id)?.classList.add('wl-through');
      register(document.getElementById('canvas-panel'),'canvas-findings','Lienzo','Reúne hallazgos, solicitudes y problemas publicados mediante la colaboración. No representa automáticamente toda la conversación.',group);
    }
    register(shared,group+'-conversation','Conversación','Muestra mensajes y resultados recibidos. El destino de tus próximas peticiones se elige en la barra de envío.',group,'wide');
    if (instances) {
      instances.classList.add('wl-through');
      const scan = () => {
        for (const node of [...instances.children]) {
          if (!node.classList.contains('panel') || !node.id) continue;
          const name = node.querySelector('.panel-name')?.textContent || node.id;
          register(node,node.id,name,'Actividad de este participante. Ocultar este panel no cierra su instancia. Los controles originales de cerrar o reiniciar sí actúan sobre ella.',group);
        }
        for (const [id,entry] of entries) {
          if (entry.group===group && entry.node.classList.contains('panel') && !entry.wrapper.contains(entry.node)) {
            entry.wrapper.remove(); entries.delete(id);
          }
        }
      };
      scan();
      new MutationObserver(scan).observe(instances,{childList:true,subtree:true});
    }
    const guide = el('article',undefined,'wl-guide');
    for (const [title,text] of guideText) guide.append(el('h3',title),el('p',text));
    root.appendChild(guide);
    register(guide,group+'-guide','Guía del Workspace','Explica qué hace cada componente, cómo se relaciona con los demás y qué funciones siguen pendientes.',group,'wide');
    if (!saved[group+'-guide']) entries.get(group+'-guide').wrapper.hidden=true;
  }
  // CSS must preserve the existing view switcher's display:none behavior.
  style.textContent += '\n#view-classic[style*="display: none"],#view-canvas[style*="display: none"]{display:none!important}\n';
  if (dual && document.getElementById('view-canvas').style.display !== 'flex') document.getElementById('view-canvas').style.display='none';
  const auxiliary = el('div',undefined,'wl-root');
  auxiliary.style.flex='0 1 auto';
  auxiliary.style.maxHeight='35vh';
  const input = document.getElementById('inputbar');
  if (input) input.before(auxiliary);
  groups.set('shared',auxiliary);
  for (const [id,title,description] of [
    ['instance-roster','Instancias','Muestra Relays y Masters registrados y sus controles. La disponibilidad depende de su estado real.'],
    ['workspace-task-board','Tareas IDE','Asignaciones recientes a IDEs y sus respuestas. Se conservan en memoria del proceso; no son todavía pendientes persistentes.'],
    ['workspace-roster','Participantes IDE','Permite seleccionar IDEs conectadas como destino individual o de colaboración.'],
    ['workspace-alerts','Alertas de lanzamiento','Avisos retenidos del proceso sobre problemas al preparar instancias. No es un historial permanente.']
  ]) {
    const node=document.getElementById(id);
    if (node && auxiliary.isConnected) { auxiliary.appendChild(node); register(node,id,title,description,'shared','wide'); }
  }
  const dialog=el('dialog',undefined,'wl-picker');
  const heading=el('h2','Componentes del Workspace');
  const list=el('div');
  dialog.append(heading,el('p','Muestra solo lo que necesitas. Ocultar no detiene tareas ni cierra instancias.'),list,button('Cerrar',()=>dialog.close()));
  document.body.appendChild(dialog);
  function activeGroup() { return dual && document.getElementById('view-canvas').style.display==='none' ? 'classic' : 'canvas'; }
  function picker() {
    list.replaceChildren();
    for(const entry of entries.values()) {
      if(entry.group!=='shared' && entry.group!==activeGroup()) continue;
      const label=el('label'); const check=el('input'); check.type='checkbox'; check.checked=!entry.wrapper.hidden;
      const copy=el('span',entry.title); copy.appendChild(el('small',entry.description));
      check.addEventListener('change',()=>{entry.wrapper.hidden=!check.checked;remember(entry);});
      label.append(check,copy);list.appendChild(label);
    }
    dialog.showModal();
  }
  function preset(mode) {
    currentPreset=mode;
    saved.__preset=mode;
    const group=activeGroup();
    for(const entry of entries.values()) {
      if(entry.group!==group && entry.group!=='shared') continue;
      entry.wrapper.hidden=mode==='conversation' ? entry.id!==group+'-conversation' : entry.id.endsWith('-guide');
      if(entry.id===group+'-conversation') {entry.wrapper.dataset.size='wide';entry.size.value='wide';}
      remember(entry);
    }
  }
  toolbar.append(button('Componentes',picker),button('Conversación',()=>preset('conversation')),button('Trabajo',()=>preset('work')),button('Cómo funciona',()=>{
    const entry=entries.get(activeGroup()+'-guide');
    if(entry){entry.wrapper.hidden=false;remember(entry);entry.wrapper.scrollIntoView({block:'nearest'});}
  }),button('Restaurar distribución',()=>{
    saved={};
    currentPreset='conversation';
    for(const entry of entries.values()) {apply(entry,{});if(entry.id.endsWith('-guide')) entry.wrapper.hidden=true;}
    persist();
  }),status);
  document.getElementById('header')?.after(toolbar);
  status.textContent=storageAvailable?'Elige un destino y escribe. En Componentes puedes mostrar los demás apartados.':'La distribución no se está guardando.';
  window.workspaceLayout={openComponents:picker,preset};
})();
