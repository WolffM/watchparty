import fs from 'fs';
import path from 'path';
import episodeKeyFromName from './episode.js';

// Discover and select a subtitle file for a given media file & optional wanted language.
// Returns { status:number, headers:object, body?:string }
export function buildSubtitleResponse(mediaFile, wantLangRaw){
  if (!mediaFile) return { status: 404 };
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base);
  const epKey = (episodeKeyFromName(prefix) || '').toLowerCase();
  const wantLang = (wantLangRaw||'').trim().toLowerCase();
  let files=[]; try { files = fs.readdirSync(dir); } catch {}
  const candidates=[];
  for (const f of files){
    const low = f.toLowerCase();
    if (!(low.endsWith('.vtt') || low.endsWith('.srt'))) continue;
    const subEp = (episodeKeyFromName(f) || '').toLowerCase();
    const baseMatch = low.startsWith(prefix.toLowerCase() + '.');
    const epMatch = epKey && subEp && subEp === epKey;
    if (!baseMatch && !epMatch) continue;
    const parts = f.split('.');
    if (parts.length < 3) continue;
    const ext = parts.pop();
    const langGuess = parts[parts.length-1].toLowerCase();
    candidates.push({ file:f, low, ext: ext.toLowerCase(), lang: langGuess, baseMatch, epMatch });
  }
  function pickFirst(fn){ return candidates.find(fn) || null; }
  let chosen = null;
  if (wantLang) chosen = pickFirst(c=> c.lang===wantLang && c.baseMatch) || pickFirst(c=> c.lang===wantLang);
  if (!chosen) chosen = pickFirst(c=> /^(eng|en)$/i.test(c.lang) && c.baseMatch) || pickFirst(c=> /^(eng|en)$/i.test(c.lang));
  if (!chosen) chosen = pickFirst(c=> c.baseMatch);
  if (!chosen) chosen = candidates[0];
  if (!chosen) return { status:404 };
  const full = path.join(dir, chosen.file);
  const type = chosen.ext === 'srt' ? 'srt':'vtt';
  const headers = { 'X-Subtitle-Source': chosen.file, 'X-Subtitle-Lang': chosen.lang, 'Content-Type': 'text/vtt; charset=utf-8' };
  let raw;
  try { raw = fs.readFileSync(full,'utf8').replace(/\r/g,''); } catch { return { status:404 }; }
  if (type === 'srt') {
    const out=['WEBVTT',''];
    for (const line of raw.split('\n')){
      if (/^\d+$/.test(line.trim())) continue;
      const m=line.match(/^(\d\d:\d\d:\d\d),(\d{3}) --> (\d\d:\d\d:\d\d),(\d{3})(.*)$/);
      if (m) out.push(`${m[1]}.${m[2]} --> ${m[3]}.${m[4]}${m[5]}`); else out.push(line);
    }
    raw = out.join('\n');
  }
  if (!/^WEBVTT/m.test(raw)) raw = 'WEBVTT\n\n'+raw;
  let lines = raw.split('\n');
  let lastCueText=null;
  lines = lines.map(line=>{
    if (/^WEBVTT/.test(line) || /-->/.test(line)) return line;
    line = line.replace(/\{[^}]*\}/g,'');
    line = line.replace(/\[[^\]]*(?:translator|tl note|t\/n|note)[^\]]*\]/ig,'');
    line = line.replace(/\s{2,}/g,' ').trim();
    return line;
  });
  const dedup=[];
  for (const l of lines){
    if (!/-->/.test(l) && l && l===lastCueText) continue;
    if (!/-->/.test(l) && l) lastCueText=l; else if (/-->/.test(l)) lastCueText=null;
    dedup.push(l);
  }
  return { status:200, headers, body: dedup.join('\n') };
}

// Enumerate subtitle tracks for UI
export function enumerateSubtitleTracks(mediaFile){
  if (!mediaFile) return [];
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefixLower = path.basename(base).toLowerCase() + '.';
  const epKey = (episodeKeyFromName(path.basename(base)) || '').toLowerCase();
  let files=[]; try { files = fs.readdirSync(dir); } catch { return []; }
  const tracks=[];
  for (const f of files){
    const low = f.toLowerCase();
    if (!(low.endsWith('.vtt') || low.endsWith('.srt'))) continue;
    const subEpKey = (episodeKeyFromName(f) || '').toLowerCase();
    if (!(low.startsWith(prefixLower) || (epKey && subEpKey && subEpKey === epKey))) continue;
    const parts = f.split('.');
    if (parts.length < 3) continue;
    const ext = parts.pop();
    const lang = parts[parts.length-1];
    const slugParts = parts.slice(1, parts.length-1);
    const label = (lang + (slugParts.length? (' '+slugParts.join('-')):'' )).toLowerCase();
    tracks.push({ file: f, lang, label, ext });
  }
  tracks.sort((a,b)=> a.lang.localeCompare(b.lang));
  return tracks;
}

export default { buildSubtitleResponse, enumerateSubtitleTracks };
