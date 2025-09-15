
# Watchparty Design — Local Server + Cloudflare Tunnel

## Goals
- One admin controls **play/pause/seek** and **which file is staged**.
- Viewers load a **single player page**. They have **full controls except pause/play** (toggle-able later).
- **Low latency** broadcast via WebSockets.
- **Progressive playback**: page becomes visible once the first chunk is available (no full file pre-load).
- Zero external SaaS (besides free Cloudflare Tunnel).

---

## High-Level Architecture
```
[Monorepo]
  apps/
    watchparty-server/         # Node/Express + ws (static + APIs + WS)
      public/
        index.html             # viewer
        admin.html             # admin
      server.js
    infra/
      tunnel/                  # cloudflared configs (optional)
  media/                       # all source media (git-ignored if large)
    anime/frieren-01.mkv
    ...
  state/
    staged.json                # { path, etag, updatedAt }
    symlinks/
      current.mkv -> ../media/... (atomic symlink)
```

### Why a symlink?
- Keep the player URL **stable** (`/media/current.mkv`) while letting admin re-point atomically.
- Add a cache-buster query (`?v=<etag>`) to force clients to reload when staged changes.

---

## Components

### 1) HTTP server (Express)
- Serves `/public` (player/admin).
- Serves `/media/current.mkv` (symlink target) with **HTTP Range** and `Accept-Ranges: bytes` so HTML5 `<video>` starts as soon as it sees first chunks.
- Simple JSON APIs for listing and staging files.

### 2) WebSocket hub (`ws`)
- Broadcasts control messages: `play`, `pause`, `seek`, `load`.
- Admin messages require `ADMIN_KEY` (shared secret); viewer messages are ignored except pings or (optionally) user seek telemetry.

### 3) Admin UI
- File picker fed by `/api/media`.
- “Stage” button → `POST /api/stage`.
- Playback controls → WS broadcasts.

### 4) Viewer UI
- `<video>` points to `/media/current.mkv?v=<etag>`.
- On WS `load`, swap `src` to the new cache-busted URL, wait for `canplay`, then optionally auto-play on admin `play`.
- Hide main UI until `loadeddata` or first `progress` event (> ~64–256 KB buffered).

---

## API Design

### List media
`GET /api/media?path=anime`  
Returns array of files under `media/` (server-side filtered to common video types).

### Get staged
`GET /api/staged`  
Returns `{ path, etag, updatedAt }`.

### Stage file (admin)
`POST /api/stage`
```json
{ "path": "anime/frieren-01.mkv", "key": "<ADMIN_KEY>" }
```
- Server updates `state/symlinks/current.mkv` (atomic replace) and `state/staged.json`.
- Generate new `etag` (e.g., sha1 of path + mtime).
- Broadcast `{"cmd":"load","etag":"...","path":"anime/frieren-01.mkv"}` over WS.

---

## WebSocket Messages

**Admin → Server (requires key)**
```json
{ "cmd": "play", "key": "..." }
{ "cmd": "pause", "key": "..." }
{ "cmd": "seek", "time": 132.5, "key": "..." }
{ "cmd": "load", "etag": "abc123", "key": "..." }
```

**Server → All Clients**
```json
{ "cmd": "play" }
{ "cmd": "pause" }
{ "cmd": "seek", "time": 132.5 }
{ "cmd": "load", "etag": "abc123" }
```

*(Future: a flag `{ "enforcePausePlay": true }` to toggle user pause/play.)*

---

## Progressive Playback & “Visible on First Chunk”
- Serve with **Range** support and no aggressive `Cache-Control` (or use `public, max-age=0, must-revalidate`).
- In the viewer:
  - Hide the page body until `video.readyState >= 2` (`HAVE_CURRENT_DATA`) or first `progress` indicates a buffered range.
  - Use `<video preload="metadata">` initially; set `src` and `load()`; on `loadeddata`, show UI. This reveals the page as soon as decoder has enough data—not full file.

---

## Control Policy (Viewer vs Admin)
- **Viewer controls:** allow timeline seek, volume, fullscreen, playback rate. **Block pause/play**:
  - Listen to `pause`/`play` events; if not from admin, immediately revert (`video.play()` after a viewer pause; ignore viewer play).
  - Optional “Follow mode” toggle for viewers who want to pin to admin seeks (on by default).

---

## Key Implementation Snippets

### Range-enabled media route
```js
// /media/current.mkv -> symlink target
app.get("/media/current.mkv", (req, res) => {
  const target = path.resolve(SYMLINK_DIR, "current.mkv");
  fs.stat(target, (err, stat) => {
    if (err) return res.sendStatus(404);
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");

    if (!range) {
      res.setHeader("Content-Length", stat.size);
      return fs.createReadStream(target).pipe(res);
    }
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(target, { start, end }).pipe(res);
  });
});
```

### Stage endpoint (atomic symlink swap)
```js
app.post("/api/stage", express.json(), async (req, res) => {
  const { path: rel, key } = req.body || {};
  if (key !== process.env.ADMIN_KEY) return res.sendStatus(403);

  const abs = path.resolve(MEDIA_ROOT, rel);
  await fs.promises.access(abs, fs.constants.R_OK);

  const linkPath = path.resolve(SYMLINK_DIR, "current.mkv");
  const tempLink = path.resolve(SYMLINK_DIR, `.__current_${Date.now()}.mkv`);
  try { await fs.promises.unlink(tempLink).catch(()=>{}); } catch {}
  await fs.promises.symlink(abs, tempLink);
  await fs.promises.rename(tempLink, linkPath);

  const stat = await fs.promises.stat(abs);
  const etag = createHash("sha1").update(abs + String(stat.mtimeMs)).digest("hex");
  await fs.promises.writeFile(STAGED_JSON, JSON.stringify({ path: rel, etag, updatedAt: Date.now() }, null, 2));

  broadcast({ cmd: "load", etag });
  res.json({ ok: true, etag });
});
```

### Viewer `index.html` (show when first chunk ready)
```html
<video id="vid" controls preload="metadata" style="max-width:100%"></video>
<script>
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
const vid = document.getElementById("vid");
let etag = null;

function setSrc(e){ 
  etag = e || Date.now().toString();
  vid.src = `/media/current.mkv?v=${etag}`;
  vid.load();
}

function showWhenReady(){
  const show = () => document.body.classList.remove("hidden");
  if (vid.readyState >= 2) return show();
  vid.addEventListener("loadeddata", show, { once:true });
  vid.addEventListener("progress", show, { once:true });
}

ws.onmessage = (e)=>{
  const msg = JSON.parse(e.data);
  if (msg.cmd === "load"){ setSrc(msg.etag); showWhenReady(); }
  if (msg.cmd === "play"){ vid.play(); }
  if (msg.cmd === "pause"){ vid.pause(); }
  if (msg.cmd === "seek"){ vid.currentTime = msg.time || 0; }
};

fetch("/api/staged").then(r=>r.json()).then(s=>{ setSrc(s.etag); showWhenReady(); });

vid.addEventListener("pause", ()=> ws.send(JSON.stringify({type:"viewerPause"})));
</script>
<style> body.hidden{visibility:hidden} </style>
```

### Admin `admin.html`
- File picker (`GET /api/media`).
- Buttons: Stage, Play, Pause, Seek.
- Sends WS with `key`.

---

## Deployment

### Local run (Windows PowerShell)
```powershell
# Inside apps/watchparty-server
npm i
$env:ADMIN_KEY = "superlongrandom"
node .\server.js
```

### Expose via Cloudflare Tunnel (free)
```powershell
# One-time login
cloudflared tunnel login
# Quick ad-hoc tunnel
cloudflared tunnel --url http://localhost:3000
# -> gives you https://<random>.trycloudflare.com
```

---

## Bandwidth Notes
- You’re serving **one full stream per viewer**. If your upstream is 20 Mbps and the file is 8 Mbps, you can safely serve ~2 viewers.  
- If bandwidth is tight, pre-share the file and switch the player to **file://** or a local path per user (same UI, control-only via WS). That gives you Discord-beating latency with near-zero upstream usage.

---

## Security & Hardening
- `ADMIN_KEY` in env; don’t ship it to clients.
- CORS locked to your own origin (default if same-host).
- Optional: HTTP basic auth for `/admin.html`.
- Log rate-limit WS from unknown clients.

---

## Future Enhancements
- **“Follow Mode” toggle** for viewers.
- **Playback drift corrector** for sub-100ms sync.
- **HLS/DASH** for adaptive bitrates.
- **Access list** (invite codes) for exposed tunnels.

---

## 2025 Fair Delivery Refactor

The live implementation now separates media delivery strategies:

- `lib/fair-delivery.js` (default): queued, token-bucket chunk scheduler with optional head cache and ahead gating. Enabled unless `FAIR_DELIVERY=0`.
- `lib/direct-delivery.js`: legacy direct byte-range streaming (used only if fairness disabled env-side).

`server.js` always calls the fairness module; when disabled it internally falls back to direct logic, keeping the route code minimal. Per-media revision resets call `resetPerMediaRevision()` and update the active revision with `setMediaRevision()`. Environment drift for FAIR_* vars logs a single `fair-config-drift` system event.
