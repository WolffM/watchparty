import fs from 'fs';
import path from 'path';
import episodeKeyFromName from './episode.js';

// Resolve helper for safe media path (pure logic; depends only on provided mediaRoot & rel)
export function resolveMedia(mediaRoot, rel){
  if (typeof rel !== 'string') return null;
  const norm = rel.replace(/\\/g,'/').replace(/^\/+/, '');
  // Accept optional 'output/' prefix (frontend grouping may present relative to media/output root)
  const normStripped = norm.startsWith('output/') ? norm.slice('output/'.length) : norm;
  const abs = path.join(mediaRoot, normStripped);
  // Robust traversal guard (case-insensitive on Windows). Use relative() instead of startsWith to avoid drive letter case issues.
  try {
    const relToRoot = path.relative(mediaRoot, abs);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null; // outside root
  } catch { return null; }
  const lower = abs.replace(/\\/g,'/').toLowerCase();
  if (lower.endsWith('.wp.mp4') || lower.endsWith('.webm')) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { rel: normStripped, abs, kind:'file' };
  }
  // Allow selecting a chunk manifest directly (chunk-only episode where full .wp.mp4 was removed)
  if (lower.endsWith('.wp.chunks/manifest.json')) {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { rel: normStripped, abs, kind:'manifest' };
  }
  return null;
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
  const manifests = [];
  (function walk(dir, rel){
    let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const e of entries){
      const abs=path.join(dir,e.name);
      const r = rel? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs,r); else {
        const low = e.name.toLowerCase();
        if (low.endsWith('.wp.mp4') || low.endsWith('.webm')) all.push(r.replace(/\\/g,'/'));
        else if (low === 'manifest.json' && r.toLowerCase().endsWith('.wp.chunks/manifest.json')) manifests.push(r.replace(/\\/g,'/'));
      }
    }
  })(mediaRoot,'');
  // Add manifests that do NOT have a sibling .wp.mp4 (chunk-only)
  for (const m of manifests){
    const baseDir = m.slice(0, -'/manifest.json'.length);
    // Derive presumed full file name from directory: remove trailing .wp.chunks
    const maybeBase = baseDir.replace(/\.wp\.chunks$/,'');
    // See if any full file already listed referencing this base
    const hasFull = all.some(f=> f.replace(/\.(wp\.mp4|webm)$/i,'') === maybeBase.split('/').pop());
    if (!hasFull) all.push(m); // include manifest path as selectable
  }
  const groups = new Map();
  for (const rel of all){
    const file = rel.split(/[\\/]/).pop();
    let baseName = file;
    if (file === 'manifest.json' && rel.toLowerCase().endsWith('.wp.chunks/manifest.json')) {
      // Use parent dir (strip .wp.chunks) as base
      const parent = rel.split('/').slice(-2, -1)[0] || '';
      baseName = parent.replace(/\.wp\.chunks$/,'');
    }
    const k = episodeKeyFromName(baseName) || baseName.replace(/\.(wp\.mp4|webm)$/i,'');
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
    let base = name.replace(/\.(wp\.mp4|webm)$/i,'');
    if (name === 'manifest.json' && rel.toLowerCase().endsWith('.wp.chunks/manifest.json')) {
      const parent = rel.split('/').slice(-2, -1)[0];
      base = parent.replace(/\.wp\.chunks$/,'');
    }
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
