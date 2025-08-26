import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Simple in-memory session state
let mediaFile = null;      // absolute path to current media
let mediaRel = null;       // relative path under media root
let mediaRev = 0;          // incremented when media changes
let lastBroadcast = { t: 0, paused: true, ts: Date.now(), rev: mediaRev, path: mediaRel }; // t seconds into media
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';

// Chat / Presence data structures (character slots in assignment order)
// Assignment order with display names including umlaut: Frieren, Himmel, Heiter, Eisen, Fern, Stark, Sein, Übel
// Internal key uses exact display (with Ü). We'll normalize incoming values.
const COLOR_PALETTE = ['frieren','himmel','heiter','eisen','fern','stark','sein','übel'];
const COLOR_HEX = {
  frieren: '#7f7c84',
  himmel:  '#bddaf9',
  heiter:  '#78855e',
  eisen:   '#cfccc0',
  fern:    '#794983',
  stark:   '#af4a33',
  sein:    '#936f42',
  'übel':  '#667240'
};
let colorsAvailable = [...COLOR_PALETTE];
const clientMeta = new Map(); // socket -> { id, color, lastSeen, msgTimes: number[] }
let nextClientId = 1;
const chatHistory = []; // ring buffer of { type:'chat', id,name,color,text,ts }
const CHAT_HISTORY_LIMIT = 200;
const CHAT_HISTORY_SEND = 100;
const PRESENCE_TIMEOUT_MS = 25000;
const PRESENCE_SWEEP_INTERVAL = 10000;
const CHAT_RATE_MAX = 5; // messages
const CHAT_RATE_WINDOW_MS = 5000; // time window

function assignColor(){ if(colorsAvailable.length) return colorsAvailable.shift(); return null; }
function releaseColor(c){ if(!c) return; if(COLOR_PALETTE.includes(c) && !colorsAvailable.includes(c)) { colorsAvailable.push(c); /* maintain original order */ colorsAvailable = COLOR_PALETTE.filter(col => colorsAvailable.includes(col)); } }
function broadcastPresence(){
  const users = [];
  for (const meta of clientMeta.values()) { users.push({ id: meta.id, name: meta.color ? meta.color : 'anon'+meta.id, color: meta.color }); }
  const payload = JSON.stringify({ type:'presence', users });
  for (const c of wss.clients) { if (c.readyState === 1) c.send(payload); }
}
function pushChat(msg){
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
  const payload = JSON.stringify(msg);
  for (const c of wss.clients) { if (c.readyState === 1) c.send(payload); }
}
function pushSystem(text){
  const now = Date.now();
  const msg = { type:'system', text, ts: now };
  pushChat(msg);
}
function sendSelf(socket, meta){
  try { socket.send(JSON.stringify({ type:'self', id: meta.id, name: meta.color? meta.color: 'anon'+meta.id, color: meta.color })); } catch {}
}
function sendChatHistory(socket){
  const items = chatHistory.slice(-CHAT_HISTORY_SEND);
  socket.send(JSON.stringify({ type:'chat-history', items }));
}

wss.on('close', ()=>{}); // noop placeholder (avoid accidental removal if refactoring)

wss.on('connection', (socket, req) => {
  // Require admin key in query (?admin=KEY) for ALL clients (viewer & admin)
  try {
    const q = new URL(req.url, 'http://x').searchParams;
    const supplied = q.get('admin');
    if (supplied !== ADMIN_KEY && supplied !== 'auto') {
      console.log('[ws] unauthorized connection');
      socket.close(1008, 'unauthorized');
      return;
    }
  } catch {}
  const meta = { id: nextClientId++, color: assignColor(), lastSeen: Date.now(), msgTimes: [] };
  clientMeta.set(socket, meta);
  console.log('[ws] client connected', meta.id, 'color=', meta.color);
  socket.send(JSON.stringify({ type: 'state', data: lastBroadcast }));
  // Send presence + chat history
  sendChatHistory(socket);
  broadcastPresence();
  // System join message (broadcast) & self-only notice
  pushSystem((meta.color? meta.color : ('anon'+meta.id)) + ' joined');
  sendSelf(socket, meta);
  socket.on('close', ()=> console.log('[ws] client closed'));
  socket.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const { type } = msg;
    if (type === 'ping') { socket.send(JSON.stringify({ type:'pong', at: Date.now() })); const m = clientMeta.get(socket); if (m) m.lastSeen = Date.now(); return; }
    if (type === 'chat') {
      const m = clientMeta.get(socket); if(!m) return;
      m.lastSeen = Date.now();
      let text = ''+ (msg.text||'');
      text = text.replace(/\r/g,'').replace(/\n/g,' ').trim();
      if(!text) return;
      if (text.length > 300) text = text.slice(0,300);
      // Rate limit
      const now = Date.now();
      m.msgTimes = m.msgTimes.filter(t => now - t < CHAT_RATE_WINDOW_MS);
      if (m.msgTimes.length >= CHAT_RATE_MAX) { return; }
      m.msgTimes.push(now);
      const name = m.color ? m.color : ('anon'+m.id);
      const out = { type:'chat', id: m.id, name, color: m.color, text, ts: now };
      pushChat(out);
      return;
    }
    if (type === 'rename') {
  let want = (msg.color||'').toLowerCase();
  if (want === 'ubel') want = 'übel';
  if (!COLOR_PALETTE.includes(want)) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'invalid' })); } catch {} return; }
  const m = clientMeta.get(socket); if(!m) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'no-meta' })); } catch {} return; }
      m.lastSeen = Date.now();
  if (m.color === want) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'unchanged' })); } catch {} return; }
  // Check if in use by someone else
  for (const meta2 of clientMeta.values()) { if (meta2 !== m && meta2.color === want) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'in-use' })); } catch {} return; } }
      const oldName = m.color ? m.color : ('anon'+m.id);
      colorsAvailable = colorsAvailable.filter(c=>c!==want); // remove desired from pool if present
      releaseColor(m.color); // put old back into pool
      m.color = want;
      const newName = m.color ? m.color : ('anon'+m.id);
      pushSystem(`${oldName} → ${newName}`);
      broadcastPresence();
      sendSelf(socket, m);
  try { socket.send(JSON.stringify({ type:'rename-result', ok:true, color: want })); } catch {}
      return;
    }
    // Viewer -> Admin lightweight requests (no admin key required)
    if (type === 'request') {
      if (msg.action === 'pause') {
        console.log('[ws] viewer pause request');
        const payload = JSON.stringify({ type:'toast', text:'Pause requested' });
        for (const c of wss.clients) { if (c.readyState === 1) c.send(payload); }
      }
      return;
    }
    if (type === 'load') {
      if (msg.key !== ADMIN_KEY) { console.log('[ws] auth fail load', msg.key); return; }
      const rel = msg.path;
      if (typeof rel !== 'string') return;
      const safe = resolveMedia(rel);
      if (!safe) { console.log('[ws] invalid load path', rel); return; }
      mediaFile = safe.abs; mediaRel = safe.rel; mediaRev++;
      console.log('[ws] load', mediaRel);
      lastBroadcast = { t:0, paused:true, ts:Date.now(), rev: mediaRev, path: mediaRel };
      broadcastState();
      return;
    }
    if (!mediaFile) return; // below commands need media
    if (['play','pause','seek','tick'].includes(type)) {
      if (msg.key !== ADMIN_KEY) { console.log('[ws] auth fail', type, 'supplied=', msg.key); return; }
      const now = Date.now();
      const t = Number(msg.time);
      if (type === 'seek' && isFinite(t) && t >= 0) {
        lastBroadcast = { t, paused: lastBroadcast.paused, ts: now, rev: mediaRev, path: mediaRel };
        console.log('[ws] seek', t.toFixed(3));
      } else if (type === 'play') {
        if (isFinite(t) && t >= 0) lastBroadcast = { t, paused: false, ts: now, rev: mediaRev, path: mediaRel }; else lastBroadcast = { ...lastBroadcast, paused:false, ts: now };
        console.log('[ws] play', isFinite(t)?t.toFixed(3):'?');
      } else if (type === 'pause') {
        if (isFinite(t) && t >= 0) lastBroadcast = { t, paused: true, ts: now, rev: mediaRev, path: mediaRel }; else lastBroadcast = { ...lastBroadcast, paused:true, ts: now };
        console.log('[ws] pause', isFinite(t)?t.toFixed(3):'?');
      } else if (type === 'tick') {
        // Periodic position update while playing OR implicit play detection
        if (isFinite(t) && t >= 0) {
          if (lastBroadcast.paused) {
            if (t > lastBroadcast.t + 0.2) { // treat as implicit play
              lastBroadcast = { t, paused:false, ts: now, rev: mediaRev, path: mediaRel };
              console.log('[ws] implicit play via tick', t.toFixed(3));
            }
          } else if (t > lastBroadcast.t) {
            lastBroadcast = { t, paused:false, ts: now, rev: mediaRev, path: mediaRel };
          }
        }
      }
      broadcastState();
    }
  });
  socket.on('close', ()=>{
    const m = clientMeta.get(socket);
    if (m) { pushSystem((m.color? m.color: ('anon'+m.id)) + ' left'); releaseColor(m.color); clientMeta.delete(socket); broadcastPresence(); }
  });
});

// Optional heartbeat broadcast every 5s to keep idle clients synced
setInterval(()=>{ if (!mediaFile) return; broadcastState(); }, 5000);

// Presence timeout sweeper
setInterval(()=>{
  let changed=false; const now=Date.now();
  for (const [sock, meta] of [...clientMeta.entries()]) {
    if (now - meta.lastSeen > PRESENCE_TIMEOUT_MS) {
      pushSystem((meta.color? meta.color: ('anon'+meta.id)) + ' left');
      releaseColor(meta.color); clientMeta.delete(sock); try { sock.close(4000,'timeout'); } catch {}
      changed=true;
    }
  }
  if (changed) broadcastPresence();
}, PRESENCE_SWEEP_INTERVAL);

function broadcastState(){
  const payload = JSON.stringify({ type:'state', data: lastBroadcast });
  for (const c of wss.clients) { if (c.readyState === 1) c.send(payload); }
}

// Locate first playable file (prefer *.wp.mp4 then .webm) or use MEDIA_FILE env.
const ROOT = process.cwd();
// Only serve system-managed outputs (transcoded + subtitles) from media/output; raw user imports live elsewhere
const mediaRoot = path.join(ROOT, 'media', 'output');
function findFirst() {
  if (process.env.MEDIA_FILE) {
    const p = path.isAbsolute(process.env.MEDIA_FILE) ? process.env.MEDIA_FILE : path.join(mediaRoot, process.env.MEDIA_FILE);
    if (fs.existsSync(p)) return p;
  }
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // first pass *.wp.mp4
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const f = walk(full); if (f) return f; }
      else if (e.name.toLowerCase().endsWith('.wp.mp4')) return full;
    }
    // second pass .webm
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { const f = walk(full); if (f) return f; }
      else if (e.name.toLowerCase().endsWith('.webm')) return full;
    }
    return null;
  }
  return walk(mediaRoot);
}
// Resolve helper for safe media path
function resolveMedia(rel){
  if (typeof rel !== 'string') return null;
  const norm = rel.replace(/\\/g,'/').replace(/^\/+/, '');
  const abs = path.join(mediaRoot, norm);
  if (!abs.startsWith(mediaRoot)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const lower = abs.toLowerCase();
  if (!(lower.endsWith('.wp.mp4') || lower.endsWith('.webm'))) return null;
  return { rel: norm, abs };
}
mediaFile = findFirst();
if (mediaFile) { mediaRel = path.relative(mediaRoot, mediaFile).replace(/\\/g,'/'); lastBroadcast.path = mediaRel; console.log('[media] using', mediaRel); } else { console.log('[media] no playable file found'); }

// Auth gate for index: require ?admin=KEY (or ?admin=auto in non-prod) even for viewer mode
const publicDir = path.join(__dirname, 'public');
function authGate(req, res, next){
  const supplied = req.query.admin;
  if (supplied === ADMIN_KEY || supplied === 'auto') return next();
  const wanted = req.path === '/' ? '/' : req.path;
  res.status(401).send(`<!doctype html><html><head><meta charset=utf-8><title>Locked</title><style>body{font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}form{background:#1e1e1e;padding:24px 28px;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px;min-width:300px}input{padding:8px 10px;border-radius:6px;border:1px solid #333;background:#222;color:#eee;font:14px system-ui}button{all:unset;background:#2962ff;color:#fff;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:600;text-align:center}button:hover{background:#1c4fc1}</style></head><body><form onsubmit="var k=document.getElementById('k').value.trim(); if(k){var extra=location.search.includes('verbose')?'&verbose':''; location.href='${wanted}?admin='+encodeURIComponent(k)+extra;} return false"><h2 style=margin:0;font:18px system-ui>Enter Access Key</h2><p style=margin:0;font:12px system-ui;opacity:.75>Key required to join session.</p><input id=k placeholder="Access key" autofocus autocomplete=off><div style=display:flex;gap:8px><button type=submit style=flex:1>Enter</button></div><p style=margin:4px 0 0;font:11px system-ui;opacity:.55>Provide the key to viewers.</p></form></body></html>`);
}
app.get(['/', '/index.html'], authGate, (req,res)=> res.sendFile(path.join(publicDir,'index.html')));
app.get(['/admin','/admin.html'], authGate, (req,res)=> res.sendFile(path.join(publicDir,'index.html')));
// Static assets (JS/CSS/media fetches) remain open; gate is only entry HTML + websocket + admin actions
app.use(express.static(publicDir));
// Serve character sprite images (read-only)
app.use('/media/sprites', express.static(path.join(ROOT,'media','sprites')));

// Simple range-enabled endpoint
app.get('/media/current.mp4', (req, res) => {
  if (!mediaFile || !fs.existsSync(mediaFile)) { res.status(404).send('No media'); return; }
  let stat; try { stat = fs.statSync(mediaFile); } catch { res.status(404).end(); return; }
  const total = stat.size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mediaFile.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');
  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.status(200).end();
    return fs.createReadStream(mediaFile).pipe(res);
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) { res.status(416).end(); return; }
  let start = m[1] ? parseInt(m[1], 10) : 0; let end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (isNaN(start) || isNaN(end) || start > end || end >= total) { res.status(416).setHeader('Content-Range', `bytes */${total}`).end(); return; }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(mediaFile, { start, end }).pipe(res);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, file: mediaFile ? path.relative(ROOT, mediaFile) : null }));
app.get('/admin-key', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'forbidden' });
  res.json({ key: ADMIN_KEY });
});
// List media files (admin can choose path)
app.get('/api/files', (_req,res) => {
  res.json(listMedia());
});

// Expose character color metadata so frontend doesn't need hardcoded duplicate
app.get('/api/colors', (_req, res) => {
  res.json({ palette: COLOR_PALETTE, hex: COLOR_HEX });
});

// Subtitle helper route (single sidecar: same basename with .vtt or .srt)
app.get('/media/current.vtt', (req, res) => {
  if (!mediaFile) return res.status(404).end();
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base);
  const directVtt = base + '.vtt';
  const directSrt = base + '.srt';
  let chosen=null; let type='vtt'; let langHint=null;
  const wantLang = (req.query.lang||'').toLowerCase().trim();
  // Enumerate variants first so lang is honored even if a base file exists
  let files=[]; try { files = fs.readdirSync(dir); } catch {}
  const lowPrefix = prefix.toLowerCase()+'.';
  const vttCands = files.filter(f=> f.toLowerCase().startsWith(lowPrefix) && f.toLowerCase().endsWith('.vtt'));
  const srtCands = files.filter(f=> f.toLowerCase().startsWith(lowPrefix) && f.toLowerCase().endsWith('.srt'));
  if (wantLang) {
    const matchV = vttCands.find(f=> new RegExp(`\\.${wantLang}(\\.|$)`).test(f.toLowerCase()));
    const matchS = srtCands.find(f=> new RegExp(`\\.${wantLang}(\\.|$)`).test(f.toLowerCase()));
    if (matchV) { chosen = path.join(dir, matchV); type='vtt'; }
    else if (matchS) { chosen = path.join(dir, matchS); type='srt'; }
  }
  function pick(cands){
    if(!cands.length) return null;
    const prefer = cands.find(f=> /\.eng(\.|$)/i.test(f)) || cands.find(f=> /\.en(\.|$)/i.test(f));
    return prefer || cands[0];
  }
  if (!chosen) {
    // If no language requested or not found, prefer base file if present, else variants
    if (fs.existsSync(directVtt)) { chosen = directVtt; type='vtt'; }
    else if (fs.existsSync(directSrt)) { chosen = directSrt; type='srt'; }
    else {
      const pickVtt = pick(vttCands);
      if (pickVtt) { chosen = path.join(dir, pickVtt); type='vtt'; }
      else {
        const pickSrt = pick(srtCands);
        if (pickSrt) { chosen = path.join(dir, pickSrt); type='srt'; }
      }
    }
  }
  if (chosen) {
    const parts = path.basename(chosen).split('.');
    if (parts.length >= 3) { langHint = parts[parts.length-2]; }
  }
  if (!chosen) return res.status(404).end();
  try {
    if (type === 'vtt') {
      res.setHeader('Content-Type','text/vtt; charset=utf-8');
      if (langHint) res.setHeader('X-Subtitle-Lang', langHint);
      if (req.method === 'HEAD') return res.status(200).end();
      fs.createReadStream(chosen).pipe(res);
    } else {
      const raw = fs.readFileSync(chosen,'utf8');
      if (req.method === 'HEAD') { res.setHeader('Content-Type','text/vtt; charset=utf-8'); if (langHint) res.setHeader('X-Subtitle-Lang', langHint); return res.status(200).end(); }
      const lines = raw.replace(/\r/g,'').split('\n');
      let out = ['WEBVTT',''];
      for (let i=0;i<lines.length;i++) {
        const line = lines[i];
        if (/^\d+$/.test(line.trim())) continue;
        const m = line.match(/^(\d\d:\d\d:\d\d),(\d{3}) --> (\d\d:\d\d:\d\d),(\d{3})(.*)$/);
        if (m) out.push(`${m[1]}.${m[2]} --> ${m[3]}.${m[4]}${m[5]}`); else out.push(line);
      }
      res.setHeader('Content-Type','text/vtt; charset=utf-8');
      if (langHint) res.setHeader('X-Subtitle-Lang', langHint);
      res.send(out.join('\n'));
    }
  } catch (e) {
    console.error('[subs] error serving subtitles', e); res.status(500).end();
  }
});

// List available subtitle tracks for current media
app.get('/media/current-subs.json', (req,res) => {
  if (!mediaFile) return res.json({ tracks: [] });
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base).toLowerCase() + '.';
  let files=[]; try { files = fs.readdirSync(dir); } catch { return res.json({ tracks: [] }); }
  const tracks=[];
  for (const f of files){
    const low = f.toLowerCase();
    if (!(low.startsWith(prefix))) continue;
    if (!(low.endsWith('.vtt') || low.endsWith('.srt'))) continue;
    const parts = f.split('.'); // base, lang, maybe slug..., ext
    if (parts.length < 3) continue;
    const ext = parts.pop();
    const lang = parts[parts.length-1]; // last before ext
    const slugParts = parts.slice(1, parts.length-1); // middle pieces after base
    const label = (lang + (slugParts.length? (' '+slugParts.join('-')):'' )).toLowerCase();
    tracks.push({ file: f, lang, label, ext });
  }
  tracks.sort((a,b)=> a.lang.localeCompare(b.lang));
  res.json({ tracks });
});

function listMedia(){
  const out=[];
  (function walk(dir, rel){
    let entries=[]; try { entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const e of entries){
      const abs=path.join(dir,e.name);
      const r = rel? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs,r); else {
        const low = e.name.toLowerCase();
        if (low.endsWith('.wp.mp4') || low.endsWith('.webm')) out.push(r.replace(/\\/g,'/'));
      }
    }
  })(mediaRoot,'');
  return out.sort();
}

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => console.log(`listening http://localhost:${port} (ADMIN_KEY=${ADMIN_KEY})`));
