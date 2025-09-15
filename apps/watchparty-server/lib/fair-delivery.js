// Fair Delivery Module
// Encapsulates fairness-based media range scheduling, head cache management, env parsing,
// metrics sampling, drift detection of FAIR_* env vars, and debug info generation.
// Default enabled unless process.env.FAIR_DELIVERY === '0'.

import fs from 'fs';
import path from 'path';
import { systemLog, logTelemetry, TELEMETRY_EVENTS } from './logging.js';

// --- Environment Parsing ---
function parsePositiveInt(name, def){
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) { systemLog('error','bad-env',{ name, value: raw }); return def; }
  return Math.floor(n);
}

const DEFAULTS = {
  FAIR_MAX_REQUEST_BYTES: 1024*1024,
  FAIR_CHUNK_BYTES: 512*1024,
  FAIR_RATE_CAP_BPS: 0,
  CONTENT_BITRATE_BPS: 0,
  HOT_CACHE_BYTES: 0,
  FAIR_MAX_AHEAD_SEC: 0
};

let CONFIG = {};
let ENABLED = true;
let _envSnapshot = {};
let _lastConfigCheckTs = Date.now();
let _configDriftDetected = false;

// Stats
const fairnessStats = {
  enqueued: 0,
  truncations: 0,
  completed: 0,
  aborted: 0,
  chunkServes: 0,
  cacheHits: 0,
  cacheMiss: 0,
  aheadDeferred: 0,
  rateLimited: 0,
  lastLogTs: 0
};

// Sampling & EWMA
const SAMPLE_CAP = 500;
const samples = { queueWaitMs: [], chunkServeMs: [] };
const ewma = { queueWaitMs: 0, chunkServeMs: 0 };
function recordSample(key, v){ if(v==null) return; const arr=samples[key]; if(!arr) return; arr.push(v); if(arr.length>SAMPLE_CAP) arr.splice(0,arr.length-SAMPLE_CAP); }
function pct(arr,p){ if(!arr.length) return 0; const sorted=[...arr].sort((a,b)=>a-b); const idx=Math.min(sorted.length-1, Math.floor(p*(sorted.length-1))); return sorted[idx]; }
function updEwma(key, sample){ if(sample==null) return; const alpha=0.2; if(!ewma[key]) ewma[key]=sample; else ewma[key]=ewma[key]+alpha*(sample-ewma[key]); }

// Head cache
let headCache = { buf:null, length:0 };
function ensureHeadCache(mediaFile){
  if (!CONFIG.HOT_CACHE_BYTES || headCache.buf) return;
  try {
    if (mediaFile && fs.existsSync(mediaFile)) {
      const want = CONFIG.HOT_CACHE_BYTES;
      const fd = fs.openSync(mediaFile,'r');
      const b = Buffer.allocUnsafe(want);
      const { bytesRead } = fs.readSync(fd,b,0,want,0);
      fs.closeSync(fd);
      headCache.buf = bytesRead === want ? b : b.subarray(0,bytesRead);
      headCache.length = bytesRead;
      systemLog('media','head-cache-build',{ bytes: bytesRead });
    }
  } catch(e){ systemLog('error','head-cache-fail',{ msg:e?.message }); }
}
function invalidateHeadCache(){ headCache = { buf:null,length:0 }; }

// Per-client scheduling state
const fairClient = new Map(); // guid -> { queue, deficit, lastActiveTs, tokens, lastRefill }
const fairOrder = [];
function ensureFairClient(guid){ let fc=fairClient.get(guid); if(!fc){ fc={ queue:[], deficit:0, lastActiveTs:Date.now(), tokens:0, lastRefill:Date.now() }; fairClient.set(guid,fc); fairOrder.push(guid); } return fc; }
function resetFairState(){ fairClient.clear(); fairOrder.length=0; }

let fairRunning=false;
function scheduleFairRun(){ if(!ENABLED) return; if(fairRunning) return; fairRunning=true; setImmediate(fairProcessLoop); }

function logFairEvent(ev, meta, extra){
  const now = Date.now();
  const throttleable = ev==='media-range-enqueue' || ev==='media-range-truncate';
  if (throttleable && meta) {
    const keyTsField = ev==='media-range-enqueue'? '_lastFairEnqLogTs':'_lastFairTruncLogTs';
    const last = meta[keyTsField]||0; if(now-last<250) return; meta[keyTsField]=now;
  }
  systemLog('media', ev, Object.assign({ id: meta?.id, guid: meta?.guid, rev: CURRENT_MEDIA.rev }, extra||{}));
}

// Current media context (injected from server)
const CURRENT_MEDIA = { rev:0 };

function fairProcessLoop(){
  try {
    if(!ENABLED){ fairRunning=false; return; }
    let active=false; const quantum = CONFIG.FAIR_CHUNK_BYTES; const now=Date.now();
    if(!fairProcessLoop._lastRunTs) fairProcessLoop._lastRunTs=now; const gapMs = now - fairProcessLoop._lastRunTs;
    if(gapMs>1200 && gapMs<10000){ if(!fairProcessLoop._lastGapLogTs || (now-fairProcessLoop._lastGapLogTs)>3000){ fairProcessLoop._lastGapLogTs=now; systemLog('perf','media-chunk-gap',{ gapMs, rev: CURRENT_MEDIA.rev }); } }
    fairProcessLoop._lastRunTs=now;
    for(let i=0;i<fairOrder.length;i++){
      const guid=fairOrder[i]; const fc=fairClient.get(guid); if(!fc || !fc.queue.length) continue; active=true;
      if(fc.deficit<1) fc.deficit+=quantum; const job=fc.queue[0]; if(!job || job.res.writableEnded){ fc.queue.shift(); i--; continue; }
      const remaining = job.end - job.current + 1; if(remaining<=0){ fc.queue.shift(); fairnessStats.completed++; if(job.metaRef) logFairEvent('media-range-complete', job.metaRef, { bytes: job.len }); try{ job.res.end(); }catch{} i--; continue; }
      if(fc.deficit<=0) continue;
      if(CONFIG.FAIR_MAX_AHEAD_SEC && (CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS) && job.getBroadcast){
        const lastBroadcast = job.getBroadcast();
        if(lastBroadcast){ let bitrate = CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS; let curT = lastBroadcast.t; if(!lastBroadcast.paused){ let delta=(now-lastBroadcast.ts)/1000; if(delta<0) delta=0; curT+=delta; }
          const allowedT = curT + CONFIG.FAIR_MAX_AHEAD_SEC; const allowedBytes = Math.floor(bitrate*allowedT);
          if(job.start > allowedBytes){ fairnessStats.aheadDeferred++; if(job.metaRef){ const m=job.metaRef; const lt=m._lastAheadGateDeferTs||0; if(now-lt>1000){ m._lastAheadGateDeferTs=now; try{ logTelemetry(TELEMETRY_EVENTS.AHEAD_GATE_DEFER, m, { start: job.start, allowedBytes }); }catch{} } } continue; }
        }
      }
      if(CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS){
        const fillRate = CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS; const elapsedMs = now - fc.lastRefill; if(elapsedMs>0){ const add = (fillRate*elapsedMs)/1000; fc.tokens += add; const cap = fillRate; if(fc.tokens>cap) fc.tokens = cap; fc.lastRefill = now; }
        if(fc.tokens<=0){ fairnessStats.rateLimited++; if(job.metaRef){ const m=job.metaRef; const lt=m._lastRateLimitHitTs||0; if(now-lt>1000){ m._lastRateLimitHitTs=now; try{ logTelemetry(TELEMETRY_EVENTS.RATE_LIMIT_HIT, m, { remaining:0 }); }catch{} } } continue; }
      }
      const toSend = Math.min(remaining, Math.min(fc.deficit, quantum)); let allowed = toSend;
      if((CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS) && fc.tokens < allowed){ allowed = Math.max(0, Math.floor(fc.tokens)); if(allowed<1){ fairnessStats.rateLimited++; continue; } }
      const sendStart=Date.now();
      try {
  // fs.readSync (fd variant) returns a number, not an object. Previous destructuring produced bytesRead=undefined -> NaN propagation.
  const fd=fs.openSync(job.mediaFile,'r'); const buf=Buffer.allocUnsafe(allowed); const bytesRead = fs.readSync(fd, buf, 0, allowed, job.current); fs.closeSync(fd);
        if(bytesRead<=0){ fc.queue.shift(); fairnessStats.aborted++; if(job.metaRef) logFairEvent('media-range-abort', job.metaRef, { reason:'eof-unexpected' }); try{ job.res.end(); }catch{} i--; continue; }
        job.current += bytesRead; fc.deficit -= bytesRead; if(CONFIG.FAIR_RATE_CAP_BPS || CONFIG.CONTENT_BITRATE_BPS){ fc.tokens -= bytesRead; if(fc.tokens<0) fc.tokens=0; }
        fairnessStats.chunkServes++; if(job.metaRef){ job.metaRef.mediaBytes += bytesRead; job.metaRef._lastRange = { start: job.start, end: job.end, bytes: job.len, ts: Date.now() }; job.metaRef._rangeCount = (job.metaRef._rangeCount||0)+1; }
        updEwma('chunkServeMs', Date.now()-sendStart); recordSample('chunkServeMs', Date.now()-sendStart);
        if(!job._firstChunkSent){ job._firstChunkSent=true; const q=Date.now()-job.enqueueTs; updEwma('queueWaitMs', q); recordSample('queueWaitMs', q); }
        try {
          const dur=Date.now()-sendStart; const first=!!job._firstChunkSent && job._firstChunkSent!=='logged'; const qWait = first ? (job._queueLoggedWait || (Date.now()-job.enqueueTs)) : undefined; if(first) job._firstChunkSent='logged';
          if(Number.isFinite(bytesRead) && bytesRead>0){
            systemLog('media','media-chunk-serve',{ id: job.metaRef?.id, guid: job.metaRef?.guid, rev: CURRENT_MEDIA.rev, start: job.current-bytesRead, end: job.current-1, bytes: bytesRead, durMs: dur, first, queueWaitMs: qWait });
          }
        } catch{}
        if(!job.res.write(buf)){ job.res.once('drain', ()=> scheduleFairRun()); }
      } catch(e){ fc.queue.shift(); fairnessStats.aborted++; if(job.metaRef) logFairEvent('media-range-abort', job.metaRef, { reason:'read-error', msg:e?.message }); try{ job.res.end(); }catch{} i--; continue; }
    }
    if(active){ setImmediate(fairProcessLoop); } else { fairRunning=false; }
  } catch(e){ fairRunning=false; systemLog('error','fair-loop-crash',{ msg:e?.message }); }
}

// Public API
export function initFairDelivery(){
  ENABLED = process.env.FAIR_DELIVERY === '0' ? false : true; // default ON
  CONFIG = {
    FAIR_MAX_REQUEST_BYTES: parsePositiveInt('FAIR_MAX_REQUEST_BYTES', DEFAULTS.FAIR_MAX_REQUEST_BYTES),
    FAIR_CHUNK_BYTES: parsePositiveInt('FAIR_CHUNK_BYTES', DEFAULTS.FAIR_CHUNK_BYTES),
    FAIR_RATE_CAP_BPS: parsePositiveInt('FAIR_RATE_CAP_BPS', DEFAULTS.FAIR_RATE_CAP_BPS),
    CONTENT_BITRATE_BPS: parsePositiveInt('CONTENT_BITRATE_BPS', DEFAULTS.CONTENT_BITRATE_BPS),
    HOT_CACHE_BYTES: parsePositiveInt('HOT_CACHE_BYTES', DEFAULTS.HOT_CACHE_BYTES),
    FAIR_MAX_AHEAD_SEC: parsePositiveInt('FAIR_MAX_AHEAD_SEC', DEFAULTS.FAIR_MAX_AHEAD_SEC)
  };
  _envSnapshot = { ENABLED, ...CONFIG };
  systemLog('media','fair-config',{ enabled: ENABLED, ...CONFIG });
  if (CONFIG.FAIR_CHUNK_BYTES > CONFIG.FAIR_MAX_REQUEST_BYTES) { systemLog('error','env-inconsistent',{ msg:'FAIR_CHUNK_BYTES > FAIR_MAX_REQUEST_BYTES', FAIR_CHUNK_BYTES: CONFIG.FAIR_CHUNK_BYTES, FAIR_MAX_REQUEST_BYTES: CONFIG.FAIR_MAX_REQUEST_BYTES }); }
  if (CONFIG.HOT_CACHE_BYTES && CONFIG.HOT_CACHE_BYTES < CONFIG.FAIR_CHUNK_BYTES) { systemLog('error','env-hot-cache-too-small',{ HOT_CACHE_BYTES: CONFIG.HOT_CACHE_BYTES, FAIR_CHUNK_BYTES: CONFIG.FAIR_CHUNK_BYTES }); }
  if (CONFIG.FAIR_MAX_AHEAD_SEC && !(CONFIG.CONTENT_BITRATE_BPS || CONFIG.FAIR_RATE_CAP_BPS)) { systemLog('error','env-ahead-without-bitrate',{ FAIR_MAX_AHEAD_SEC: CONFIG.FAIR_MAX_AHEAD_SEC }); }
  setInterval(()=>{ // drift detection
    const now=Date.now(); _lastConfigCheckTs=now;
    if(_configDriftDetected) return;
    const cur = {
      ENABLED: process.env.FAIR_DELIVERY === '0' ? false : true,
      FAIR_MAX_REQUEST_BYTES: parseInt(process.env.FAIR_MAX_REQUEST_BYTES||'')||CONFIG.FAIR_MAX_REQUEST_BYTES,
      FAIR_CHUNK_BYTES: parseInt(process.env.FAIR_CHUNK_BYTES||'')||CONFIG.FAIR_CHUNK_BYTES,
      FAIR_RATE_CAP_BPS: parseInt(process.env.FAIR_RATE_CAP_BPS||'')||CONFIG.FAIR_RATE_CAP_BPS,
      CONTENT_BITRATE_BPS: parseInt(process.env.CONTENT_BITRATE_BPS||'')||CONFIG.CONTENT_BITRATE_BPS,
      HOT_CACHE_BYTES: parseInt(process.env.HOT_CACHE_BYTES||'')||CONFIG.HOT_CACHE_BYTES,
      FAIR_MAX_AHEAD_SEC: parseInt(process.env.FAIR_MAX_AHEAD_SEC||'')||CONFIG.FAIR_MAX_AHEAD_SEC
    };
    for(const k of Object.keys(_envSnapshot)){
      if(_envSnapshot[k] !== cur[k]){ _configDriftDetected=true; systemLog('media','fair-config-drift',{ key:k, from:_envSnapshot[k], to:cur[k] }); if(k==='HOT_CACHE_BYTES' && cur.HOT_CACHE_BYTES < _envSnapshot.HOT_CACHE_BYTES){ invalidateHeadCache(); systemLog('media','head-cache-evict-drift',{ from:_envSnapshot.HOT_CACHE_BYTES, to: cur.HOT_CACHE_BYTES }); } break; }
    }
  }, 30000);
}

export function setMediaRevision(rev){ CURRENT_MEDIA.rev = rev; }
export function resetPerMediaRevision(){ fairnessStats.enqueued=0; fairnessStats.truncations=0; fairnessStats.completed=0; fairnessStats.aborted=0; fairnessStats.chunkServes=0; fairnessStats.cacheHits=0; fairnessStats.cacheMiss=0; fairnessStats.aheadDeferred=0; fairnessStats.rateLimited=0; invalidateHeadCache(); }

export function serveRange({ req, res, mediaFile, metaLookup, lastBroadcastFn }){
  if(!mediaFile || !fs.existsSync(mediaFile)){ res.status(404).send('No media'); return; }
  let stat; try { stat = fs.statSync(mediaFile); } catch { res.status(404).end(); return; }
  const total = stat.size; const range = req.headers.range; const guid = (req.query && typeof req.query.guid==='string')? req.query.guid : null;
  res.setHeader('Accept-Ranges','bytes'); res.setHeader('Content-Type', mediaFile.toLowerCase().endsWith('.webm')? 'video/webm':'video/mp4');
  if(!range){ res.setHeader('Content-Length', total); if(req.method==='HEAD') return res.status(200).end(); if(guid){ const meta = metaLookup(guid); if(meta) meta.mediaBytes += total; } return fs.createReadStream(mediaFile).pipe(res); }
  const m=/bytes=(\d*)-(\d*)/.exec(range); if(!m){ res.status(416).end(); return; }
  let start = m[1]? parseInt(m[1],10):0; let end = m[2]? parseInt(m[2],10): total-1; if(isNaN(start)||isNaN(end)||start>end||end>=total){ res.status(416).setHeader('Content-Range',`bytes */${total}`).end(); return; }
  if(!ENABLED){ // legacy fallthrough direct stream
    res.status(206); res.setHeader('Content-Range',`bytes ${start}-${end}/${total}`); res.setHeader('Content-Length', end-start+1); if(req.method==='HEAD') return res.end(); if(guid){ const meta = metaLookup(guid); if(meta){ const served=end-start+1; meta.mediaBytes += served; meta._lastRange={ start,end,bytes:served,ts:Date.now() }; meta._rangeCount=(meta._rangeCount||0)+1; } } return fs.createReadStream(mediaFile,{ start,end }).pipe(res);
  }
  fairnessStats.enqueued++; let metaRef=null; if(guid){ metaRef = metaLookup(guid); }
  logFairEvent('media-range-enqueue', metaRef, { start, end, bytes:end-start+1 });
  const reqBytes = end - start + 1; if(reqBytes > CONFIG.FAIR_MAX_REQUEST_BYTES){ const newEnd = start + CONFIG.FAIR_MAX_REQUEST_BYTES - 1; fairnessStats.truncations++; logFairEvent('media-range-truncate', metaRef, { start, endOriginal:end, endTrunc:newEnd, origBytes:reqBytes, newBytes:CONFIG.FAIR_MAX_REQUEST_BYTES }); end = newEnd; }
  if(CONFIG.HOT_CACHE_BYTES) ensureHeadCache(mediaFile); if(headCache.buf && end < headCache.length){ fairnessStats.cacheHits++; res.status(206); res.setHeader('Content-Range',`bytes ${start}-${end}/${total}`); res.setHeader('Content-Length', end-start+1); if(req.method==='HEAD') return res.end(); try { const slice=headCache.buf.subarray(start,end+1); if(metaRef){ metaRef.mediaBytes += slice.length; metaRef._lastRange={ start,end,bytes:slice.length,ts:Date.now() }; metaRef._rangeCount=(metaRef._rangeCount||0)+1; } res.end(slice); if(metaRef) logFairEvent('media-range-complete', metaRef, { bytes:slice.length, cache:true }); return; } catch(e){ systemLog('error','head-cache-serve-fail',{ msg:e?.message }); } }
  else if(CONFIG.HOT_CACHE_BYTES){ fairnessStats.cacheMiss++; }
  res.status(206); res.setHeader('Content-Range',`bytes ${start}-${end}/${total}`); res.setHeader('Content-Length', end-start+1); if(req.method==='HEAD') return res.end();
  const job = { guid, start, end, current:start, res, metaRef, truncated:false, enqueueTs:Date.now(), len:end-start+1, mediaFile, getBroadcast: lastBroadcastFn };
  ensureFairClient(guid || ('noguid-'+Math.random())); const fc = fairClient.get(job.guid); fc.queue.push(job);
  let aborted=false; function abortJob(reason){ if(aborted) return; aborted=true; const idx=fc.queue.indexOf(job); if(idx!==-1) fc.queue.splice(idx,1); fairnessStats.aborted++; if(job.metaRef) logFairEvent('media-range-abort', job.metaRef, { reason }); try{ if(!res.writableEnded) res.end(); }catch{} }
  res.on('close', ()=>{ if(job.current <= job.end) abortJob('client-close'); }); res.on('error', ()=> abortJob('res-error'));
  scheduleFairRun();
}

export function getDeliveryDebugInfo(mediaFile, clientMeta){
  let mediaTotalBytes=null; try { if(mediaFile) mediaTotalBytes=fs.statSync(mediaFile).size; } catch{}
  const perClient=[]; for(const [,meta] of clientMeta.entries()){ const fc = fairClient.get(meta.guid); perClient.push({ id: meta.id, guid: meta.guid, color: meta.color, mediaBytes: meta.mediaBytes||0, percent: (mediaTotalBytes && meta.mediaBytes!=null)? (meta.mediaBytes/mediaTotalBytes): null, lastRange: meta._lastRange||null, rangeCount: meta._rangeCount||0, pending: fc? fc.queue.length:0, deficit: fc? fc.deficit:0, tokensRemaining: fc? Math.floor(fc.tokens||0): null }); }
  return { enabled: ENABLED, chunkBytes: ENABLED? CONFIG.FAIR_CHUNK_BYTES:null, maxReqBytes: ENABLED? CONFIG.FAIR_MAX_REQUEST_BYTES:null, hotCacheBytes: ENABLED? (CONFIG.HOT_CACHE_BYTES||0):0, rateCapBps: ENABLED? (CONFIG.FAIR_RATE_CAP_BPS||null): null, contentBitrateBps: ENABLED? (CONFIG.CONTENT_BITRATE_BPS||null): null, aheadSec: ENABLED? (CONFIG.FAIR_MAX_AHEAD_SEC||null): null, counters: ENABLED? fairnessStats: null, metrics: ENABLED? { ewmaQueueWaitMs: Number(ewma.queueWaitMs?.toFixed(2)||0), ewmaChunkServeMs: Number(ewma.chunkServeMs?.toFixed(2)||0) }: null, perClient, samples: ENABLED? { queueWait: { p50:Number(pct(samples.queueWaitMs,0.50).toFixed(2)), p95:Number(pct(samples.queueWaitMs,0.95).toFixed(2)), p99:Number(pct(samples.queueWaitMs,0.99).toFixed(2)), count: samples.queueWaitMs.length }, chunkServe: { p50:Number(pct(samples.chunkServeMs,0.50).toFixed(2)), p95:Number(pct(samples.chunkServeMs,0.95).toFixed(2)), p99:Number(pct(samples.chunkServeMs,0.99).toFixed(2)), count: samples.chunkServeMs.length } }: null, mediaTotalBytes, serverNow: Date.now(), lastConfigCheckTs: _lastConfigCheckTs, configDriftDetected: _configDriftDetected };
}

export function isFairEnabled(){ return ENABLED; }
export function invalidateHeadCachePublic(){ invalidateHeadCache(); }

