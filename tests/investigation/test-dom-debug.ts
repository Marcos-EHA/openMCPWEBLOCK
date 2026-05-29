import { CDPConnection } from './src/services/webRelay/ChromeCDP.ts'
async function go() {
  const cdp = new CDPConnection()
  await cdp.connect()
  const r = await cdp.evaluate(`
    (function() {
      var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      var result = [];
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var md = m.querySelector('.markdown, .prose');
        result.push({
          index: i,
          hasMarkdown: !!md,
          innerTextLen: m.innerText.length,
          innerTextPreview: m.innerText.substring(0, 150),
          childCount: m.children.length,
          firstChildTag: m.children[0] ? m.children[0].tagName : 'none',
        });
      }
      return JSON.stringify(result, null, 2);
    })()
  `)
  console.log(r)
  cdp.close()
  process.exit(0)
}
go().catch(e => { console.error(e); process.exit(1) })
