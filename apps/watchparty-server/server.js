import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- Directories & Constants ---
const ROOT = process.cwd();
const publicDir = path.join(__dirname, 'public');
const stateDir = path.resolve(ROOT, 'state');
const stagedPath = path.join(stateDir, 'staged.json');
const symlinkDir = path.join(stateDir, 'symlinks');
const mediaRoot = path.join(ROOT, 'media');
// We now only serve already-transcoded browser-friendly files (mp4/webm). Primary link uses mp4 extension.
const CURRENT_LINK = path.join(symlinkDir, 'current.mp4');
const cacheDir = path.join(stateDir, 'cache');

// Ensure required dirs/files
if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
if (!fs.existsSync(symlinkDir)) fs.mkdirSync(symlinkDir, { recursive: true });
if (!fs.existsSync(stagedPath)) fs.writeFileSync(stagedPath, '{}', 'utf8');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// Attempt to create initial symlink if missing (Milestone 1 T1.2)
function pickFirstMedia(dir) {
  // Prefer explicitly transcoded files: *.wp.mp4, else any .webm
  function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    // First pass: look for *.wp.mp4
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (ent.name.toLowerCase().endsWith('.wp.mp4')) {
        return full;
      }
    }
    // Second pass: fallback to .webm
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (ent.name.toLowerCase().endsWith('.webm')) {
        return full;
      }
    }
    return null;
  }
  return walk(dir);
}

function ensureSymlink() {
  if (fs.existsSync(CURRENT_LINK)) return; // already present
  const candidate = pickFirstMedia(mediaRoot);
  if (!candidate) {
    console.log('[symlink] No playable *.wp.mp4 or .webm found; /media/current.mp4 will 404 until staged.');
    return;
  }
  const lockPath = path.join(symlinkDir, '.create_current.lock');
  try {
    try { fs.writeFileSync(lockPath, String(Date.now()), { flag: 'wx' }); } catch {}
    if (fs.existsSync(CURRENT_LINK)) return;
    try {
      fs.symlinkSync(candidate, CURRENT_LINK, 'file');
      console.log('[symlink] Created initial current.mp4 ->', path.relative(ROOT, candidate));
      return;
    } catch (e1) {
      if (e1.code === 'EEXIST') {
        if (fs.existsSync(CURRENT_LINK)) {
          console.log('[symlink] current.mp4 already exists (EEXIST benign)');
          return;
        }
      }
      try {
        fs.linkSync(candidate, CURRENT_LINK);
        console.log('[symlink] Created hard link (fallback) current.mp4 ->', path.relative(ROOT, candidate));
        return;
      } catch (e2) {
        if (e2.code === 'EEXIST' && fs.existsSync(CURRENT_LINK)) {
          console.log('[symlink] current.mp4 present after fallback attempt (benign)');
          return;
        }
        if (fs.existsSync(CURRENT_LINK)) {
          console.log('[symlink] current.mp4 present after attempts');
          return;
        }
        console.warn('[symlink] create failed (non-benign):', e2.message || e1.message);
      }
    }
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}
ensureSymlink();
console.log('[startup] CURRENT_LINK exists:', fs.existsSync(CURRENT_LINK), 'path:', CURRENT_LINK);
try { if (fs.existsSync(CURRENT_LINK)) console.log('[startup] CURRENT_LINK real ->', fs.realpathSync(CURRENT_LINK)); } catch {}
function ensureStagedFromLink() {
  if (!fs.existsSync(CURRENT_LINK)) return;
  let raw = '{}';
  try { raw = fs.readFileSync(stagedPath, 'utf8'); } catch {}
  try {
    const data = JSON.parse(raw || '{}');
    if (data && data.etag) return; // already populated
  } catch {}
  try {
    const real = fs.realpathSync(CURRENT_LINK);
    const rel = path.relative(mediaRoot, real).replace(/\\/g,'/');
    const stat = fs.statSync(real);
    const etag = crypto.createHash('sha1').update(real + String(stat.mtimeMs)).digest('hex');
    const record = { path: rel, etag, updatedAt: Date.now() };
    fs.writeFileSync(stagedPath, JSON.stringify(record, null, 2));
  console.log('[startup] synthesized staged metadata for', rel, 'etag', etag.slice(0,8));
  } catch (e) {
    console.warn('[startup] failed to synthesize staged metadata:', e.message);
  }
}
ensureStagedFromLink();

// --- Transcode Support (optional fallback) ---
import { spawnSync, spawn } from 'child_process';
function ffmpegAvailable() {
  try { const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return r.status === 0; } catch { return false; }
}
const HAS_FFMPEG = ffmpegAvailable();

function getStagedMeta() {
  try { return JSON.parse(fs.readFileSync(stagedPath,'utf8')||'{}'); } catch { return {}; }
}
function currentRealTarget() {
  if (!fs.existsSync(CURRENT_LINK)) return null;
  try { return fs.realpathSync(CURRENT_LINK); } catch { return null; }
    if (fs.existsSync(CURRENT_LINK)) {
      // Validate the existing link/file actually points at a playable file
      try {
        const real = fs.realpathSync(CURRENT_LINK);
        if (fs.existsSync(real)) {
          console.log('[symlink] current.mp4 already valid ->', path.relative(ROOT, real));
          return;
        }
        // Real path missing: remove stale and recreate
        console.warn('[symlink] Stale current.mp4 (dangling). Recreating.');
        try { fs.unlinkSync(CURRENT_LINK); } catch {}
      } catch {
        // Could not resolve; remove and recreate
        try { fs.unlinkSync(CURRENT_LINK); } catch {}
      }
    }

// Kick off (blocking) transcode if cache miss. Simple baseline H.264 + AAC.
function ensureTranscodedSync(etag, sourcePath) {
  const outPath = path.join(cacheDir, `${etag}.mp4`);
  if (fs.existsSync(outPath)) return outPath;
  const lock = outPath + '.lock';
        // If exists but maybe not valid; final validation
        try {
          const real = fs.realpathSync(CURRENT_LINK);
          console.log('[symlink] current.mp4 exists after race ->', path.relative(ROOT, real));
          return;
        } catch (e) {
          console.warn('[symlink] EEXIST but unreadable. Forcing recreate.');
          try { fs.unlinkSync(CURRENT_LINK); } catch {}
          try {
            fs.symlinkSync(candidate, CURRENT_LINK, 'file');
            console.log('[symlink] Recreated current.mp4 ->', path.relative(ROOT, candidate));
            return;
          } catch {}
        }
    const start = Date.now();
    while (Date.now() - start < 30000) { // 30s
      if (fs.existsSync(outPath)) return outPath;
    }
    return fs.existsSync(outPath) ? outPath : null;
  }
  fs.writeFileSync(lock, '');
  try {
          try {
            const real = fs.realpathSync(CURRENT_LINK);
            console.log('[symlink] current.mp4 present during fallback ->', path.relative(ROOT, real));
            return;
          } catch {}
    const proc = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    if (proc.status !== 0) {
      console.warn('[transcode] ffmpeg failed status', proc.status);
      try { fs.unlinkSync(outPath); } catch {}
      return null;
    }
    console.log('[transcode] complete', path.basename(outPath));
    return outPath;
  } finally { try { fs.unlinkSync(lock); } catch {} }
}

// Range-support helper for static file
function serveFileWithRange(req, res, filePath, contentType) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { res.status(404).end(); return; }
  const total = stat.size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.status(200).end();
    return fs.createReadStream(filePath).pipe(res);
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) { res.status(416).end(); return; }
  let start = m[1] ? parseInt(m[1],10) : 0; let end = m[2] ? parseInt(m[2],10) : (total-1);
  if (isNaN(start) || isNaN(end) || start > end || end >= total) { res.status(416).setHeader('Content-Range', `bytes */${total}`).end(); return; }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// Transcoded route
app.get('/media/transcoded/current.mp4', (req, res) => {
  if (!HAS_FFMPEG) return res.status(501).json({ ok:false, error:'ffmpeg not available' });
  const meta = getStagedMeta();
  const etag = meta.etag;
  const source = currentRealTarget();
  if (!etag || !source) return res.status(404).json({ ok:false, error:'Not staged' });
  const out = ensureTranscodedSync(etag, source);
  if (!out) return res.status(500).json({ ok:false, error:'Transcode failed' });
  serveFileWithRange(req, res, out, 'video/mp4');
});

// --- Middleware / Static ---
app.use(express.static(publicDir));
app.use(express.json()); // for JSON bodies (Milestone 2)

// Root -> viewer
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Health
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// --- Range-enabled media endpoint for current transcoded asset ---
app.get('/media/current.mp4', (req, res) => {
  // Resolve symlink (or hard link / file)
  if (!fs.existsSync(CURRENT_LINK)) {
    console.warn('[media] 404 current.mp4 missing at', CURRENT_LINK);
    res.status(404).send('Not staged');
    return;
  }
  let stat;
  let realTarget = CURRENT_LINK;
  try {
    stat = fs.statSync(CURRENT_LINK); // follows symlink
    try { realTarget = fs.realpathSync(CURRENT_LINK); } catch {}
  } catch {
    console.warn('[media] 404 stat error for current.mp4');
    res.status(404).send('Not found');
    return;
  }
  if (!fs.existsSync(realTarget)) {
    console.warn('[media] 404 real target missing for current.mp4 ->', realTarget);
    return res.status(404).send('Missing target');
  }
  const total = stat.size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  // Basic content type inference by extension of real target
  function mimeFromExt(p){
    const ext = path.extname(p).toLowerCase();
    switch(ext){
      case '.mp4': case '.m4v': return 'video/mp4';
      case '.webm': return 'video/webm';
      case '.mov': return 'video/quicktime';
      default: return 'application/octet-stream';
    }
  }
  res.setHeader('Content-Type', mimeFromExt(realTarget));

  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.status(200).end();
    fs.createReadStream(CURRENT_LINK).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    res.status(416).end();
    return;
  }
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : (total - 1);
  if (isNaN(start) || isNaN(end) || start > end || end >= total) {
    res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    return;
  }
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', chunkSize);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(CURRENT_LINK, { start, end }).pipe(res);
});

// Diagnostic endpoint (not for production) to verify symlink target
app.get('/debug/link', (req, res) => {
  try {
    if (!fs.existsSync(CURRENT_LINK)) return res.json({ exists:false });
    const real = fs.realpathSync(CURRENT_LINK);
    const stat = fs.statSync(CURRENT_LINK);
    res.json({ exists:true, target: path.relative(ROOT, real), size: stat.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Helper: Safe path inside media root ---
function safeMediaPath(rel) {
  if (rel == null) rel = '';
  if (typeof rel !== 'string') return null;
  // empty string -> root
  if (rel === '') return { rel: '', abs: mediaRoot };
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.join(mediaRoot, norm);
  if (!abs.startsWith(mediaRoot)) return null; // traversal attempt
  return { rel: norm, abs };
}

// --- Helper: enumerate media files recursively (filtered extensions) ---
// Only list officially transcoded or validated formats now (*.wp.mp4 + .webm).
const LIST_EXTS = new Set(['.wp.mp4', '.webm']);
function listMedia(startRel = '') {
  const base = safeMediaPath(startRel);
  if (!base) return [];
  const files = [];
  function walk(dirAbs, prefixRel) {
    let entries = [];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const entAbs = path.join(dirAbs, ent.name);
      const entRel = prefixRel ? `${prefixRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(entAbs, entRel);
      } else {
        const lower = ent.name.toLowerCase();
        if (lower.endsWith('.wp.mp4') || lower.endsWith('.webm')) {
          files.push(entRel);
        }
      }
    }
  }
  walk(base.abs, base.rel.replace(/\/$/,'').replace(/\/$/, ''));
  // If startRel points directly to a file include it if matches
  if (base && fs.existsSync(base.abs) && fs.statSync(base.abs).isFile()) {
    const lower = base.abs.toLowerCase();
    if (lower.endsWith('.wp.mp4') || lower.endsWith('.webm')) {
      if (!files.includes(base.rel)) files.push(base.rel);
    }
  }
  return files.sort();
}

// --- API: GET /api/media (Milestone 2 T2.1) ---
app.get('/api/media', (req, res) => {
  const scope = typeof req.query.path === 'string' ? req.query.path : '';
  const list = listMedia(scope);
  res.json(list);
});

// --- API: GET /api/staged (Milestone 2 T2.2) ---
app.get('/api/staged', (_req, res) => {
  try {
    const raw = fs.readFileSync(stagedPath, 'utf8');
    if (!raw.trim()) return res.json({});
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return res.json({});
    const { path: rel, etag, updatedAt } = data;
    if (!rel || !etag) return res.json({});
    return res.json({ path: rel, etag, updatedAt });
  } catch {
    return res.json({});
  }
});

// Placeholder broadcast (replaced after WS server is created in Milestone 3)
let broadcast = (msg) => {
  console.log('[broadcast stub]', msg);
};

// --- API: POST /api/stage (Milestone 2 T2.3) ---
app.post('/api/stage', async (req, res) => {
  const { path: rel, key } = req.body || {};
  if (!process.env.ADMIN_KEY) {
    console.warn('ADMIN_KEY not set; rejecting stage attempt.');
    return res.status(500).json({ ok: false, error: 'ADMIN_KEY not configured' });
  }
  if (!key || key !== process.env.ADMIN_KEY) {
    console.warn('[stage] 403 invalid key for', rel);
    return res.status(403).json({ ok:false, error: 'Forbidden (bad key)' });
  }
  const sp = safeMediaPath(rel);
  if (!sp) return res.status(400).json({ ok: false, error: 'Invalid path' });
  try {
    const st = fs.statSync(sp.abs);
    if (!st.isFile()) return res.status(400).json({ ok: false, error: 'Not a file' });
  } catch {
    return res.status(404).json({ ok: false, error: 'File not found' });
  }
  // Enforce playable extension
  const lowerName = sp.abs.toLowerCase();
  if (!(lowerName.endsWith('.wp.mp4') || lowerName.endsWith('.webm'))) {
    return res.status(400).json({ ok:false, error:'File must be a transcoded *.wp.mp4 or .webm'});
  }
  // Prepare atomic swap
  const tempLink = path.join(symlinkDir, `.__current_${Date.now()}_${Math.random().toString(16).slice(2)}.mp4`);
  try {
    try { fs.unlinkSync(tempLink); } catch {}
    let linkCreated = false;
    try {
      fs.symlinkSync(sp.abs, tempLink, 'file');
      linkCreated = true;
    } catch (e) {
      try {
        fs.linkSync(sp.abs, tempLink); // fallback hard link
        linkCreated = true;
      } catch (e2) {
        console.warn('Failed to create (sym|hard) link:', e2.message);
      }
    }
    if (!linkCreated) throw new Error('Unable to create link');
    try { fs.unlinkSync(CURRENT_LINK); } catch {}
    fs.renameSync(tempLink, CURRENT_LINK);
  } catch (err) {
    try { fs.unlinkSync(tempLink); } catch {}
    console.error('[stage] swap failed', err);
    return res.status(500).json({ ok: false, error: 'Stage swap failed', detail: err.message });
  }
  // Compute etag
  const stat = fs.statSync(sp.abs);
  const etag = crypto.createHash('sha1').update(sp.abs + String(stat.mtimeMs)).digest('hex');
  const record = { path: sp.rel, etag, updatedAt: Date.now() };
  try {
    fs.writeFileSync(stagedPath, JSON.stringify(record, null, 2));
  } catch (err) {
    console.error('[stage] persist failed', err);
    return res.status(500).json({ ok: false, error: 'Persist failed', detail: err.message });
  }
  console.log('[stage] staged', sp.rel, 'etag', etag.slice(0,8));
  broadcast({ cmd: 'load', etag });
  res.json({ ok: true, etag });
});

// --- WebSocket Hub (Milestone 3) ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function wsBroadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Replace stub broadcast with real implementation
broadcast = function (msg) { wsBroadcast(msg); };

const ADMIN_KEY = process.env.ADMIN_KEY;
const ADMIN_CMDS = new Set(['play', 'pause', 'seek', 'load']);

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const { cmd, key } = msg;
    if (!ADMIN_CMDS.has(cmd)) return; // ignore unknown
    if (!ADMIN_KEY || key !== ADMIN_KEY) return; // auth fail silently
    // Build broadcast sans key
    if (cmd === 'seek') {
      const time = Number(msg.time);
      if (!isFinite(time) || time < 0) return;
      broadcast({ cmd: 'seek', time });
    } else if (cmd === 'load') {
      if (typeof msg.etag !== 'string') return;
      broadcast({ cmd: 'load', etag: msg.etag });
    } else if (cmd === 'play' || cmd === 'pause') {
      broadcast({ cmd });
    }
  });
});

// Diagnostic status endpoint
app.get('/debug/status', (_req, res) => {
  let linkExists = fs.existsSync(CURRENT_LINK);
  let real = null;
  try { if (linkExists) real = path.relative(ROOT, fs.realpathSync(CURRENT_LINK)); } catch {}
  let stagedMeta = null;
  try { stagedMeta = JSON.parse(fs.readFileSync(stagedPath,'utf8')||'{}'); } catch {}
  res.json({ adminKeySet: !!process.env.ADMIN_KEY, symlink: linkExists ? { target: real } : null, staged: stagedMeta });
});

// Detailed symlink diagnostics
app.get('/debug/symlink', (_req, res) => {
  const exists = fs.existsSync(CURRENT_LINK);
  let info = { exists };
  if (exists) {
    try {
      const stat = fs.lstatSync(CURRENT_LINK);
      let target = null;
      if (stat.isSymbolicLink()) {
        try { target = fs.readlinkSync(CURRENT_LINK); } catch {}
      } else {
        try { target = fs.realpathSync(CURRENT_LINK); } catch {}
      }
      const real = (() => { try { return fs.realpathSync(CURRENT_LINK); } catch { return null; } })();
      const realStat = real ? (()=>{ try { return fs.statSync(real); } catch { return null; } })() : null;
      info = {
        exists,
        type: stat.isSymbolicLink() ? 'symlink' : 'file',
        target,
        real,
        size: realStat ? realStat.size : null,
        mtimeMs: realStat ? realStat.mtimeMs : null
      };
    } catch (e) {
      info.error = e.message;
    }
  }
  res.json(info);
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => {
  const keyMsg = process.env.ADMIN_KEY ? 'ADMIN_KEY loaded' : 'ADMIN_KEY MISSING (staging disabled)';
  console.log(`watchparty on http://localhost:${port} (${keyMsg})`);
});
