# Watchparty Cloudflare Caching & Chunked Delivery Plan

This plan updates the media delivery pipeline to split large video files into cache-friendly chunks, leverage Cloudflare edge caching, and ensure smooth playback.

---

## **1. Update Transcoding Pipeline → 256 MB Chunks**

We’ll use **MP4Box** (from GPAC) to split into exact-sized **fMP4** chunks for caching under Cloudflare’s 512 MB limit.

### **1.1 Install MP4Box (GPAC)**
- **Windows**: `choco install gpac`
- **macOS**: `brew install gpac`
- **Linux**: `sudo apt install gpac`

### **1.2 Prepare File for Fragmented MP4**
If your input isn’t already fragmented, remux it first:
```bash
ffmpeg -i input.mp4 -c copy -movflags +frag_keyframe+empty_moov temp_fmp4.mp4
```

### **1.3 Split into ~256 MB Parts**
```bash
MP4Box -splits 256 temp_fmp4.mp4 -out current_part.mp4
```
This produces:
```
current_part_1.mp4
current_part_2.mp4
current_part_3.mp4
...
```

### **1.4 Generate a Manifest**
Create a JSON manifest for the chunks:
```bash
Get-ChildItem . -Filter "current_part_*.mp4" |
  Sort-Object Name |
  ForEach-Object { [PSCustomObject]@{ url = "/media/current/$($_.Name)"; bytes = $_.Length } } |
  ConvertTo-Json | Set-Content manifest.json
```
This `manifest.json` file will drive your player logic.

---

## **2. Update Content Delivery Pipeline**

### **2.1 Express/Node Origin Setup**
Serve chunk files + manifest with cacheable headers:

```js
// app.js
const express = require('express');
const path = require('path');
const app = express();

app.get('/media/current/manifest.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300'); // browsers 1m, edge 5m
  res.sendFile(path.join(__dirname, 'media/current/manifest.json'));
});

app.use('/media/current', (req, res, next) => {
  // Chunks are immutable
  res.set('Cache-Control', 'public, max-age=31536000, immutable, s-maxage=31536000');
  res.set('Accept-Ranges', 'bytes'); // support partial fetches
  next();
}, express.static(path.join(__dirname, 'media/current')));
```

---

### **2.2 Cloudflare Cache Rules**

#### **Rule A — BYPASS Dynamic**
- If URI path matches: `/api/* OR /socket.io/* OR /admin/* OR */login* OR */callback*`
- Then: **Bypass cache**

#### **Rule B — Cache Chunks + Static**
- If **File extension is**: `mp4, m4s, mp3, webm, vtt, srt, js, css, png, jpg, jpeg, webp, svg, ico, json`
- Then:
  - **Cache Level**: Cache Everything
  - **Edge TTL**: 7 days (or longer; chunks are immutable)
  - **Respect origin cache-control**: On
- Optional: Enable **Tiered Cache**

---

## **3. Retrospective: Player & Delivery**

### **3.1 Use MSE (Media Source Extensions)**

With fMP4 chunks, we can append parts seamlessly using MSE.

**Steps:**
1. Load `/media/current/manifest.json`
2. Create a `MediaSource` and `SourceBuffer`
3. Append chunks sequentially

```js
async function playManifest(url) {
  const manifest = await (await fetch(url, { cache: 'force-cache' })).json();
  const ms = new MediaSource();
  const video = document.querySelector('video');
  video.src = URL.createObjectURL(ms);

  ms.addEventListener('sourceopen', async () => {
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
    for (let i = 0; i < manifest.length; i++) {
      const part = manifest[i].url;
      const buf = await fetch(part, { cache: 'force-cache' }).then(r => r.arrayBuffer());
      await appendBufferAsync(sb, buf);

      // Preload the next chunk
      if (i + 1 < manifest.length) {
        fetch(manifest[i + 1].url, { cache: 'force-cache' });
      }
    }
    sb.addEventListener('updateend', () => {
      if (ms.readyState === 'open') ms.endOfStream();
    });
  });
}

function appendBufferAsync(sb, buf) {
  return new Promise((resolve, reject) => {
    sb.addEventListener('updateend', resolve, { once: true });
    sb.addEventListener('error', () => reject(sb.error), { once: true });
    sb.appendBuffer(new Uint8Array(buf));
  });
}
```

**Key Requirements:**
- All chunks **must** share identical init segments (`-movflags +frag_keyframe+empty_moov` ensures this)
- Audio/video codec parameters must match exactly
- If you see boundary glitches, increase keyframe frequency (`-g 48` @ 24fps) for smoother transitions

---

## **4. Operational Checklist**

- [ ] Install **GPAC** (MP4Box)
- [ ] Remux into fragmented MP4 if needed
- [ ] Split files into ≤256 MB chunks
- [ ] Emit `/media/current/manifest.json`
- [ ] Update Express routes with cache headers
- [ ] Add Cloudflare cache + bypass rules
- [ ] Implement MSE-based player logic
- [ ] Validate with `CF-Cache-Status: HIT`
- [ ] Confirm smooth playback across chunk boundaries

---

## **TL;DR**

- Split video into **≤256 MB fMP4 chunks**
- Cache chunks aggressively at Cloudflare
- Serve a **manifest.json** + implement MSE playback
- Validate caching + chunk stitching end-to-end
