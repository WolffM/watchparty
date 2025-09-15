# Content Delivery Fairness Plan (Trimmed)

Status: ready for task breakdown  
Scope: single-process Node; progressive HTTP Range streaming (no HLS/DASH)  
Goal: Smooth multi-user playback; prevent a few fast clients from racing ahead; reduce late joiner stalls; maintain simplicity.

---

## 1. What Changes / What Stays
**Keep:** Existing single file + Range streaming, one Node process, existing WS control plane.

**Add (v1 scope):**
- Request truncation cap (≤ 1 MiB) to bound monopolization window.
- Event-driven fair dispatcher (DRR) using fixed-size chunks (512 KiB default; allow 1 MiB).
- Per-client token bucket soft rate cap (~1.2–1.5× content bitrate or computed auto cap).
- Head hot-chunk RAM cache (first N MiB) to speed late joiners.
- Strict backpressure handling (respect `res.write()` / `'drain'`).
- Observable metrics (queue wait, chunk service time, per-client deficit/rate state).

**Defer (later phase):** Adaptive ahead gating (quantum boost/penalty), worker/cluster model, read coalescing, advanced dedupe of overlapping ranges.

---

## 2. Current Behavior (Condensed)
Each Range request streams the full requested span immediately via `fs.createReadStream`. Large spans + upload saturation let early clients advance much faster. No fairness or rate shaping; only aggregate byte counts exist.

---

## 3. Design Overview
### 3.1 Request Handling & Truncation
- Always set `Accept-Ranges: bytes`.
- If requested span > `FAIR_MAX_REQUEST_BYTES` (default 1,048,576) truncate; respond 206 with truncated `Content-Range`; browser re-requests next span.

### 3.2 Chunking & DRR Scheduler (Event-Driven)
- Slice the (possibly truncated) span into equal chunks `CHUNK = FAIR_CHUNK_BYTES` (512 KiB default).
- Maintain per-client FIFO queue of chunks + deficit counter.
- Dispatch cycle triggers ONLY when: (a) new chunks enqueued, (b) a chunk finishes writing AND socket not backpressured, (c) a `'drain'` fires.
- DRR: add `quantum (= CHUNK)` to deficit when visiting a client; if head chunk bytes ≤ deficit, serve; subtract size; continue round.

### 3.3 Per-Client Rate Cap (Token Bucket)
- Optional. If `FAIR_RATE_CAP_BPS > 0`, each client has tokens (bits). Refill based on elapsed real time. Serving a chunk consumes its size*8 bits. If insufficient tokens, defer dispatch for that client until refill.
- If `FAIR_RATE_CAP_BPS=0`, compute auto cap: `min(1.3 * contentBitrate, uplinkBudget/activeClients * 1.1)` (uplinkBudget optional manual override later).

### 3.4 Hot Head Cache
- In-memory window of first `HOT_CACHE_BYTES` (e.g., 16 MiB) divided into chunk-aligned blocks. Any chunk fully inside window served from RAM; otherwise read from disk and optionally (if within head window) store.
- Simple direct index (offset / CHUNK) -> Buffer; no LRU needed if bounded to head region.

### 3.5 Disk I/O Strategy
- Single open fd; use `fs.read` per chunk (avoids stream object overhead). Fallback to `createReadStream` acceptable initially if simpler.
- Respect backpressure: if `res.write()` returns false, attach one-time `'drain'` to resume scheduling for that response.
- Abort handling: on `close` / `aborted`, drop queued chunks; if queues now empty remove client from rotation.

### 3.6 Gating (Deferred Optional)
- Ahead gating (limit buffer lead to `FAIR_MAX_AHEAD_SEC`, e.g., 30 s) and bootstrap boost (if <3 s ahead) postponed until after baseline fairness verified.

---

## 4. Environment Variables
```
FAIR_DELIVERY=1                  # Enable fairness path
FAIR_MAX_REQUEST_BYTES=1048576   # 1 MiB request span cap
FAIR_CHUNK_BYTES=524288          # 512 KiB chunk (try 1048576 if low RTT)
FAIR_RATE_CAP_BPS=0              # 0=auto; else per-client cap (bits/sec)
HOT_CACHE_BYTES=16777216         # 16 MiB head cache (0=disable)
FAIR_MAX_AHEAD_SEC=30            # (Deferred gating) lead cap
CONTENT_BITRATE_BPS=0            # Optional hint; else infer after first N seconds
```
(Names normalized to *_BYTES / *_BPS.)

---

## 5. Metrics & Logging
System log (category `media`):
- `media-range-enqueue` { guid, rev, start, end, bytes }
- `media-chunk-serve` { guid, rev, start, end, bytes, durMs, queueWaitMs }
- `media-range-complete` { guid, rev, totalBytes, totalDurMs, chunks }
- `media-range-abort` { guid, rev, servedBytes, reason }

Debug endpoint `/api/debug/delivery` (example fields):
```
{
  enabled, chunkBytes, maxReqBytes,
  perClient: [ { guid, pending, deficit, rateCapBps, tokensRemaining, queueWaitAvgMs } ],
  samples: { served, avgQueueWaitMs, p95QueueWaitMs }
}
```
Targets (initial): p95 queueWait <120ms; p99 chunk dur <250ms; head cache hit rate >50% for late joiner initial reads; byte accounting delta <0.5%.

---

## 6. Implementation Tasks
1. Baseline instrumentation (range observe + debug endpoint skeleton; legacy serving unchanged).
2. Truncation cap + strict backpressure audit (no DRR yet): enforce `FAIR_MAX_REQUEST_BYTES`.
3. Introduce chunk slicing + DRR event dispatcher (FAIR_DELIVERY flag path) with 512 KiB chunk.
4. Add token bucket (optional if FAIR_RATE_CAP_BPS>0 or auto mode) and expose tokens in debug.
5. Add head cache (serve & populate; metrics: hit/miss counters).
6. Tune & validation pass (adjust chunk size, optional switch to 1 MiB, verify targets).
7. (Deferred) ahead gating + bootstrap quantum if drift spread remains high.
8. Flag removal / finalize (fair path default on).

Rollback: set `FAIR_DELIVERY=0` and restart; new requests take legacy path.

---

## 7. Acceptance Criteria
- Concurrent joins (≥5 clients) show reduced time-to-first-continuous playback variance (<30% spread).
- p95 queueWait <120ms; p99 chunk dur <250ms over ≥5 min steady playback.
- No regression: sum(chunk.bytes) == legacy `mediaBytes` ±0.5%.
- Head cache reduces disk read count for offsets < HOT_CACHE_BYTES by ≥40% after first two viewers.

---

## 8. Out-of-Scope / Future
- Multi-process/cluster distribution.
- Adaptive bitrate packaging (HLS/DASH).
- Cross-client dedupe of overlapping mid-file ranges.

---

End of trimmed plan.
