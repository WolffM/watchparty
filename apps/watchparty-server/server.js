import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import { WebSocketServer } from 'ws';
import config from './config.js';
import episodeKeyFromName from './lib/episode.js';
import { resolveMedia, listMedia } from './lib/media-listing.js';
import { probeAudioStreams } from './lib/audio-probe.js';
import { buildSubtitleResponse, enumerateSubtitleTracks } from './lib/subtitles.js';
import { logTelemetry, makeWsSend, systemLog, TELEMETRY_EVENTS } from './lib/logging.js';
import { validateAccess } from './lib/auth.js';
import { renderTemplate } from './lib/templates.js';

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
// Future multi-room scaffold (Phase 4 placeholder). We keep a single implicit room keyed by ADMIN_KEY.
// Map shape: roomId -> { mediaFile, mediaRel, mediaRev, lastBroadcast }
// NOT used yet for isolation; retained so future extension only rewires accessors.
const rooms = new Map();
rooms.set(ADMIN_KEY, { get mediaFile(){ return mediaFile; }, get mediaRel(){ return mediaRel; }, get mediaRev(){ return mediaRev; }, get lastBroadcast(){ return lastBroadcast; } });

function getRoomState(roomId){
  // For now always return global; roomId unused aside from shape compliance.
  return { mediaFile, mediaRel, mediaRev, lastBroadcast };
}

// Chat / Presence data structures (character slots in assignment order)
// Assignment order with display names including umlaut: Frieren, Himmel, Heiter, Eisen, Fern, Stark, Sein, Übel
// Internal key uses exact display (with Ü). We'll normalize incoming values.
const COLOR_PALETTE = config.roles.colorPalette;
const COLOR_HEX = config.roles.colorHex;
let colorsAvailable = [...COLOR_PALETTE];
// Extended meta: bytesIn/Out + msgsIn/Out + lastRecvTs/lastSentTs for basic bandwidth stats
const clientMeta = new Map(); // socket -> { id, color, customName, lastSeen, msgTimes: number[], isAdmin, bytesIn, bytesOut, msgsIn, msgsOut, lastRecvTs, lastSentTs, connectAt, lastPos }
let nextClientId = 1;
const processStartTs = Date.now();
// Track per-media revision first file request & receive confirmations to avoid log spam
const fileRequestLogged = new Set(); // keys: guid|rev
const fileReceivedLogged = new Set(); // keys: guid|rev
function genGuid(){ return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{ const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16); }); }
const chatHistory = []; // ring buffer of { type:'chat', id,name,color,text,ts }
const CHAT_HISTORY_LIMIT = config.chat.historyLimit;
const CHAT_HISTORY_SEND = config.chat.historySend;
// Presence timeout (extend slightly while debugging unexpected disconnects)
const PRESENCE_TIMEOUT_MS = config.presence.timeoutMs;
const PRESENCE_SWEEP_INTERVAL = config.presence.sweepIntervalMs;
const CHAT_RATE_MAX = config.chat.rateMax; // messages
const CHAT_RATE_WINDOW_MS = config.chat.rateWindowMs; // time window
// Global chat burst tracking (simple sliding window of timestamps)
const globalChatTimes = [];

function assignColor(){ if(colorsAvailable.length) return colorsAvailable.shift(); return null; }
function releaseColor(c){ if(!c) return; if(COLOR_PALETTE.includes(c) && !colorsAvailable.includes(c)) { colorsAvailable.push(c); /* maintain original order */ colorsAvailable = COLOR_PALETTE.filter(col => colorsAvailable.includes(col)); } }
function displayName(meta){
  if (!meta) return '';
  if (meta.customName && meta.customName.trim()) return meta.customName.trim();
  if (meta.color) return meta.color;
  return 'anon'+meta.id;
}
// wsSend now provided via logging helper factory (enables future central logging changes)
const wsSend = makeWsSend(clientMeta);

function hasActiveAdmin(){
  for (const m of clientMeta.values()) { if (m.isAdmin) return true; }
  return false;
}
function broadcastPresence(){
  const users = [];
  for (const meta of clientMeta.values()) { users.push({ id: meta.id, name: displayName(meta), color: meta.color }); }
  const payload = JSON.stringify({ type:'presence', users });
  for (const c of wss.clients) { if (c.readyState === 1) wsSend(c, payload); }
}
function pushChat(msg){
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_LIMIT);
  const payload = JSON.stringify(msg);
  for (const c of wss.clients) { if (c.readyState === 1) wsSend(c, payload); }
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
      try { wsSend(sock, JSON.stringify(msg)); } catch {}
    }
  }
  // Do NOT store in global chat history for viewers; admins will still see it within their session
}
function sendSelf(socket, meta){
  try { wsSend(socket, JSON.stringify({ type:'self', id: meta.id, guid: meta.guid, name: displayName(meta), color: meta.color })); } catch {}
}
function sendChatHistory(socket){
  const items = chatHistory.slice(-CHAT_HISTORY_SEND);
  wsSend(socket, JSON.stringify({ type:'chat-history', items }));
}

wss.on('close', ()=>{}); // noop placeholder (avoid accidental removal if refactoring)

wss.on('connection', (socket, req) => {
  let supplied=null;
  try { const u=new URL(req.url,'http://ws'); supplied = u.searchParams.get('key') || u.searchParams.get('admin'); } catch {}
  const auth = validateAccess({ suppliedKey: supplied, requestPath: req.url, adminKey: ADMIN_KEY });
  if (!auth.ok){ systemLog('auth','unauthorized-connection',{ path: req.url }); socket.close(1008,'unauthorized'); return; }
  if (auth.isAdmin && hasActiveAdmin()) { systemLog('auth','deny-second-admin',{}); try { socket.close(4003,'admin-already-active'); } catch {} return; }
  const meta = { id: nextClientId++, guid: genGuid(), color: assignColor(), lastSeen: Date.now(), msgTimes: [], isAdmin: auth.isAdmin, connectAt: Date.now(), lastPos: null, bytesIn:0, bytesOut:0, mediaBytes:0, msgsIn:0, msgsOut:0, lastRecvTs: Date.now(), lastSentTs: Date.now() };
  clientMeta.set(socket, meta);
  // Defensive: In extremely unlikely future async refactors, re-check single-admin invariant after insertion.
  if (meta.isAdmin) {
    let admins = 0; for (const m of clientMeta.values()) if (m.isAdmin) admins++;
    if (admins > 1) { systemLog('auth','post-add-second-admin-race',{}); try { socket.close(4003,'admin-already-active'); } catch {} clientMeta.delete(socket); return; }
  }
  systemLog('ws','client-connected',{ id: meta.id, color: meta.color, admin: meta.isAdmin });
  systemLog('ws','client-connected',{ id: meta.id, guid: meta.guid, color: meta.color, admin: meta.isAdmin });
  wsSend(socket, JSON.stringify({ type: 'state', data: lastBroadcast }));
  // Send presence + chat history
  sendChatHistory(socket);
  broadcastPresence();
  // System join message (broadcast) & self-only notice
  pushSystem((meta.color? meta.color : ('anon'+meta.id)) + ' joined');
  sendSelf(socket, meta);
  // Message handler (playback sync, chat, media selection, presence ping)
  socket.on('message', data => {
    const raw = data.toString();
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    const meta = clientMeta.get(socket); if (!meta) return;
    meta.lastSeen = now;
    meta.msgsIn = (meta.msgsIn||0)+1;
    meta.bytesIn = (meta.bytesIn||0) + Buffer.byteLength(raw);
    meta.lastRecvTs = now;
    switch(msg.type){
      case 'ping':
        // Presence updated above; respond with pong so client can schedule next ping
        try { wsSend(socket, JSON.stringify({ type:'pong', ts: now })); } catch {}
        break;
      case 'chat': {
        const text = (msg.text||'').toString().slice(0,500).trim();
        if (!text) break;
        // rate limit
        meta.msgTimes = meta.msgTimes.filter(t => now - t < CHAT_RATE_WINDOW_MS);
        if (meta.msgTimes.length >= CHAT_RATE_MAX) {
          // Guardrail: log once per second max per user when tripping limit
          if (!meta._lastRateLog || (now - meta._lastRateLog) > 1000) {
            systemLog('chat','rate-limit-hit',{ id: meta.id, color: meta.color, inWindow: meta.msgTimes.length, max: CHAT_RATE_MAX, windowMs: CHAT_RATE_WINDOW_MS });
            systemLog('chat','rate-limit-hit',{ id: meta.id, guid: meta.guid, color: meta.color, inWindow: meta.msgTimes.length, max: CHAT_RATE_MAX, windowMs: CHAT_RATE_WINDOW_MS });
            meta._lastRateLog = now;
          }
          try { wsSend(socket, JSON.stringify({ type:'error', error:'rate'})); } catch {}
          break;
        }
        meta.msgTimes.push(now);
        // Global burst window prune + push
        while (globalChatTimes.length && now - globalChatTimes[0] > CHAT_RATE_WINDOW_MS) globalChatTimes.shift();
        globalChatTimes.push(now);
        if (globalChatTimes.length > CHAT_RATE_MAX * 4) { // heuristic: >4x per-user max across all users in window
          if (!globalChatTimes._lastGlobalLog || (now - globalChatTimes._lastGlobalLog) > 3000) {
            systemLog('chat','global-burst',{ count: globalChatTimes.length, windowMs: CHAT_RATE_WINDOW_MS });
            globalChatTimes._lastGlobalLog = now;
          }
        }
        pushChat({ type:'chat', id: meta.id, name: displayName(meta), color: meta.color, text, ts: now });
        break; }
      case 'telemetry': {
        const ev = (msg.ev||'').toString().slice(0,80);
        if(!ev) break;
        let dataObj=null;
        if (msg.data && typeof msg.data === 'object') {
          try { dataObj = JSON.parse(JSON.stringify(msg.data)); } catch {}
        }
        logTelemetry(ev, meta, dataObj);
        // Surface selected stall events into system log for immediate observability
        if (ev === 'client-stall-start') {
          systemLog('perf','stall-start',{ id: meta.id, guid: meta.guid, ct: dataObj?.ct, rs: dataObj?.rs, ns: dataObj?.ns, buf: dataObj?.buf, drift: dataObj?.drift, rev: mediaRev });
        } else if (ev === 'client-stall-end') {
          systemLog('perf','stall-end',{ id: meta.id, guid: meta.guid, ct: dataObj?.ct, durMs: dataObj?.durMs, lostSec: dataObj?.lostSec, rs: dataObj?.rsEnd, ns: dataObj?.nsEnd, buf: dataObj?.bufEnd, drift: dataObj?.driftEnd, rev: mediaRev });
        }
        break; }
      case 'rename': {
        // Accept optional color & name; enforce uniqueness of color
        const newColor = msg.color && typeof msg.color === 'string' ? msg.color.toLowerCase() : null;
        let newNameRaw = msg.name && typeof msg.name === 'string' ? msg.name : '';
        if (newNameRaw.length > 80) newNameRaw = newNameRaw.slice(0,80);
        // Unicode-aware sanitize: allow letters (with diacritics), numbers, spaces & limited punctuation
        let newName = newNameRaw.normalize('NFC').replace(/[^\p{L}\p{N} \-'.!?,]/gu,'').trim();
        if (newName.length > 40) newName = newName.slice(0,40);
        let changed = false;
        if (newColor && COLOR_PALETTE.includes(newColor) && newColor !== meta.color) {
          // ensure not in use by someone else
            let inUse = false;
            for (const m of clientMeta.values()) { if (m !== meta && m.color === newColor) { inUse = true; break; } }
            if (inUse) { try { wsSend(socket, JSON.stringify({ type:'rename-result', ok:false, reason:'in-use' })); } catch {} break; }
            // release old, assign new
            releaseColor(meta.color);
            meta.color = newColor;
            colorsAvailable = colorsAvailable.filter(c=> c!==newColor); // ensure removed
            changed = true;
        }
        if (newName && newName !== meta.customName) { meta.customName = newName; changed = true; }
  if (!changed) { try { wsSend(socket, JSON.stringify({ type:'rename-result', ok:false, reason:'unchanged' })); } catch {} break; }
  try { wsSend(socket, JSON.stringify({ type:'rename-result', ok:true, color: meta.color, name: displayName(meta) })); } catch {}
        // update self meta to requester
        sendSelf(socket, meta);
        broadcastPresence();
        break; }
      case 'select': // deprecated in UI (was 'load')
      case 'load': {
        const isAdminMsg = (msg.admin === ADMIN_KEY || msg.key === ADMIN_KEY);
  if (!isAdminMsg) { systemLog('media','deny-load-not-admin',{ id: meta.id }); break; }
        if (msg.path && typeof msg.path === 'string') {
          const resolved = resolveMedia(mediaRoot, msg.path);
          if (resolved) {
            mediaFile = resolved.abs; mediaRel = resolved.rel; mediaRev++;
            // Reset per-revision request tracking
            fileRequestLogged.clear(); fileReceivedLogged.clear();
            lastBroadcast = { t:0, paused:true, ts: now, rev: mediaRev, path: mediaRel };
            // audio probe cache invalidation no longer needed (handled in helper)
            systemLog('media','load',{ path: mediaRel, rev: mediaRev });
            pushSystemAdmin(`media selected: ${mediaRel}`);
            broadcastState();
          } else {
            systemLog('media','load-fail-not-found',{ requested: msg.path });
          }
        }
        break; }
      case 'unload': {
        const isAdminMsg = (msg.admin === ADMIN_KEY || msg.key === ADMIN_KEY);
  if (!isAdminMsg) { systemLog('media','deny-unload-not-admin',{ id: meta.id }); break; }
        if (mediaFile) {
          systemLog('media','unload',{ path: mediaRel, rev: mediaRev });
          mediaFile = null; mediaRel = null; mediaRev++;
          fileRequestLogged.clear(); fileReceivedLogged.clear();
          lastBroadcast = { t:0, paused:true, ts: now, rev: mediaRev, path: mediaRel };
          // audio probe cache invalidation no longer needed (handled in helper)
          pushSystemAdmin('media unloaded (home)');
          broadcastState();
        }
        break; }
      case 'media-loaded': {
        // Client indicates it successfully loaded metadata for current media revision.
        const rev = typeof msg.rev === 'number' ? msg.rev : mediaRev;
        const key = meta.guid + '|' + rev;
        if (!fileReceivedLogged.has(key)) {
          fileReceivedLogged.add(key);
          systemLog('media','file-received',{ guid: meta.guid, id: meta.id, rev, attempt: msg.attempt });
        }
        break; }
      case 'play': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          const prev = lastBroadcast;
          lastBroadcast = { t: msg.t, paused:false, ts: now, rev: mediaRev, path: mediaRel };
          systemLog('media','play',{ fromT: prev.t, toT: lastBroadcast.t, rev: mediaRev });
          broadcastState();
        }
        break; }
      case 'pause': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          const prev = lastBroadcast;
          lastBroadcast = { t: msg.t, paused:true, ts: now, rev: mediaRev, path: mediaRel };
          systemLog('media','pause',{ fromT: prev.t, toT: lastBroadcast.t, rev: mediaRev });
          broadcastState();
        }
        break; }
      case 'seek': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          const prev = lastBroadcast;
          // Preserve previous paused state if client didn't explicitly send one (older clients)
          const pausedFlag = (typeof msg.paused === 'boolean') ? msg.paused : prev.paused;
          lastBroadcast = { t: msg.t, paused: pausedFlag, ts: now, rev: mediaRev, path: mediaRel };
          systemLog('media','seek',{ fromT: prev.t, toT: lastBroadcast.t, paused: lastBroadcast.paused, rev: mediaRev });
          broadcastState();
        }
        break; }
      case 'pos': {
        if (typeof msg.t === 'number' && msg.t >= 0) {
          meta.lastPos = { t: msg.t, ts: now };
        }
        break; }
      case 'status': {
        // Rich client self-report (viewer) with current playback metrics
        if (typeof msg.t === 'number' && msg.t >= 0) {
          meta.lastPos = { t: msg.t, ts: now };
        }
        if (!meta.status) meta.status = {};
        // Shallow copy only expected primitives to avoid trust of arbitrary objects
        if (typeof msg.paused === 'boolean') meta.status.paused = msg.paused;
        if (typeof msg.rev === 'number') meta.status.rev = msg.rev;
        if (typeof msg.dur === 'number') meta.status.dur = msg.dur;
        if (typeof msg.rs === 'number') meta.status.rs = msg.rs;
        if (typeof msg.ns === 'number') meta.status.ns = msg.ns;
        if (typeof msg.buf === 'number') meta.status.buf = msg.buf; // buffer ahead seconds
        meta.status._ts = now;
        break; }
      case 'tick': {
        // Deprecated: admin no longer sends periodic ticks (kept for backward compatibility / no-op)
        break; }
      case 'drift-alert': {
        if (meta.isAdmin) break; // ignore admin self reports
        if (typeof msg.drift === 'number' && Math.abs(msg.drift) > 30) {
          // Ephemeral admin-only notice (not stored in history)
          pushSystemAdmin(`User ${displayName(meta)} drifted ${msg.drift.toFixed(1)}s`);
        }
        break; }
    }
  });
  socket.on('close', (code, reasonBuf)=>{
    let reason = '';
    try { if (reasonBuf) reason = reasonBuf.toString(); } catch {}
  systemLog('ws','client-closed',{ id: meta.id, code, reason });
    const m = clientMeta.get(socket);
  if (m) { pushSystem((m.color? m.color: ('anon'+m.id)) + ' left'); releaseColor(m.color); clientMeta.delete(socket); broadcastPresence(); }
  });
  socket.on('error', err => {
  systemLog('error','client-error',{ id: meta.id, msg: err?.message });
  });
});

// Removed periodic heartbeat broadcast (sync now only on admin actions / joins)

// Presence timeout sweeper
const presenceInterval = setInterval(()=>{
  let changed=false; const now=Date.now();
  for (const [sock, meta] of [...clientMeta.entries()]) {
    const idle = now - meta.lastSeen;
    if (idle > PRESENCE_TIMEOUT_MS) {
  systemLog('presence','timeout',{ id: meta.id, idleMs: idle });
  systemLog('presence','timeout',{ id: meta.id, guid: meta.guid, idleMs: idle });
      pushSystem((meta.color? meta.color: ('anon'+meta.id)) + ' left');
      releaseColor(meta.color); clientMeta.delete(sock); try { sock.close(4000,'timeout'); } catch {}
      changed=true;
    }
  }
  if (changed) broadcastPresence();
}, PRESENCE_SWEEP_INTERVAL);

// Periodic performance snapshot (Phase 3 instrumentation)
const perfInterval = setInterval(()=>{
  if (!wss.clients.size) return;
  const now = Date.now();
  const clients=[];
  for (const meta of clientMeta.values()){
    const connectedMs = now - meta.connectAt;
    const sec = connectedMs>0 ? connectedMs/1000 : 1;
    const upBps = meta.bytesIn ? meta.bytesIn/sec : 0;
    const downBps = meta.bytesOut ? meta.bytesOut/sec : 0;
    let drift=null;
    if (meta.lastPos && mediaFile && !lastBroadcast.paused){
      let expected = lastBroadcast.t;
      let delta = (now - lastBroadcast.ts)/1000; if(delta<0) delta=0; expected += delta;
      drift = meta.lastPos.t - expected;
    }
    // One-off drift threshold logging (negative or positive) to root-cause stalls early
    if (drift!=null) {
      if (Math.abs(drift) > 10 && !meta._loggedDrift10) { meta._loggedDrift10 = true; systemLog('drift','client-drift-gt10',{ id: meta.id, guid: meta.guid, drift: Number(drift.toFixed(3)), rev: mediaRev }); }
      if (Math.abs(drift) > 30 && !meta._loggedDrift30) { meta._loggedDrift30 = true; systemLog('drift','client-drift-gt30',{ id: meta.id, guid: meta.guid, drift: Number(drift.toFixed(3)), rev: mediaRev }); }
    }
    clients.push({ id: meta.id, drift, upBps: Number(upBps.toFixed(1)), downBps: Number(downBps.toFixed(1)), msgsIn: meta.msgsIn||0, msgsOut: meta.msgsOut||0 });
  }
  systemLog('perf','snapshot',{ count: clients.length, clients });
}, 30000);

function broadcastState(){
  const payload = JSON.stringify({ type:'state', data: lastBroadcast });
  for (const c of wss.clients) { if (c.readyState === 1) wsSend(c, payload); }
}

// Lightweight telemetry endpoints for debugging client disconnects
app.get('/api/debug/clients', (_req,res)=>{
  const now = Date.now();
  let mediaNow = null;
  if (mediaFile && lastBroadcast) {
    mediaNow = lastBroadcast.t;
    if (!lastBroadcast.paused) {
      let delta = (now - lastBroadcast.ts)/1000; if (delta < 0) delta = 0; mediaNow += delta;
    }
  }
  const playing = !!(mediaFile && lastBroadcast && !lastBroadcast.paused);
  const expectedNow = mediaNow;
  let mediaTotalBytes = null; try { if (mediaFile) mediaTotalBytes = fs.statSync(mediaFile).size; } catch {}
  const clients=[];
  for (const [, meta] of clientMeta.entries()) {
    let drift=null, driftAgeMs=null;
    if (meta.lastPos && mediaNow!=null) {
      driftAgeMs = now - meta.lastPos.ts; if (driftAgeMs < 0) driftAgeMs = 0;
      let expectedAtSample = expectedNow - (playing ? (driftAgeMs/1000) : 0);
      if (expectedAtSample < 0) expectedAtSample = 0;
      drift = meta.lastPos.t - expectedAtSample;
    }
    const connectedMs = now - meta.connectAt;
    const sec = connectedMs>0 ? (connectedMs/1000) : 1;
    const combinedDown = (meta.bytesOut||0) + (meta.mediaBytes||0);
    const upBps = meta.bytesIn ? meta.bytesIn / sec : 0;
    const downBps = combinedDown ? combinedDown / sec : 0;
    // recent window samples
    if (meta._rateSampleTs == null) {
      meta._rateSampleTs = now; meta._bytesInSample = meta.bytesIn||0; meta._bytesOutSample = meta.bytesOut||0; meta._bytesOutSampleAll = combinedDown;
    }
    let rWindowMs = now - meta._rateSampleTs; if (rWindowMs <= 0) rWindowMs = 1;
    const deltaIn = (meta.bytesIn||0) - (meta._bytesInSample||0);
    const deltaDownWs = (meta.bytesOut||0) - (meta._bytesOutSample||0);
    const deltaDownAll = combinedDown - (meta._bytesOutSampleAll||0);
    const rUpBps = deltaIn>0 ? deltaIn / (rWindowMs/1000) : 0;
    const rDownBps = deltaDownAll>0 ? deltaDownAll / (rWindowMs/1000) : 0;
    // advance window
    meta._rateSampleTs = now; meta._bytesInSample = meta.bytesIn||0; meta._bytesOutSample = meta.bytesOut||0; meta._bytesOutSampleAll = combinedDown;
    clients.push({
      id: meta.id,
      color: meta.color,
      name: displayName(meta),
      isAdmin: !!meta.isAdmin,
      idleMs: now - meta.lastSeen,
      connectedMs,
      drift,
      driftAgeMs,
      bytesIn: meta.bytesIn||0,
      bytesOut: meta.bytesOut||0, // websocket outbound only
      mediaBytes: meta.mediaBytes||0,
      msgsIn: meta.msgsIn||0,
      msgsOut: meta.msgsOut||0,
      upBps: Number(upBps.toFixed(1)),
      downBps: Number(downBps.toFixed(1)), // combined ws + media
      rUpBps: Number(rUpBps.toFixed(1)),
      rDownBps: Number(rDownBps.toFixed(1)),
      lastPos: meta.lastPos||null,
      lastSentTs: meta.lastSentTs||null,
  lastRecvTs: meta.lastRecvTs||null,
  status: meta.status ? { ...meta.status } : null
    });
  }
  res.json({ count: clients.length, clients, serverNow: now, mediaNow, mediaPaused: !!(lastBroadcast && lastBroadcast.paused), mediaRev, mediaTotalBytes });
});
app.get('/api/debug/state', (_req,res)=>{
  res.json({ lastBroadcast, mediaFile: mediaFile? path.relative(process.cwd(), mediaFile): null, rev: mediaRev });
});

// Locate first playable file (prefer *.wp.mp4 then .webm) or use MEDIA_FILE env.
const ROOT = process.cwd();
// Only serve system-managed outputs (transcoded + subtitles) from media/output; raw user imports live elsewhere
const mediaRoot = config.media.outputDir;
// Audio probe now handled via lib/audio-probe.js (internal caching there)

// probeAudioStreams moved to lib/audio-probe.js
// (findFirst / resolveMedia removed: provided by lib/media-listing.js)
// Startup: DO NOT auto-load first media; begin on "home" (starfield) until admin selects a file.
systemLog('media','startup-home',{ loaded:false });

// Auth gate for index: require ?key=KEY (or ?admin=KEY) even for viewer mode.
// Also respect an offline sentinel file (state/offline.flag) to force 404 responses without stopping process.
const publicDir = path.join(__dirname, 'public');
const offlineFlag = path.join(process.cwd(),'state','offline.flag');
function isOffline(){ try { return fs.existsSync(offlineFlag); } catch { return false; } }
// Global offline kill-switch (returns 404 for everything when state/offline.flag exists)
app.use((req,res,next)=>{ if(isOffline()) { return res.status(404).send('Not Found'); } next(); });
function authGate(req, res, next){
  const supplied = req.query.key || req.query.admin;
  const auth = validateAccess({ suppliedKey: supplied, requestPath: req.path, adminKey: ADMIN_KEY });
  if (auth.ok) return next();
  const wanted = req.path === '/' ? '/' : req.path;
  const html = renderTemplate('access-denied.html', { WANTED: wanted });
  res.status(401).send(html || 'Unauthorized');
}
// Root redirect: send bare domain to /watchparty (no key param). If root has key/admin, preserve it.
app.get('/', (req,res,next)=>{
  const supplied = req.query.key || req.query.admin;
  if (!supplied) return res.redirect(302, '/watchparty');
  // If key present on root, redirect to canonical /watchparty preserving query string.
  const qs = Object.keys(req.query).length ? ('?' + new URLSearchParams(req.query).toString()) : '';
  return res.redirect(302, '/watchparty' + qs);
});
// Viewer & admin entry paths (all mapped to same SPA index)
app.get(config.routes.viewer, authGate, (req,res)=> res.sendFile(path.join(publicDir,'index.html')));
app.get(config.routes.admin, authGate, (req,res)=> {
  if (hasActiveAdmin()) {
    const html = renderTemplate('admin-active.html', { TIMEOUT_S: Math.ceil(PRESENCE_TIMEOUT_MS/1000) });
    return res.status(409).send(html || 'Admin already active');
  }
  res.sendFile(path.join(publicDir,'index.html'));
});
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
  const guid = (req.query && typeof req.query.guid==='string') ? req.query.guid : null;
  if (guid) {
    const key = guid + '|' + mediaRev;
    if (!fileRequestLogged.has(key)) {
      fileRequestLogged.add(key);
      systemLog('media','file-request',{ guid, rev: mediaRev, range: !!range });
    }
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mediaFile.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4');
  if (!range) {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.status(200).end();
    // Attribute full file streaming to client (first request usually a range; this is fallback)
    if (guid) {
      for (const [sock, meta] of clientMeta.entries()) { if (meta.guid === guid) { meta.mediaBytes += total; break; } }
    }
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
  // Attribute served range bytes to requesting client
  if (guid) {
    const served = (end - start + 1);
    for (const [sock, meta] of clientMeta.entries()) { if (meta.guid === guid) { meta.mediaBytes += served; break; } }
  }
  fs.createReadStream(mediaFile, { start, end }).pipe(res);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, file: mediaFile ? path.relative(ROOT, mediaFile) : null }));
app.get('/admin-key', (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'forbidden' });
  res.json({ key: ADMIN_KEY });
});
// List media files (admin can choose path)
app.get('/api/files', (_req,res) => {
  res.json(listMedia(mediaRoot));
});

// Expose character color metadata so frontend doesn't need hardcoded duplicate
app.get('/api/colors', (_req, res) => {
  res.json({ palette: COLOR_PALETTE, hex: COLOR_HEX });
});

// Subtitle route with cross-variant language selection & sanitization
app.get('/media/current.vtt', (req, res) => {
  const r = buildSubtitleResponse(mediaFile, req.query.lang);
  if (r.headers) { for (const [k,v] of Object.entries(r.headers)) res.setHeader(k,v); }
  if (r.status !== 200) return res.status(r.status).end();
  if (req.method === 'HEAD') return res.status(200).end();
  res.send(r.body);
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
    const sidecarPrefixRe = new RegExp('^' + escPrefix + '\.' + 'audio' + '\.([a-z0-9_-]{2,8})(?:\.[^.]+)?\\.(m4a|aac|mp4)$','i');
    const sidecarEpisodeRe = epKey ? new RegExp('audio\\.([a-z0-9_-]{2,8})(?:\.[^.]+)?\\.(m4a|aac|mp4)$','i') : null;
    const byLang = new Map();
    for (const f of files) {
      const low = f.toLowerCase();
      if (!(low.endsWith('.m4a') || low.endsWith('.aac') || low.endsWith('.mp4'))) continue;
      let lang=null; let preferred=false; let m=f.match(sidecarPrefixRe);
      if (m) { lang = m[1].toLowerCase(); preferred=true; }
      else if (epKey && low.includes(epKey) && sidecarEpisodeRe && (m=f.match(sidecarEpisodeRe))) {
        if (low.includes(epKey)) { lang = m[1].toLowerCase(); }
      }
      if (!lang) continue;
      if (byLang.has(lang)) {
        const existing = byLang.get(lang);
        if (existing.preferred) continue;
        if (preferred || !existing.preferred) byLang.set(lang,{ file:f, preferred });
      } else byLang.set(lang,{ file:f, preferred });
    }
    for (const [lang, info] of byLang.entries()) {
      sidecars.push({ logical: sidecars.length, lang, title:'', sample_rate:null, default:false, url:`/media/output/${encodeURIComponent(path.relative(path.join(process.cwd(),'media','output'), path.join(dir,info.file)).replace(/\\/g,'/'))}`, kind:'sidecar', preferred: info.preferred });
    }
  } catch {}
  if (sidecars.length) {
    const eng = sidecars.find(t=> /^(eng|en)$/i.test(t.lang));
    if (eng) eng.default = true; else sidecars[0].default = true;
    return res.json({ tracks: sidecars, rev: mediaRev });
  }
  const embedded = probeAudioStreams(mediaFile).map((t,i)=> ({ ...t, logical:i, kind:'embedded', url:null }));
  res.json({ tracks: embedded, rev: mediaRev });
});

// List available subtitle tracks for current media (JSON for UI)
app.get('/media/current-subs.json', (_req,res)=>{
  const tracks = enumerateSubtitleTracks(mediaFile);
  res.json({ tracks, rev: mediaRev });
});

// (listMedia implementation removed; provided by lib/media-listing.js)

// Graceful shutdown summary (Phase 5)
let shuttingDown = false;
function shutdownSummary(signal){
  if (shuttingDown) return; shuttingDown = true;
  try {
    const now = Date.now();
    const uptimeMs = now - processStartTs;
    const clientsArr = [];
    for (const meta of clientMeta.values()) {
      clientsArr.push({ id: meta.id, color: meta.color, admin: !!meta.isAdmin, msgsIn: meta.msgsIn||0, msgsOut: meta.msgsOut||0 });
    }
    const mem = process.memoryUsage?.() || {};
    systemLog('perf','shutdown-summary',{
      signal, uptimeMs, clientCount: clientsArr.length, clients: clientsArr, mediaPath: mediaRel, mediaRev,
      rss: mem.rss, heapUsed: mem.heapUsed
    });
  } catch(e){ systemLog('error','shutdown-summary-fail',{ msg: e?.message }); }
  try { clearInterval(presenceInterval); } catch{}
  try { clearInterval(perfInterval); } catch{}
  try { for (const c of wss.clients) { try { c.close(1001,'server-shutdown'); } catch{} } } catch{}
  let forced=false;
  setTimeout(()=>{ if(!forced){ forced=true; systemLog('perf','shutdown-forced',{}); process.exit(0);} }, 2500);
  try { server.close(()=>{ if(!forced){ forced=true; process.exit(0);} }); } catch { if(!forced){ forced=true; process.exit(0);} }
}
['SIGINT','SIGTERM'].forEach(sig=>{ try { process.on(sig, ()=> shutdownSummary(sig)); } catch{} });

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(port, () => console.log(`listening http://localhost:${port} (ADMIN_KEY=${ADMIN_KEY})`));
