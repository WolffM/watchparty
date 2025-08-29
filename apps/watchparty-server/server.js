import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Simple in-memory session state
let mediaFile = null;      // absolute path to current media (null until admin selects)
let mediaRel = null;       // relative path under media root (null means no media loaded yet)
let mediaRev = 0;          // incremented when media changes
let lastBroadcast = { t: 0, paused: true, ts: Date.now(), rev: mediaRev, path: mediaRel }; // initial home state
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
const clientMeta = new Map(); // socket -> { id, color, customName, lastSeen, msgTimes: number[], isAdmin }
let nextClientId = 1;
const chatHistory = []; // ring buffer of { type:'chat', id,name,color,text,ts }
const CHAT_HISTORY_LIMIT = 200;
const CHAT_HISTORY_SEND = 100;
// Presence timeout (extend slightly while debugging unexpected disconnects)
const PRESENCE_TIMEOUT_MS = 40000;
const PRESENCE_SWEEP_INTERVAL = 10000;
const CHAT_RATE_MAX = 5; // messages
const CHAT_RATE_WINDOW_MS = 5000; // time window

function assignColor(){ if(colorsAvailable.length) return colorsAvailable.shift(); return null; }
function releaseColor(c){ if(!c) return; if(COLOR_PALETTE.includes(c) && !colorsAvailable.includes(c)) { colorsAvailable.push(c); /* maintain original order */ colorsAvailable = COLOR_PALETTE.filter(col => colorsAvailable.includes(col)); } }
function displayName(meta){
  if (!meta) return '';
  if (meta.customName && meta.customName.trim()) return meta.customName.trim();
  if (meta.color) return meta.color;
  return 'anon'+meta.id;
}
function broadcastPresence(){
  const users = [];
  for (const meta of clientMeta.values()) { users.push({ id: meta.id, name: displayName(meta), color: meta.color }); }
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
function pushSystemAdmin(text){
  const now = Date.now();
  const msg = { type:'system', text, ts: now };
  // deliver only to admin clients
  for (const [sock, meta] of clientMeta.entries()) {
    if (sock.readyState === 1 && meta && meta.isAdmin) {
      try { sock.send(JSON.stringify(msg)); } catch {}
    }
  }
  // Do NOT store in global chat history for viewers; admins will still see it within their session
}
function sendSelf(socket, meta){
  try { socket.send(JSON.stringify({ type:'self', id: meta.id, name: displayName(meta), color: meta.color })); } catch {}
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
  const isAdminClient = req.url.startsWith('/admin');
  const meta = { id: nextClientId++, color: assignColor(), lastSeen: Date.now(), msgTimes: [], isAdmin: isAdminClient };
  clientMeta.set(socket, meta);
  console.log('[ws] client connected', meta.id, 'color=', meta.color);
  socket.send(JSON.stringify({ type: 'state', data: lastBroadcast }));
  // Send presence + chat history
  sendChatHistory(socket);
  broadcastPresence();
  // System join message (broadcast) & self-only notice
  pushSystem((meta.color? meta.color : ('anon'+meta.id)) + ' joined');
  sendSelf(socket, meta);
  // Message handler (playback sync, chat, media selection, presence ping)
  socket.on('message', data => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    const now = Date.now();
    const meta = clientMeta.get(socket); if (!meta) return;
    meta.lastSeen = now;
    switch(msg.type){
      case 'ping':
        // Presence updated above; respond with pong so client can schedule next ping
        try { socket.send(JSON.stringify({ type:'pong', ts: now })); } catch {}
        break;
      case 'chat': {
        const text = (msg.text||'').toString().slice(0,500).trim();
        if (!text) break;
        // rate limit
        meta.msgTimes = meta.msgTimes.filter(t => now - t < CHAT_RATE_WINDOW_MS);
        if (meta.msgTimes.length >= CHAT_RATE_MAX) { try { socket.send(JSON.stringify({ type:'error', error:'rate'})); } catch {} break; }
        meta.msgTimes.push(now);
        pushChat({ type:'chat', id: meta.id, name: displayName(meta), color: meta.color, text, ts: now });
        break; }
      case 'rename': {
        // Accept optional color & name; enforce uniqueness of color
        const newColor = msg.color && typeof msg.color === 'string' ? msg.color.toLowerCase() : null;
        let newNameRaw = msg.name && typeof msg.name === 'string' ? msg.name : '';
        if (newNameRaw.length > 40) newNameRaw = newNameRaw.slice(0,40);
        // Sanitize name: allow letters/numbers/basic punctuation + spaces
        let newName = newNameRaw.replace(/[^\w \-'.!?,]/g,'').trim();
        if (newName.length > 40) newName = newName.slice(0,40);
        let changed = false;
        if (newColor && COLOR_PALETTE.includes(newColor) && newColor !== meta.color) {
          // ensure not in use by someone else
            let inUse = false;
            for (const m of clientMeta.values()) { if (m !== meta && m.color === newColor) { inUse = true; break; } }
            if (inUse) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'in-use' })); } catch {} break; }
            // release old, assign new
            releaseColor(meta.color);
            meta.color = newColor;
            colorsAvailable = colorsAvailable.filter(c=> c!==newColor); // ensure removed
            changed = true;
        }
        if (newName && newName !== meta.customName) { meta.customName = newName; changed = true; }
        if (!changed) { try { socket.send(JSON.stringify({ type:'rename-result', ok:false, reason:'unchanged' })); } catch {} break; }
        try { socket.send(JSON.stringify({ type:'rename-result', ok:true, color: meta.color, name: displayName(meta) })); } catch {}
        // update self meta to requester
        sendSelf(socket, meta);
        broadcastPresence();
        break; }
      case 'select': // deprecated in UI (was 'load')
      case 'load': {
        const isAdminMsg = (msg.admin === ADMIN_KEY || msg.key === ADMIN_KEY);
        if (!isAdminMsg) { console.log('[ws] denied load/select (not admin)'); break; }
        if (msg.path && typeof msg.path === 'string') {
          const resolved = resolveMedia(msg.path);
          if (resolved) {
            mediaFile = resolved.abs; mediaRel = resolved.rel; mediaRev++;
            lastBroadcast = { t:0, paused:true, ts: now, rev: mediaRev, path: mediaRel };
            cachedAudioRev = -1; cachedAudioList = [];
            console.log('[ws] load media', mediaRel);
            pushSystemAdmin(`media selected: ${mediaRel}`);
            broadcastState();
          } else {
            console.log('[ws] load failed: not found', msg.path);
          }
        }
        break; }
      case 'unload': {
        const isAdminMsg = (msg.admin === ADMIN_KEY || msg.key === ADMIN_KEY);
        if (!isAdminMsg) { console.log('[ws] denied unload (not admin)'); break; }
        if (mediaFile) {
          console.log('[ws] unload media', mediaRel);
          mediaFile = null; mediaRel = null; mediaRev++;
          lastBroadcast = { t:0, paused:true, ts: now, rev: mediaRev, path: mediaRel };
          cachedAudioRev = -1; cachedAudioList = [];
          pushSystemAdmin('media unloaded (home)');
          broadcastState();
        }
        break; }
      case 'play': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          lastBroadcast = { t: msg.t, paused:false, ts: now, rev: mediaRev, path: mediaRel };
          broadcastState();
        }
        break; }
      case 'pause': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          lastBroadcast = { t: msg.t, paused:true, ts: now, rev: mediaRev, path: mediaRel };
          broadcastState();
        }
        break; }
      case 'seek': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          lastBroadcast = { t: msg.t, paused: !!msg.paused, ts: now, rev: mediaRev, path: mediaRel };
          broadcastState();
        }
        break; }
      case 'tick': {
        if (typeof msg.t === 'number' && msg.t >= 0 && !lastBroadcast.paused) {
          // drift correction: if remote ahead by >0.25s advance reference
            if (msg.t > lastBroadcast.t + 0.25) {
              lastBroadcast = { t: msg.t, paused:false, ts: now, rev: mediaRev, path: mediaRel };
              broadcastState();
            }
        }
        break; }
    }
  });
  socket.on('close', (code, reasonBuf)=>{
    let reason = '';
    try { if (reasonBuf) reason = reasonBuf.toString(); } catch {}
    console.log('[ws] client closed', meta.id, 'code=', code, 'reason=', reason);
    const m = clientMeta.get(socket);
  if (m) { pushSystem((m.color? m.color: ('anon'+m.id)) + ' left'); releaseColor(m.color); clientMeta.delete(socket); broadcastPresence(); }
  });
  socket.on('error', err => {
    console.warn('[ws] client error', meta.id, err?.message);
  });
});

// Optional heartbeat broadcast every 5s to keep idle clients synced
setInterval(()=>{ if (!mediaFile) return; broadcastState(); }, 5000);

// Presence timeout sweeper
setInterval(()=>{
  let changed=false; const now=Date.now();
  for (const [sock, meta] of [...clientMeta.entries()]) {
    const idle = now - meta.lastSeen;
    if (idle > PRESENCE_TIMEOUT_MS) {
      console.warn('[presence] timing out client', meta.id, 'idle', idle);
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

// Lightweight telemetry endpoints for debugging client disconnects
app.get('/api/debug/clients', (_req,res)=>{
  const now = Date.now();
  const clients = [];
  for (const [sock, meta] of clientMeta.entries()) {
    clients.push({ id: meta.id, color: meta.color, isAdmin: !!meta.isAdmin, idleMs: now - meta.lastSeen });
  }
  res.json({ count: clients.length, clients });
});
app.get('/api/debug/state', (_req,res)=>{
  res.json({ lastBroadcast, mediaFile: mediaFile? path.relative(process.cwd(), mediaFile): null, rev: mediaRev });
});

// Locate first playable file (prefer *.wp.mp4 then .webm) or use MEDIA_FILE env.
const ROOT = process.cwd();
// Only serve system-managed outputs (transcoded + subtitles) from media/output; raw user imports live elsewhere
const mediaRoot = path.join(ROOT, 'media', 'output');
// Cached audio stream probe (reset when mediaRev changes)
let cachedAudioRev = -1; // rev used for cache
let cachedAudioList = [];

// Unified episode key extraction (handles SxxEyy, Exx, and " - 01 " patterns in release names)
function episodeKeyFromName(name){
  if(!name) return null;
  const base = name.replace(/\.(wp\.mp4|webm)$/i,'');
  const lower = base.toLowerCase();
  let m = lower.match(/(s\d{1,2}e\d{1,3})/i); if (m) return m[1].toUpperCase();
  m = lower.match(/\b(e\d{2,3})\b/i); if (m) return m[1].toUpperCase();
  // Pattern: space-hyphen-space + number (e.g., " - 01 ") followed by space or end or bracket
  m = lower.match(/ - (\d{2,3})(?=\s|\[|$)/); if (m) { const num = m[1]; return 'S01E' + num.padStart(2,'0'); }
  return null;
}

function probeAudioStreams(file){
  try {
    if (!file) return [];
    if (cachedAudioRev === mediaRev && cachedAudioList.length && file === mediaFile) return cachedAudioList;
    const args = [
      '-v','error',
      '-select_streams','a',
      '-show_entries','stream=index,codec_name,channels,sample_rate:stream_tags=language,title:stream_disposition=default',
      '-of','json',
      file
    ];
    const res = spawnSync('ffprobe', args, { encoding: 'utf8' });
    if (res.error) { console.warn('[ffprobe] spawn error', res.error); return []; }
    const txt = (res.stdout||'').trim();
    if (!txt) return [];
    let j; try { j = JSON.parse(txt); } catch { return []; }
    const out = [];
    if (j && Array.isArray(j.streams)) {
      for (const s of j.streams) {
        out.push({
          index: s.index,
            // language tag precedence: tags.language, tags.LANGUAGE, else ''
          lang: (s.tags && (s.tags.language || s.tags.LANGUAGE) || '').toLowerCase(),
          title: (s.tags && (s.tags.title || s.tags.TITLE) || ''),
          codec: s.codec_name || '',
          channels: s.channels || null,
          sample_rate: s.sample_rate ? Number(s.sample_rate) : null,
          default: !!(s.disposition && s.disposition.default)
        });
      }
    }
    cachedAudioList = out;
    cachedAudioRev = mediaRev;
    return out;
  } catch (e) {
    console.warn('[ffprobe] error', e); return [];
  }
}
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
// Startup: DO NOT auto-load first media; begin on "home" (starfield) until admin selects a file.
console.log('[media] starting with no media loaded (home screen)');

// Auth gate for index: require ?admin=KEY (or ?admin=auto in non-prod) even for viewer mode
const publicDir = path.join(__dirname, 'public');
function authGate(req, res, next){
  const supplied = req.query.admin;
  if (supplied === ADMIN_KEY || supplied === 'auto') return next();
  const wanted = req.path === '/' ? '/' : req.path;
  // Inline starfield so animation is visible BEFORE key entry.
  res.status(401).send(`<!doctype html><html><head><meta charset=utf-8><title>Enter Access Key</title><style>
  :root{color-scheme:dark}
  body{font-family:system-ui,Segoe UI,Roboto,sans-serif;position:relative;margin:0;min-height:100vh;background:#000;color:#e6e6e6;display:flex;align-items:center;justify-content:center;overflow:hidden}
  #sf{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000}
  form{position:relative;z-index:2;background:#121519;padding:24px 28px 28px;border-radius:14px;box-shadow:0 4px 28px -4px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:12px;min-width:300px;border:1px solid #1e242b}
  h2{margin:0;font:600 18px system-ui;letter-spacing:.3px}
  p{margin:0}
  .sub{font:12px system-ui;opacity:.75}
  input{padding:10px 12px;border-radius:8px;border:1px solid #2a333c;background:#0d1115;color:#e6e6e6;font:14px system-ui;outline:none}
  input:focus{border-color:#347fd9}
  button{all:unset;background:#2e78d2;color:#fff;padding:12px 16px;border-radius:10px;cursor:pointer;font:600 14px system-ui;text-align:center;letter-spacing:.3px}
  button:hover{background:#296bc0}
  .hint{margin:4px 0 0;font:11px system-ui;opacity:.55}
  </style></head><body>
  <canvas id=sf></canvas>
  <form onsubmit="var k=document.getElementById('k').value.trim(); if(k){var extra=location.search.includes('verbose')?'&verbose':''; location.href='${wanted}?admin='+encodeURIComponent(k)+extra;} return false">
    <h2>Enter Access Key</h2>
    <p class=sub>Key required to join session.</p>
    <input id=k placeholder='Access key' autofocus autocomplete=off spellcheck=false>
    <button type=submit>Enter</button>
    <p class=hint>Provide the key to viewers.</p>
  </form>
  <script>(function(){var c=document.getElementById('sf');if(!c)return;var ctx=c.getContext('2d');function rs(){c.width=innerWidth;c.height=innerHeight;}addEventListener('resize',rs);rs();var stars=[];var N=Math.min(1400,Math.floor(c.width*c.height/2400));for(var i=0;i<N;i++){stars.push({x:Math.random()*2-1,y:Math.random()*2-1,z:Math.random(),s:0.00018+Math.random()*0.00042});}var last=0;function step(ts){if(!last)last=ts;var dt=Math.min(60,ts-last);last=ts;ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);var w=c.width,h=c.height,cx=w/2,cy=h/2;for(var s of stars){s.z-=s.s*dt;if(s.z<=0.0005){s.x=Math.random()*2-1;s.y=Math.random()*2-1;s.z=1;}var k=1/s.z,px=s.x*k*cx+cx,py=s.y*k*cy+cy;if(px>=0&&px<w&&py>=0&&py<h){var r=Math.max(.4,1.7*(1-s.z));ctx.fillStyle='rgba(255,255,255,'+(1.15*(1-s.z)).toFixed(3)+')';ctx.beginPath();ctx.arc(px,py,r,0,6.283);ctx.fill();}}requestAnimationFrame(step);}requestAnimationFrame(step);})();</script>
  </body></html>`);
}
app.get(['/', '/index.html'], authGate, (req,res)=> res.sendFile(path.join(publicDir,'index.html')));
app.get(['/admin','/admin.html'], authGate, (req,res)=> res.sendFile(path.join(publicDir,'index.html')));
// Static assets (JS/CSS/media fetches) remain open; gate is only entry HTML + websocket + admin actions
app.use(express.static(publicDir));
// Serve character sprite images (read-only)
app.use('/media/sprites', express.static(path.join(ROOT,'media','sprites')));
// Expose transcoded output directory (read-only) for sidecar audio & copied subtitle assets
app.use('/media/output', express.static(path.join(ROOT,'media','output')));

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

// Subtitle route with cross-variant language selection & sanitization
app.get('/media/current.vtt', (req, res) => {
  if (!mediaFile) return res.status(404).end();
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base);
  const epKey = (episodeKeyFromName(prefix) || '').toLowerCase();
  const wantLangRaw = (req.query.lang||'').trim();
  const wantLang = wantLangRaw.toLowerCase();
  let files = [];
  try { files = fs.readdirSync(dir); } catch {}
  const candidates = [];
  for (const f of files) {
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
    candidates.push({ file: f, low, ext: ext.toLowerCase(), lang: langGuess, baseMatch, epMatch });
  }
  let chosenObj = null;
  function pickFirst(fn){ return candidates.find(fn) || null; }
  if (wantLang) chosenObj = pickFirst(c=> c.lang===wantLang && c.baseMatch) || pickFirst(c=> c.lang===wantLang);
  if (!chosenObj) chosenObj = pickFirst(c=> /^(eng|en)$/i.test(c.lang) && c.baseMatch) || pickFirst(c=> /^(eng|en)$/i.test(c.lang));
  if (!chosenObj) chosenObj = pickFirst(c=> c.baseMatch);
  if (!chosenObj) chosenObj = candidates[0];
  if (!chosenObj) return res.status(404).end();
  const chosen = path.join(dir, chosenObj.file);
  const type = chosenObj.ext === 'srt' ? 'srt':'vtt';
  const langHint = chosenObj.lang;
  res.setHeader('X-Subtitle-Source', chosenObj.file);
  res.setHeader('X-Subtitle-Lang', langHint);
  try {
    if (req.method === 'HEAD') { res.setHeader('Content-Type','text/vtt; charset=utf-8'); return res.status(200).end(); }
    let raw = fs.readFileSync(chosen,'utf8').replace(/\r/g,'');
    if (type === 'srt') {
      const out=['WEBVTT',''];
      const lines = raw.split('\n');
      for (const line of lines){
        if (/^\d+$/.test(line.trim())) continue;
        const m=line.match(/^(\d\d:\d\d:\d\d),(\d{3}) --> (\d\d:\d\d:\d\d),(\d{3})(.*)$/); if (m) out.push(`${m[1]}.${m[2]} --> ${m[3]}.${m[4]}${m[5]}`); else out.push(line);
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
    res.setHeader('Content-Type','text/vtt; charset=utf-8');
    res.send(dedup.join('\n'));
  } catch(e){ console.error('[subs] error serving subtitles', e); res.status(500).end(); }
});

// List available embedded audio tracks for current media (requires ffprobe on PATH)
app.get('/media/current-audio.json', (_req,res) => {
  if (!mediaFile) return res.json({ tracks: [] });
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base);
  const epKey = (episodeKeyFromName(prefix) || '').toLowerCase();
  let sidecars = [];
  try {
    const files = fs.readdirSync(dir);
    const escPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const sidecarPrefixRe = new RegExp('^' + escPrefix + '\\.' + 'audio' + '\\.([a-z0-9_-]{2,8})(?:\\.[^.]+)?\\.(m4a|aac|mp4)$','i');
    const sidecarEpisodeRe = epKey ? new RegExp('audio\\.([a-z0-9_-]{2,8})(?:\\.[^.]+)?\\.(m4a|aac|mp4)$','i') : null;
    const byLang = new Map();
    for (const f of files) {
      const low = f.toLowerCase();
      if (!(low.endsWith('.m4a') || low.endsWith('.aac') || low.endsWith('.mp4'))) continue;
      let lang=null, codecExt=null;
      let preferred = false;
      let m = f.match(sidecarPrefixRe);
      if (m) { lang = m[1].toLowerCase(); codecExt = (m[2]||'aac').toLowerCase(); preferred = true; }
      else if (epKey && low.includes(epKey) && sidecarEpisodeRe && (m = f.match(sidecarEpisodeRe))) {
        // cross-variant: ensure episode key present AND not already matched by prefix
        if (low.includes(epKey)) { lang = m[1].toLowerCase(); codecExt = (m[2]||'aac').toLowerCase(); }
      }
      if (!lang) continue;
      if (byLang.has(lang)) {
        // Keep existing if it's preferred (prefix match) and new isn't, else replace
        const existing = byLang.get(lang);
        if (existing.preferred) continue; // don't override canonical
        if (preferred || !existing.preferred) byLang.set(lang,{ file:f, preferred });
      } else byLang.set(lang,{ file:f, preferred });
    }
    for (const [lang, info] of byLang.entries()){
      sidecars.push({
        logical: sidecars.length,
        lang,
        title: '',
        codec: 'aac',
        channels: null,
        sample_rate: null,
        default: false,
        url: `/media/output/${encodeURIComponent(path.relative(path.join(process.cwd(),'media','output'), path.join(dir,info.file)).replace(/\\/g,'/'))}`,
        kind: 'sidecar',
        preferred: info.preferred
      });
    }
  } catch {}
  if (sidecars.length) {
    // Mark first (English if present) as default
    const eng = sidecars.find(t=> t.lang==='eng'||t.lang==='en');
    if (eng) eng.default = true; else sidecars[0].default = true;
    return res.json({ tracks: sidecars, rev: mediaRev });
  }
  const embedded = probeAudioStreams(mediaFile).map((t,i)=> ({ ...t, logical: i, kind:'embedded', url: null }));
  res.json({ tracks: embedded, rev: mediaRev });
});

// List available subtitle tracks for current media
app.get('/media/current-subs.json', (req,res) => {
  if (!mediaFile) return res.json({ tracks: [] });
  const base = mediaFile.replace(/\.(wp\.mp4|webm)$/i,'');
  const dir = path.dirname(base);
  const prefix = path.basename(base).toLowerCase() + '.';
  const epKey = (episodeKeyFromName(prefix) || '').toLowerCase();
  let files=[]; try { files = fs.readdirSync(dir); } catch { return res.json({ tracks: [] }); }
  const tracks=[];
  for (const f of files){
    const low = f.toLowerCase();
    if (!(low.endsWith('.vtt') || low.endsWith('.srt'))) continue;
  // Accept either same base OR episode keys match (robust across different release naming styles)
  const subEpKey = (episodeKeyFromName(f) || '').toLowerCase();
  if (!(low.startsWith(prefix) || (epKey && subEpKey && subEpKey === epKey))) continue;
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
  // Group by episode key so only one canonical entry per episode is shown
  const groups = new Map(); // key -> { chosen, candidates: [] }
  for (const rel of all){
    const file = rel.split(/[\\/]/).pop();
    const k = episodeKeyFromName(file) || file.replace(/\.(wp\.mp4|webm)$/i,'');
    const key = k.toUpperCase();
    let g = groups.get(key); if(!g){ g={ chosen:null, candidates:[] }; groups.set(key,g); }
    g.candidates.push(rel);
  }
  for (const [key,g] of groups.entries()){
    // Pick canonical: prefer name NOT starting with '[' and containing SxxEyy (already key) and longer descriptive title
    const sorted = [...g.candidates].sort((a,b)=>{
      const an = a.split(/[\\/]/).pop();
      const bn = b.split(/[\\/]/).pop();
      const aBracket = an.startsWith('[')?1:0; const bBracket = bn.startsWith('[')?1:0;
      if (aBracket !== bBracket) return aBracket - bBracket; // prefer non-bracket
      // Prefer longer (likely descriptive) name
      if (an.length !== bn.length) return bn.length - an.length;
      return a.localeCompare(b);
    });
    g.chosen = sorted[0];
  }
  // Build list in episode order: try season/episode numeric ordering
  function sortKey(rel){
    const name = rel.split(/[\\/]/).pop();
    const base = name.replace(/\.(wp\.mp4|webm)$/i,'');
    const m = base.match(/s(\d{1,2})e(\d{1,3})/i); if (m){ return { s: Number(m[1]), e: Number(m[2]), raw: base }; }
    const m2 = base.match(/e(\d{2,3})/i); if (m2){ return { s: 0, e: Number(m2[1]), raw: base }; }
    return { s: 0, e: 9999, raw: base };
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

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => console.log(`listening http://localhost:${port} (ADMIN_KEY=${ADMIN_KEY})`));
