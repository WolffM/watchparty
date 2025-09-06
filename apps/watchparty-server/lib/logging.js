import fs from 'fs';
import path from 'path';

// --- Base Paths / Directories ----------------------------------------------
// Allow overriding base state dir (for tests) and enabling sync writes to avoid losing
// events when process exits immediately after logging.
const STATE_DIR = process.env.WP_STATE_DIR || path.join(process.cwd(),'state');
const LOG_DIR = path.join(STATE_DIR,'logs');
const telemetryLogPath = path.join(LOG_DIR,'telemetry.log');
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
const TELEMETRY_SYNC = process.env.TELEMETRY_SYNC === '1' || process.env.NODE_ENV === 'test';
const SYSTEM_SYNC = process.env.SYSTEM_LOG_SYNC === '1'; // optional explicit sync for system log
const SYSTEM_DISABLE_FILE = process.env.SYSTEM_LOG_DISABLE_FILE === '1'; // allow opting out of file writes

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
  RECONNECT_ATTEMPT: 'reconnect-attempt'
});

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
  } catch (e) {
    console.warn('[telemetry] failure', e?.message);
  }
}

export function telemetryPath(){ return telemetryLogPath; }

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
        const guid = fields && (fields.guid || fields.GUID);
        if (guid) {
          const userFile = path.join(dayDir, `user-${guid}.log`);
          if (SYSTEM_SYNC) { try { fs.appendFileSync(userFile, appendLine); } catch{} }
          else { fs.appendFile(userFile, appendLine, ()=>{}); }
        }
      } catch{/* ignore fanout errors */}
    }
  } catch {/* ignore */}
}

export function systemLogFilePath(){ return systemLogPath; }

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

export default { logTelemetry, systemLog, makeWsSend };
