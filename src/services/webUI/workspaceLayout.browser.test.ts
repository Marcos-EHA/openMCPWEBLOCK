import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

let browser: Browser
let server: ReturnType<typeof Bun.serve>
const base = import.meta.dir

beforeAll(async () => {
  const executablePath = [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].find(path => path && existsSync(path))
  if (!executablePath) throw new Error('Chrome unavailable for isolated Workspace DOM tests.')
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/workspaceLayout.js') return new Response(readFileSync(join(base,'workspaceLayout.js')), {headers:{'content-type':'application/javascript'}})
    // Use the real markup/styles. Transport and agent dispatch remain disabled.
    const file = url.searchParams.get('view') === 'canvas' ? 'workspace-canvas.html' : 'workspace.html'
    const html = readFileSync(join(base,file),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
    return new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}})
  }})
  browser = await puppeteer.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-sync','--no-first-run']})
},30000)
afterAll(async()=>{await browser?.close();await server?.stop(true)})

async function open(canvas=false): Promise<Page> {
  const page=await browser.newPage()
  await page.setViewport({width:1440,height:1000})
  await page.goto(`http://127.0.0.1:${server.port}/${canvas?'?view=canvas':''}`)
  await page.evaluate(()=>localStorage.clear())
  await page.addScriptTag({url:`http://127.0.0.1:${server.port}/workspaceLayout.js`})
  return page
}

describe('Workspace presentation without live agents',()=>{
  for(const canvas of [false,true]) {
    it(`keeps the active view visible and controls connected (${canvas?'canvas page':'main page'})`,async()=>{
      const page=await open(canvas)
      try {
        const result=await page.evaluate(()=>{
          const root=document.getElementById('view-classic')||document.getElementById('main')!
          const other=document.getElementById('view-canvas')
          return {display:getComputedStyle(root).display,otherHidden:!other||getComputedStyle(other).display==='none',prompt:!!document.getElementById('prompt'),panels:document.querySelectorAll('.wl-component').length}
        })
        expect(result.display).toBe('grid')
        expect(result.otherHidden).toBe(true)
        expect(result.prompt).toBe(true)
        expect(result.panels).toBeGreaterThan(5)
      }finally{await page.close()}
    })
  }
  it('preserves instant view switching',async()=>{
    const page=await open()
    try{
      const result=await page.evaluate(()=>{
        document.getElementById('view-classic')!.style.display='none'
        document.getElementById('view-canvas')!.style.display='flex'
        return {classic:getComputedStyle(document.getElementById('view-classic')!).display,canvas:getComputedStyle(document.getElementById('view-canvas')!).display}
      })
      expect(result).toEqual({classic:'none',canvas:'grid'})
    }finally{await page.close()}
  })
  it('hides and restores a panel without invoking its original action',async()=>{
    const page=await open(true)
    try{
      const result=await page.evaluate(()=>{
        const node=document.getElementById('p-sentinel')!
        let actions=0
        const original=document.createElement('button');original.textContent='Original';original.onclick=()=>actions++
        node.appendChild(original)
        const wrapper=node.closest<HTMLElement>('.wl-component')!
        Array.from(wrapper.querySelectorAll<HTMLButtonElement>('.wl-controls button')).find(button=>button.textContent==='Ocultar')!.click()
        const hidden=wrapper.hidden
        ;(window as any).workspaceLayout.openComponents()
        const label=Array.from(document.querySelectorAll<HTMLLabelElement>('.wl-picker label')).find(item=>item.textContent?.startsWith('Sentinel'))!
        label.querySelector<HTMLInputElement>('input')!.click()
        original.click()
        return {hidden,restored:!wrapper.hidden,actions,same:document.getElementById('p-sentinel')===node}
      })
      expect(result).toEqual({hidden:true,restored:true,actions:1,same:true})
    }finally{await page.close()}
  })
  it('keeps a new agent panel addressable and removes its wrapper when retired',async()=>{
    const page=await open(true)
    try{
      await page.evaluate(()=>document.getElementById('instances')!.insertAdjacentHTML('beforeend','<div class="panel" id="p-fixture"><div class="panel-header"><span class="panel-name">Fixture agent</span></div><div class="panel-body"></div></div>'))
      await page.waitForFunction(()=>!!document.getElementById('p-fixture')?.closest('.wl-component'))
      const count=await page.evaluate(()=>{const node=document.getElementById('p-fixture')!;node.querySelector('.panel-body')!.textContent='Live update';return node.closest('.wl-component')!.textContent!.includes('Live update')})
      expect(count).toBe(true)
      await page.evaluate(()=>document.getElementById('p-fixture')!.remove())
      await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.wl-component')).some(node=>node.getAttribute('aria-label')==='Fixture agent'))
    }finally{await page.close()}
  })
  it('persists size and visibility across reloads and restores defaults',async()=>{
    const page=await open(true)
    try{
      await page.evaluate(()=>{
        const wrapper=document.getElementById('canvas-panel')!.closest('.wl-component')!
        const select=wrapper.querySelector<HTMLSelectElement>('select')!;select.value='compact';select.dispatchEvent(new Event('change'))
        Array.from(wrapper.querySelectorAll<HTMLButtonElement>('.wl-controls button')).find(button=>button.textContent==='Ocultar')!.click()
      })
      await page.reload()
      await page.addScriptTag({url:`http://127.0.0.1:${server.port}/workspaceLayout.js`})
      expect(await page.evaluate(()=>{const wrapper=document.getElementById('canvas-panel')!.closest<HTMLElement>('.wl-component')!;return {hidden:wrapper.hidden,size:wrapper.dataset.size}})).toEqual({hidden:true,size:'compact'})
      await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.wl-toolbar button')).find(button=>button.textContent==='Restaurar distribución')!.click())
      expect(await page.evaluate(()=>document.getElementById('canvas-panel')!.closest<HTMLElement>('.wl-component')!.hidden)).toBe(true)
      expect(await page.evaluate(()=>document.getElementById('shared')!.closest<HTMLElement>('.wl-component')!.hidden)).toBe(false)
    }finally{await page.close()}
  })
  it('moves components with arrows and restores their order and height after reload',async()=>{
    const page=await open(true)
    try{
      const expected=await page.evaluate(()=>{
        ;(window as any).workspaceLayout.preset('work')
        const node=document.getElementById('canvas-panel')!.closest<HTMLElement>('.wl-component')!
        const before=node.getBoundingClientRect().top
        node.querySelector<HTMLButtonElement>('[aria-label="Mover después: Lienzo"]')!.click()
        node.style.height='420px';node.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))
        return {order:node.style.order,height:node.style.height,before,after:node.getBoundingClientRect().top}
      })
      expect(expected.after).toBeGreaterThan(expected.before)
      await page.reload()
      await page.addScriptTag({url:`http://127.0.0.1:${server.port}/workspaceLayout.js`})
      expect(await page.evaluate(()=>{const node=document.getElementById('canvas-panel')!.closest<HTMLElement>('.wl-component')!;return {order:node.style.order,height:node.style.height}})).toEqual({order:expected.order,height:'420px'})
    }finally{await page.close()}
  })
  it('keeps the component guide accessible on a narrow viewport',async()=>{
    const page=await open(true)
    try{
      await page.setViewport({width:390,height:844})
      await page.evaluate(()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.wl-toolbar button')).find(button=>button.textContent==='Cómo funciona')!.click())
      const result=await page.evaluate(()=>{const guide=Array.from(document.querySelectorAll<HTMLElement>('.wl-component')).find(node=>node.getAttribute('aria-label')==='Guía del Workspace')!;const box=guide.getBoundingClientRect();return {visible:!guide.hidden,width:box.width,viewport:innerWidth,text:guide.textContent?.includes('Sistema y Sentinel')}})
      expect(result.visible).toBe(true);expect(result.width).toBeLessThanOrEqual(result.viewport);expect(result.text).toBe(true)
    }finally{await page.close()}
  })
})
