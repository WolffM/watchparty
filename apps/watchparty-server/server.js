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

wss.on('connection', (socket) => {
  console.log('[ws] client connected');
  socket.send(JSON.stringify({ type: 'state', data: lastBroadcast }));
  socket.on('close', ()=> console.log('[ws] client closed'));
  socket.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const { type } = msg;
    if (type === 'ping') { socket.send(JSON.stringify({ type:'pong', at: Date.now() })); return; }
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
});

// Optional heartbeat broadcast every 5s to keep idle clients synced
setInterval(()=>{ if (!mediaFile) return; broadcastState(); }, 5000);

function broadcastState(){
  const payload = JSON.stringify({ type:'state', data: lastBroadcast });
  for (const c of wss.clients) { if (c.readyState === 1) c.send(payload); }
}

// Locate first playable file (prefer *.wp.mp4 then .webm) or use MEDIA_FILE env.
const ROOT = process.cwd();
const mediaRoot = path.join(ROOT, 'media');
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

// Static index
app.use(express.static(path.join(__dirname, 'public')));

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
