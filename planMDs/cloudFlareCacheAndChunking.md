# Watchparty Cloudflare Caching & Chunked Delivery Plan (Rev2)

Purpose: introduce optional fragmented MP4 chunk delivery with Cloudflare edge caching while preserving backward compatibility with the current single range-served file. This revision incorporates validated constraints and chosen defaults.

---

## **1. Transcoding Pipeline → Fragment + Size-Based Chunks**

We will optionally produce size-based fragmented MP4 chunks after (or during) transcode. Default target size: **48 MB** (tunable). Rationale: <2s startup on typical broadband, finer CDN cache reuse, still low manifest overhead. Allow range: **16–128 MB**. (Old draft 256 MB replaced due to startup latency + seek cost.)

Key parameters (to be added to `transcribe-all.ps1`):
| Param | Default | Notes |
|-------|---------|-------|
| `-ChunkMB <int>` | 48 | 0 or omitted = disabled (legacy single file) |
| `-KeepFull` | false | If set, retain the full `.wp.mp4` alongside chunks; else remove after successful chunk+manifest generation |

Video will be transcoded already fragmented: add `-movflags +faststart+frag_keyframe+empty_moov` during ffmpeg run (avoid separate remux). If chunking is enabled but existing file not fragmented (future edge cases), perform a remux step before splitting.

### **1.1 Install MP4Box (GPAC)**
Used for deterministic size splits.
* Windows: `choco install gpac`
* macOS: `brew install gpac`
* Linux: `sudo apt install gpac`

### **1.2 Produce Fragmented MP4**
During transcode include:
```
... -movflags +faststart+frag_keyframe+empty_moov ...
```
If re-chunking an already transcoded legacy file, remux once:
```
ffmpeg -i input.wp.mp4 -c copy -movflags +faststart+frag_keyframe+empty_moov temp_fmp4.mp4
```

### **1.3 Split into ~N MB Parts (Size-Based)**
Use chosen chunk size (default 48):
```
MP4Box -splits 48 temp_fmp4.mp4 -out part.mp4
```
Output naming will be normalized into a directory:
```
<basename>.wp.chunks/ <basename>.part0001.mp4
                       <basename>.part0002.mp4
                       ...
<basename>.wp.chunks/manifest.json
```
We will post-process MP4Box output (which may produce `part_1.mp4`, etc.) into the target padded naming and move into the directory. Zero padding (4 digits) keeps lexical ordering.

NOTE: MP4Box size splits reset internal timestamps (each chunk starts near 0). MSE appends must set `sourceBuffer.timestampOffset = targetStartTime` for each chunk to create a continuous timeline.

### **1.4 Generate a Manifest (Schema v1)**
Schema (array form plus optional header object). We embed timing so the client can compute offsets without probing:
```
{
  "version": 1,
  "base": "/media/output/<basename>.wp.chunks/",
  "codec": "video/mp4; codecs=\"avc1.42E01E, mp4a.40.2\"",   // discovered / recorded
  "totalDuration": <seconds>,
  "totalBytes": <sum>,
  "chunks": [
    { "url": "<basename>.part0001.mp4", "bytes": 50354687, "startTime": 0,       "duration": 9.97 },
    { "url": "<basename>.part0002.mp4", "bytes": 50332011, "startTime": 9.97,   "duration": 10.04 },
    ...
  ]
}
```
`startTime` is cumulative wall-clock media time. Since MP4Box resets timestamps, we create this via sequential accumulation of each chunk’s duration (queried with `ffprobe -show_format`). Integrity (future): optionally add `sha256` per chunk.

Generation (PowerShell sketch inside pipeline after renaming):
```
# Pseudo steps:
$chunks = Get-ChildItem $chunkDir -Filter "$baseName.part*.mp4" | Sort-Object Name
$manifest = @()
$start = 0.0
foreach($c in $chunks){
  $dur = (ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$($c.FullName)")
  $d = [double]::Parse($dur, [Globalization.CultureInfo]::InvariantCulture)
  $manifest += [PSCustomObject]@{ url = $c.Name; bytes = $c.Length; startTime = [math]::Round($start,3); duration = [math]::Round($d,3) }
  $start += $d
}
([PSCustomObject]@{ version=1; base=$baseUrl; codec=$codec; totalDuration=[math]::Round($start,3); totalBytes=($chunks|Measure-Object Length -Sum).Sum; chunks=$manifest }) | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $chunkDir 'manifest.json')
```

Legacy compatibility: If chunking disabled or manifest missing, client continues using `/media/current.mp4`.

---

## **2. Server / Delivery Pipeline Changes**

### **2.1 Manifest & Chunk Serving**
On media selection:
1. Detect presence of `<basename>.wp.chunks/manifest.json` under output root.
2. If present, mark session state `chunkMode=true` and log `media chunk-enabled parts=<n>`.
3. Else log `media chunk-missing` and continue legacy single-file path.

Routes (additions):
* `/media/current/manifest.json` → serves selected manifest (Cache-Control: `public, max-age=60, s-maxage=300`)
* `/media/current/chunks/:file` → static mapped to `<basename>.wp.chunks` (Cache-Control: `public, max-age=31536000, immutable, s-maxage=31536000`)

Maintain existing `/media/current.mp4` for one rollout cycle (flag-based fallback: e.g. query `?legacy=1`).

Logging (System log category `media`):
* `media chunk-enabled` { path, parts }
* `media chunk-missing` { path }
* `media chunk-request` { file }
* `media manifest-serve` { path }

No duplicate telemetry; only system log for serve events.

### **2.2 Caching Headers**
* Manifest: short browser TTL (60s) to allow re-chunking during experimentation; CDN 5m.
* Chunks: immutable 1 year TTL at both browser and edge.
* Keep `Accept-Ranges` for chunks (even though entire object usually fetched) for partial resume.

---

### **2.3 Cloudflare Cache Rules**

Rule A — BYPASS Dynamic:
`/api/* OR /socket.io/* OR /admin/* OR */login* OR */callback*`

Rule B — Static & Chunk Cache:
Path prefix match `/media/current/*` (later maybe `/media/hls/*`) AND extension in `(mp4,m4s,webm,vtt,srt,js,css,png,jpg,jpeg,webp,svg,ico,json)`
* Cache Level: Cache Everything
* Edge TTL: 7 days (manifest may revalidate sooner due to shorter origin TTL; still fine)
* Respect origin cache-control: On
* Enable Tiered Cache (optional)

Rationale for prefix: avoids unintentionally caching unrelated `json` (API responses).

---

## **3. Player Changes (MSE Path)**

Phase 1 scope: *single embedded audio track only*. Sidecar audio extraction still occurs for legacy mode but multi-audio selection inside chunk mode deferred (future HLS/DASH pivot).

Basic flow:
1. Attempt fetch `/media/current/manifest.json`.
2. If 200 + valid schema: MSE mode; else set `<video src="/media/current.mp4">` legacy.
3. Create `MediaSource` + single `SourceBuffer` using manifest `codec`.
4. Maintain a queue of pending chunk appends. Before each append set `sb.timestampOffset = chunk.startTime` (because each size-split file timestamps restart at ~0).
5. Preload strategy: fetch next chunk only when buffered less than e.g. 60s ahead OR first two chunks (avoid downloading entire episode immediately).
6. On seek: find chunk whose `[startTime, startTime+duration)` contains target; clear buffer (`remove(0, buffered.end(lastRange))`), then append from target chunk forward.

Telemetry events to add later (not in system log): `ui-manifest-load`, `ui-chunk-append`, `ui-chunk-seek-rebuffer`, `client-error`.

Reference skeleton (illustrative only):
```
async function playViaManifest(){
  const r = await fetch('/media/current/manifest.json');
  if(!r.ok) return false;
  const mf = await r.json();
  const ms = new MediaSource();
  const video = document.querySelector('video');
  video.src = URL.createObjectURL(ms);
  const q = [];
  ms.addEventListener('sourceopen', async () => {
    const sb = ms.addSourceBuffer(mf.codec);
    let idx = 0;
    async function appendNext(){
      if(idx >= mf.chunks.length){ try { ms.endOfStream(); } catch {}; return; }
      const ch = mf.chunks[idx];
      const url = mf.base + ch.url;
      const arr = await fetch(url).then(r=>r.arrayBuffer());
      sb.timestampOffset = ch.startTime; // critical for size-split timeline continuity
      await new Promise((res,rej)=>{
        const onErr = () => { sb.removeEventListener('error', onErr); rej(sb.error); };
        sb.addEventListener('updateend', res, { once:true });
        sb.addEventListener('error', onErr, { once:true });
        sb.appendBuffer(arr);
      });
      idx++;
      if(idx < 2) appendNext(); // small prebuffer; later a smarter heuristic
    }
    appendNext();
  });
  return true;
}
```

**Key Requirements:**
* Identical init segment properties (codec profile/level, sample rate). Using same ffmpeg run ensures this.
* Each appended chunk sets correct `timestampOffset`.
* Consider increasing keyframe density (e.g. `-g 48` for 24fps) if boundary decode stutter observed.
* Fallback path always available.

---

## **4. Operational Checklist**

Phase 1 (Backend + Pipeline):
- [x] Add `-ChunkMB` & `-KeepFull` params to `transcribe-all.ps1`
- [x] Integrate ffmpeg movflags for fragmentation
- [x] Post-split rename + manifest generation (size-based parts + manifest.json)
 - [x] Server: detect manifest, add routes, headers, logging (completed)
- [ ] Cloudflare rules update (prefix + TTL) (pending rollout)
- [ ] Validate chunk mode load in local env (single viewer) (blocked until server routes exist)

Phase 2 (Player Incremental):
- [ ] Implement manifest fetch + MSE path
- [ ] Append with timestampOffset
- [ ] Prebuffer heuristic + simple seek handling
- [ ] Telemetry events (ui-manifest-load / ui-chunk-append)
- [ ] Fallback query flag (?legacy=1)

Phase 3 (Refinement / Observability):
- [ ] Add drift / rebuffer telemetry in chunk mode
- [ ] Optional integrity hashes in manifest
- [ ] Evaluate smaller vs larger chunk tradeoffs & adjust default

Phase 4 (Multi-Audio / Time Segment Exploration):
- [ ] Decide on HLS/DASH or time-based segmentation if heavy seeking patterns observed
- [ ] Multi-audio SourceBuffer or adaptive stream packaging

---

## **5. Tradeoffs & Future**
* Size-based splitting (current) requires timestampOffset management; time-based segmentation would simplify seeking & buffering but increases pipeline complexity (consider if seek frequency high).
* Multi-audio deferred; keep embedded default track to minimize SourceBuffer complexity.
* 48 MB default chosen for startup vs cache efficiency balance; monitor real RUM metrics to tune.
* Consider migration to standard HLS (init.mp4 + m4s) if feature set grows (captions switching, ABR, multi-audio).

## **TL;DR (Rev2)**
* Optional `-ChunkMB` (default 48) adds fragmented MP4 size-based chunking (directory `<basename>.wp.chunks/`).
* Manifest with timing & sizes enables MSE appends using timestampOffset.
* Long-lived immutable caching for chunks; short TTL manifest.
* Legacy single-file path retained for fallback during rollout.
* Future: evaluate time-based segmentation + multi-audio (HLS/DASH) if needed.
