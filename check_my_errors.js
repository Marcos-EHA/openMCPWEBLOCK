const fs = require('fs')
const t = fs.readFileSync('tsc_check2.txt', 'utf8')
const lines = t.split('\n').filter(l => 
  l.includes('collaboration') || 
  l.includes('Collaboration') || 
  l.includes('SentinelCurator') || 
  l.includes('CollaborationSurface') ||
  l.includes('REPL.tsx') && l.includes('error')
)
if (lines.length === 0) {
  console.log('ZERO ERRORS in new files')
} else {
  console.log('ERRORS FOUND:')
  console.log(lines.join('\n'))
}
// Also count total errors
const errorCount = (t.match(/error TS/g) || []).length
console.log('Total pre-existing errors:', errorCount)