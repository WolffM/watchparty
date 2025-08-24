## HEVC Main10 MKV Playback Problem (Why the Browser Refuses Your File)

Your staged file:
```
Container: Matroska (.mkv)
Video: HEVC (H.265) Main 10, 1920x1080, 10‑bit
Audio: AAC
Subtitles: multiple ASS tracks
Attachments: many embedded font files (TTF / OTF)
```

### 1. Root Cause
The HTML5 `<video>` element in Chromium‑based browsers (Chrome, Edge without proper system + licensing support) does **not** ship a built‑in HEVC decoder. Even when HEVC hardware is present, Chrome purposely blocks playback (licensing + patent pool issues). Edge can sometimes use Windows system codecs, but support is inconsistent and often still fails for **10‑bit (Main 10)** profiles inside MKV.

Two separate issues must both be satisfied for success:

| Layer | Current File | Browser Expectation | Status |
|-------|--------------|--------------------|--------|
| Container | Matroska (.mkv) | MP4, WebM (safest) | Often unsupported / partial |
| Video Codec | HEVC Main 10 (10‑bit) | H.264 (8‑bit), VP9, AV1 (in modern browsers) | Not supported in Chrome; partial/hardware gated elsewhere |

If *either* layer is unsupported, playback fails. Here both are problematic (MKV + HEVC 10‑bit).

### 2. Why “Installing Something” in the App Won’t Fix It
Decoding happens inside the end‑user’s browser media pipeline. You cannot add a Node or NPM package server‑side to unlock native `<video>` HEVC decoding. Options are limited to:

1. Provide a browser‑supported format (transcode or pre‑encode library).  
2. Switch to a browser with native HEVC support (e.g., Safari on macOS / iOS; some Edge builds with the Windows HEVC extensions and compatible GPU).  
3. Ship a JavaScript/WASM HEVC decoder (e.g., `h265.js`, `libde265` compiled to WASM) and push raw frames via MSE – very CPU intensive (10‑bit 1080p real‑time often not feasible on mid hardware).  
4. Avoid streaming the heavy file: distribute file offline (e.g., via shared storage) and use Watchparty only for **control signaling** (WS play/pause/seek) – each viewer opens the file locally in their player (MPC-HC, mpv, VLC).  

### 3. Container vs. Remux vs. Transcode
| Action | When | Command Example | Re-encode? | Quality Hit |
|--------|------|-----------------|-----------|-------------|
| Pure remux MKV→MP4 | Only if codec already supported (e.g., H.264/AAC) | `ffmpeg -i in.mkv -c copy out.mp4` | No | None |
| Pure remux MKV→WebM | Only if VP9/Opus inside | `ffmpeg -i in.mkv -c copy out.webm` | No | None |
| Transcode HEVC→H.264 | Your current case (HEVC) | `ffmpeg -i in.mkv -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 160k out.mp4` | Yes | Slight (CRF dependent) |
| Transcode HEVC→VP9 | Good for open codecs | `ffmpeg -i in.mkv -c:v libvpx-vp9 -b:v 0 -crf 30 -c:a libopus out.webm` | Yes | Depends |
| Transcode HEVC→AV1 | Future‑friendly, slower | `ffmpeg -i in.mkv -c:v libsvtav1 -crf 30 -preset 6 -c:a libopus out.webm` | Yes | Depends |

Because your source is **HEVC Main10**, simple remux still fails: the browser still can’t decode HEVC. A transcode (or alternate playback strategy) is required if you insist on in‑browser playback.

### 4. What About Installing the Windows “HEVC Video Extensions”?
Installing the Microsoft Store “HEVC Video Extensions” may enable HEVC in **Edge** (not Chrome) *if* hardware + driver expose the decoder and if the content is 8‑bit or compatible 10‑bit variant. Even then, MKV container support is flaky and 10‑bit can still fail. Relying on viewers to purchase / install a proprietary extension is fragile.

### 5. Fonts & Subtitle Attachments
Your MKV carries dozens of embedded fonts. Browser native video playback does **not** parse Matroska ASS subtitles or font attachments. Even if HEVC were decodable, you would not see styled ASS subs. You would need:
1. Pre-extracted and converted subtitles (e.g., to WebVTT: `ffmpeg -i in.mkv subs.vtt`).
2. Or a JS subtitle renderer (e.g., `libass` via WASM).

### 6. Recommended Approaches for Watchparty
Pick one depending on priorities:

| Goal | Recommendation |
|------|---------------|
| Fastest path to working browser playback | Pre-transcode library to H.264/AAC MP4 (8‑bit) or VP9/Opus WebM. Cache results. |
| Lowest CPU at runtime | Preprocess once offline (don’t transcode live). |
| Preserve quality (avoid generational loss) | Encode to high‑quality AV1 (slower) or keep original and distribute offline while using control-only mode. |
| Zero re-encode | Distribute file outside browser; watchers use local player; Watchparty sends only control messages. |
| Keep subtitles | Extract + convert to VTT (or implement ASS renderer). |
| Minimal code churn | Keep current transcode fallback route; add a queue + background job to avoid blocking request cycle. |

### 7. Control-Only Mode (No Streaming)
1. Each viewer copies the exact MKV locally.  
2. Admin stages path (or just signals load) with a dummy etag.  
3. Client code detects “controlOnly=true” flag and instead of `<video src>` uses a local player or instructs user to open file manually; WS still synchronizes time (play/pause/seek).  
→ Near zero upstream bandwidth & no codec issues.

### 8. If You Still Want Automatic On-Demand Fallback
Current implementation does a synchronous transcode (blocking) which is suboptimal. Improvement path:
1. Queue job (e.g., in-memory queue).  
2. Immediately 202 Accepted to client; poll `/api/transcode/status?etag=...`.  
3. When ready, send WS `{cmd:'load', etag, variant:'transcoded'}`.  

### 9. Example Preprocessing Script (Batch)
```powershell
# Transcode every HEVC MKV under media/ to H.264 MP4 (skip if already exists)
Get-ChildItem media -Recurse -Include *.mkv | ForEach-Object {
  $out = $_.FullName -replace '\\.mkv$', '.mp4'
  if (Test-Path $out) { return }
  ffmpeg -y -i $_.FullName -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 160k -movflags +faststart $out
}
```

### 10. Decision Matrix
| Option | Pros | Cons |
|--------|------|------|
| Pre-transcode to H.264 MP4 | Universal support; simple | Extra storage + processing time |
| Pre-transcode to VP9/Opus | Good quality / open | Slower encode than x264 |
| AV1 | Best efficiency forward-looking | Very slow encode on CPU |
| Live transcode (current fallback) | Zero upfront work | CPU spike; delay first viewer |
| Control-only (no streaming) | No re-encode; perfect quality | Requires viewers to manage files locally |
| WASM HEVC decode | No re-encode | High CPU; complexity; may not handle 1080p60 10-bit smoothly |

### 11. Summary
Your failure is *expected* for HEVC Main10 + MKV in Chromium browsers. There is no package you can “npm install” to fix native playback. Choose one of: transcode (pre or on-demand), change playback strategy (control-only), or rely on a browser/platform combination that already licenses HEVC. For a frictionless public experience, **pre-transcoding to H.264/AAC MP4 or VP9/Opus WebM** is the pragmatic route.

---
Last updated: 2025-08-24