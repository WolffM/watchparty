import fs from 'fs';
import path from 'path';

// --- Base Paths / Directories ----------------------------------------------
// Allow overriding base state dir (for tests) and enabling sync writes to avoid losing
// events when process exits immediately after logging.
const STATE_DIR = process.env.WP_STATE_DIR || path.join(process.cwd(),'state');
const LOG_DIR = path.join(STATE_DIR,'logs');
const telemetryLogPath = path.join(LOG_DIR,'telemetry.log');
const combinedLogPath = path.join(LOG_DIR,'combined.log'); // JSONL aggregator (system+telemetry+client)
// Compute dated system log filename (system-YYYY-MM-DD[ -N].log) at module load.
function computeSystemLogPath(){
  const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  ensureLogsDir();
  let base = path.join(LOG_DIR, `system-${today}.log`);
  if(!fs.existsSync(base)) return base;
  // Enumerate to avoid clobbering previous run logs (system-YYYY-MM-DD-1.log, -2, ...)
  let idx = 1;
  while(true){
    const candidate = path.join(LOG_DIR, `system-${today}-${idx}.log`);
    if(!fs.existsSync(candidate)) return candidate;
    idx++;
    if(idx>9999) { return path.join(LOG_DIR, `system-${today}-overflow.log`); }
  }
}
const systemLogPath = computeSystemLogPath();
// Maintain lightweight per-origin fanout (localhost/cloudflared/direct) without altering main filename logic.
// We derive origin from fields.origin when present; only a small set of tags allowed for safety.
const ORIGIN_TAGS = new Set(['localhost','cloudflared','direct']);
const TELEMETRY_SYNC = process.env.TELEMETRY_SYNC === '1' || process.env.NODE_ENV === 'test';
const SYSTEM_SYNC = process.env.SYSTEM_LOG_SYNC === '1'; // optional explicit sync for system log
const SYSTEM_DISABLE_FILE = process.env.SYSTEM_LOG_DISABLE_FILE === '1'; // allow opting out of file writes
const TELEMETRY_MIRROR_SYSTEM = process.env.TELEMETRY_MIRROR_SYSTEM === '1'; // mirror telemetry into system category for single-file review
const COMBINED_DISABLE = process.env.COMBINED_LOG_DISABLE === '1'; // allow disabling combined aggregator

function ensureLogsDir(){
  try { if(!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR,{recursive:true}); } catch {/* ignore */}
}
function ensureTelemetryDir(){ ensureLogsDir(); }

// Centralized event name suggestions to reduce future typos. Not strictly enforced yet.
export const TELEMETRY_EVENTS = Object.freeze({
  UI_PLAY_CLICK: 'ui-play-click',
  UI_PAUSE_CLICK: 'ui-pause-click',
  UI_SEEK_SLIDER: 'ui-seek-slider',
  RENAME_ATTEMPT: 'rename-attempt',
  RENAME_SUCCESS: 'rename-success',
  SUBTITLE_SWITCH: 'subtitle-switch',
  AUDIO_TRACK_SWITCH: 'audio-track-switch',
  DRIFT_CORRECTION: 'drift-correction',
  RATE_LIMIT_HIT: 'rate-limit-hit',
  CLIENT_ERROR: 'client-error',
  VISIBILITY_CHANGE: 'visibility-change',
  RECONNECT_ATTEMPT: 'reconnect-attempt',
  AHEAD_GATE_DEFER: 'ahead-gate-defer',
  AHEAD_GATE_HIT: 'ahead-gate-hit'
  , CLIENT_WAITING: 'client-waiting'
  , CLIENT_RESUME: 'client-resume'
});

function appendCombined(obj){
  if (COMBINED_DISABLE) return;
  try {
    ensureLogsDir();
    const line = JSON.stringify(obj)+'\n';
    if (TELEMETRY_SYNC || SYSTEM_SYNC) { try { fs.appendFileSync(combinedLogPath, line); } catch {/* ignore */} }
    else { fs.appendFile(combinedLogPath, line, ()=>{}); }
  } catch{/* ignore */}
}

export function logTelemetry(ev, meta, data){
  try {
    ensureTelemetryDir();
    const entry = { ts: new Date().toISOString(), ev, id: meta?.id, guid: meta?.guid, color: meta?.color, admin: !!meta?.isAdmin, data };
    const line = JSON.stringify(entry)+'\n';
    if (TELEMETRY_SYNC) {
      try { fs.appendFileSync(telemetryLogPath, line); } catch (err) { console.warn('[telemetry] write fail (sync)', err.message); }
    } else {
      fs.appendFile(telemetryLogPath, line, err=>{ if(err) console.warn('[telemetry] write fail', err.message); });
    }
    appendCombined({ src:'telemetry', ...entry });
    if (TELEMETRY_MIRROR_SYSTEM) {
      systemLog('telemetry', ev, { id: meta?.id, guid: meta?.guid, color: meta?.color, admin: !!meta?.isAdmin, data });
    }
  } catch (e) {
    console.warn('[telemetry] failure', e?.message);
  }
}


// --- System Log Wrapper (Phase 1 stub) -------------------------------------
// Persist system log lines to file (single-line) while still emitting to stdout.
export function systemLog(category, message, fields){
  try {
    let kv='';
  if (fields && typeof fields === 'object') {
      const parts=[]; for (const [k,v] of Object.entries(fields)) { if (v === undefined) continue; parts.push(`${k}=${JSON.stringify(v)}`); }
      if (parts.length) kv = ' ' + parts.join(' ');
    }
    const line = `[SYSTEM] ${category}${kv} ${message}`;
    console.log(line);
    if (!SYSTEM_DISABLE_FILE) {
      ensureLogsDir();
      const appendLine = line + '\n';
      if (SYSTEM_SYNC) {
        try { fs.appendFileSync(systemLogPath, appendLine); } catch {/* swallow */}
      } else {
        fs.appendFile(systemLogPath, appendLine, ()=>{});
      }
      // Daily + per-user splitting (non-rotating simple fanout) -----------------
      try {
        const d = new Date();
        const ds = d.toISOString().slice(0,10); // YYYY-MM-DD
        const dayDir = path.join(LOG_DIR,'system', ds);
        if(!fs.existsSync(dayDir)) fs.mkdirSync(dayDir,{recursive:true});
        const dailyAll = path.join(dayDir,'all.log');
        if (SYSTEM_SYNC) { try { fs.appendFileSync(dailyAll, appendLine); } catch{} }
        else { fs.appendFile(dailyAll, appendLine, ()=>{}); }
        // Per-origin fanout (if origin present)
        const originTag = fields && typeof fields.origin === 'string' && ORIGIN_TAGS.has(fields.origin) ? fields.origin : null;
        if (originTag) {
          const originFile = path.join(dayDir, `origin-${originTag}.log`);
          if (SYSTEM_SYNC) { try { fs.appendFileSync(originFile, appendLine); } catch{} }
          else { fs.appendFile(originFile, appendLine, ()=>{}); }
        }
    const guid = fields && (fields.guid || fields.GUID);
        if (guid) {
          const userFile = path.join(dayDir, `user-${guid}.log`);
          if (SYSTEM_SYNC) { try { fs.appendFileSync(userFile, appendLine); } catch{} }
          else { fs.appendFile(userFile, appendLine, ()=>{}); }
        }
      } catch{/* ignore fanout errors */}
    }
  // Combined JSON aggregator entry
  appendCombined({ ts: new Date().toISOString(), src:'system', category, message, fields });
  } catch {/* ignore */}
}


// Helper used by server for client-originated structured log events
export function recordClientLog(meta, cat, message, fields){
  systemLog('client', cat, { id: meta?.id, guid: meta?.guid, color: meta?.color, msg: message, ...fields });
  appendCombined({ ts: new Date().toISOString(), src:'client', category: cat, message, id: meta?.id, guid: meta?.guid, color: meta?.color, fields });
}

// --- WebSocket Send Wrapper Factory ----------------------------------------
// We generate a wsSend bound to server's clientMeta so logging can evolve centrally later.
export function makeWsSend(clientMeta){
  return function wsSend(sock, payload){
    try { sock.send(payload); } catch { return; }
    const meta = clientMeta.get(sock); if(!meta) return;
    const bytes = Buffer.byteLength(payload);
    meta.msgsOut = (meta.msgsOut||0)+1;
    meta.bytesOut = (meta.bytesOut||0)+bytes;
    meta.lastSentTs = Date.now();
  };
}

export default { logTelemetry, systemLog, makeWsSend, recordClientLog };
