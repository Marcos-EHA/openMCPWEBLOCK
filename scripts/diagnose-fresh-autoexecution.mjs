import puppeteer from 'puppeteer-core';
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9405' });
try {
  const target = browser.targets().find(item => item.type() === 'page' && item.url().startsWith('https://chatgpt.com/'));
  if (!target) throw new Error('No ChatGPT page found on the selected diagnostic port.');
  const client = await target.createCDPSession();
  const contexts = new Map();
  client.on('Runtime.executionContextCreated', ({context}) => contexts.set(context.id, context));
  await client.send('Runtime.enable');
  const expression = `(() => {
    const selectors = ['[data-message-author-role="user"]','[data-testid="user-message"]','[data-test-id="user-query"]','[data-author="user"]','[data-turn-role="User"]','[aria-label="Your message"]','[data-role="user"]','#prompt-textarea','#mobile-composer-prompt','.ProseMirror[contenteditable="true"]','textarea','button[data-testid="send-button"]','button[data-testid="fruitjuice-send-button"]','[data-message-author-role="assistant"]'];
    const counts = Object.fromEntries(selectors.map(selector => [selector, document.querySelectorAll(selector).length]));
    const editor = document.querySelector('#prompt-textarea, #mobile-composer-prompt, .ProseMirror[contenteditable="true"], textarea');
    const source = Array.from(document.querySelectorAll('pre,code')).filter(node => !node.closest('.function-block') && (node.textContent || '').includes('function_call_start')).at(-1);
    const ancestors = [];
    let node = source;
    for(let i=0; node && i<7; i++,node=node.parentElement) ancestors.push({tag:node.tagName,role:node.getAttribute('data-message-author-role'),testId:node.getAttribute('data-testid'),dataRole:node.getAttribute('data-role')});
    const automation = window.__mcpAutomationState;
    const describe = element => ({tag:element.tagName,classes:Array.from(element.classList).slice(0,10),attrs:Object.fromEntries(Array.from(element.attributes).filter(a=>/^(data-testid|data-message-id|data-turn-id|data-role|data-author|role|aria-roledescription)$/.test(a.name)).map(a=>[a.name,a.value]))});
    const structure=[];
    node=source;
    for(let i=0;node&&i<14;i++,node=node.parentElement) structure.push({...describe(node),children:node.children.length,previous:node.previousElementSibling?describe(node.previousElementSibling):null});
    const composerRoot=editor?.closest('form')||editor?.parentElement?.parentElement;
    const buttons=composerRoot?Array.from(composerRoot.querySelectorAll('button')).map(button=>({testId:button.getAttribute('data-testid'),label:button.getAttribute('aria-label'),title:button.getAttribute('title'),type:button.getAttribute('type'),disabled:button.disabled})):[];
    const roleHeadings=Array.from(document.querySelectorAll('h3,h4,h5,h6')).filter(element=>element.classList.contains('sr-only')).slice(-10).map(element=>{const label=(element.textContent||'').trim();const role=/^(you|you said|tú|tú dijiste|dijiste|usuario)\s*:?$/i.test(label)?'user':/^(chatgpt|chatgpt said|chatgpt dijo|assistant|asistente)\s*:?$/i.test(label)?'assistant':'unrecognized';let parent=element.parentElement;const parents=[];for(let i=0;parent&&i<4;i++,parent=parent.parentElement) parents.push({...describe(parent),attributeNames:Array.from(parent.attributes).map(a=>a.name),children:parent.children.length});return {role,heading:describe(element),parents};});
    const cards=Array.from(document.querySelectorAll('.function-block')).slice(-4).map(card=>{const css=getComputedStyle(card);const rect=card.getBoundingClientRect();return {classes:Array.from(card.classList),width:Math.round(rect.width),height:Math.round(rect.height),whiteSpace:css.whiteSpace,maxHeight:css.maxHeight,overflow:css.overflow,parent:describe(card.parentElement),parentWhiteSpace:getComputedStyle(card.parentElement).whiteSpace,children:Array.from(card.children).slice(0,8).map(child=>({tag:child.tagName,classes:Array.from(child.classList),height:Math.round(child.getBoundingClientRect().height),whiteSpace:getComputedStyle(child).whiteSpace}))};});
    return {roleHeadings,cards,buttons};
  })()`;
  for(const context of contexts.values()) {
    if (!context.auxData?.isDefault && context.origin !== 'chrome-extension://aklgcdphknfhpmhdplmkgmjemojchcea') continue;
    const result = await client.send('Runtime.evaluate',{contextId:context.id,expression,returnByValue:true});
    console.log(JSON.stringify({context:context.auxData?.isDefault?'page':'extension',data:result.result.value,error:result.exceptionDetails?.text},null,2));
  }
  await client.detach();
} finally { await browser.disconnect(); }
