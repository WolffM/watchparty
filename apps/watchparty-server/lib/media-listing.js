import fs from 'fs';
import path from 'path';
import episodeKeyFromName from './episode.js';

// Resolve helper for safe media path (pure logic; depends only on provided mediaRoot & rel)
export function resolveMedia(mediaRoot, rel){
  if (typeof rel !== 'string') return null;
  const norm = rel.replace(/\\/g,'/').replace(/^\/+/, '');
  const abs = path.join(mediaRoot, norm);
  if (!abs.startsWith(mediaRoot)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const lower = abs.toLowerCase();
  if (!(lower.endsWith('.wp.mp4') || lower.endsWith('.webm'))) return null;
  return { rel: norm, abs };
}

// Find first playable file under mediaRoot (pref *.wp.mp4 then .webm)
export function findFirst(mediaRoot){
  function walk(dir){
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes:true }); } catch { return null; }
    for (const e of entries){
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const f = walk(full); if (f) return f; }
      else if (e.name.toLowerCase().endsWith('.wp.mp4')) return full;
    }
    for (const e of entries){
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const f = walk(full); if (f) return f; }
      else if (e.name.toLowerCase().endsWith('.webm')) return full;
    }
    return null;
  }
  return walk(mediaRoot);
}

// List media with episode grouping
export function listMedia(mediaRoot){
  const all=[];
  (function walk(dir, rel){
    let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const e of entries){
      const abs=path.join(dir,e.name);
      const r = rel? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs,r); else {
        const low = e.name.toLowerCase();
        if (low.endsWith('.wp.mp4') || low.endsWith('.webm')) all.push(r.replace(/\\/g,'/'));
      }
    }
  })(mediaRoot,'');
  const groups = new Map();
  for (const rel of all){
    const file = rel.split(/[\\/]/).pop();
    const k = episodeKeyFromName(file) || file.replace(/\.(wp\.mp4|webm)$/i,'');
    const key = k.toUpperCase();
    let g = groups.get(key); if(!g){ g={ chosen:null, candidates:[] }; groups.set(key,g); }
    g.candidates.push(rel);
  }
  for (const g of groups.values()){
    const sorted = [...g.candidates].sort((a,b)=>{
      const an = a.split(/[\\/]/).pop();
      const bn = b.split(/[\\/]/).pop();
      const aBracket = an.startsWith('[')?1:0; const bBracket = bn.startsWith('[')?1:0;
      if (aBracket !== bBracket) return aBracket - bBracket;
      if (an.length !== bn.length) return bn.length - an.length;
      return a.localeCompare(b);
    });
    g.chosen = sorted[0];
  }
  function sortKey(rel){
    const name = rel.split(/[\\/]/).pop();
    const base = name.replace(/\.(wp\.mp4|webm)$/i,'');
    const m = base.match(/s(\d{1,2})e(\d{1,3})/i); if (m){ return { s: Number(m[1]), e: Number(m[2]), raw: base }; }
    const m2 = base.match(/e(\d{2,3})/i); if (m2){ return { s:0, e:Number(m2[1]), raw: base }; }
    return { s:0, e:9999, raw: base };
  }
  const chosen = [...groups.values()].map(g=>g.chosen).filter(Boolean);
  chosen.sort((a,b)=>{
    const ka = sortKey(a); const kb = sortKey(b);
    if (ka.s !== kb.s) return ka.s - kb.s;
    if (ka.e !== kb.e) return ka.e - kb.e;
    return ka.raw.localeCompare(kb.raw);
  });
  return chosen;
}

export default { resolveMedia, findFirst, listMedia };
