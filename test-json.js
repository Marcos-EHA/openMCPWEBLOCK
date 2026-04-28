const fs = require('fs');
const path = require('path');

try {
  const filePath = path.resolve(__dirname, '../learning-system/modelo-strategy.json');
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);
  console.log('JSON válido. Modelo fallback:', parsed.configuracion_automatica?.fallback_model);
} catch(e) {
  console.log('Error de JSON:', e.message);
  console.log('Posición:', e.message.match(/position (\d+)/)?.[1]);
}