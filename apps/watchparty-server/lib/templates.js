import fs from 'fs';
import path from 'path';

// Simple cached HTML template loader with {{TOKEN}} replacement.
// Keeps explicit & tiny per project principles.
const cache = new Map();
const templateDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'templates');

function loadRaw(name){
  if (cache.has(name)) return cache.get(name);
  const file = path.join(templateDir, name);
  let raw = '';
  try { raw = fs.readFileSync(file,'utf8'); } catch { raw = ''; }
  cache.set(name, raw);
  return raw;
}

export function renderTemplate(name, replacements){
  let html = loadRaw(name);
  if (!html) return '';
  if (replacements && typeof replacements === 'object'){
    for (const [k,v] of Object.entries(replacements)){
      const token = new RegExp('\\{\\{'+k+'\\}\\}','g');
      html = html.replace(token, String(v));
    }
  }
  return html;
}

export default { renderTemplate };