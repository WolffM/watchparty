
# tasks.md — Watchparty (Local Server + Cloudflare Tunnel)
Scope: **Milestone 0 → Milestone 5** only.

Each task has **Goal**, **Definition of Done (DoD)**, and **How to Test**. Suggested owners in parentheses.

---

## Milestone 0 — Repo & Skeleton

### T0.1 — Monorepo scaffolding (Agent C)
**Goal:** Create base layout, npm setup, scripts.
**DoD:**
- Structure exists:
  ```
  apps/watchparty-server/{server.js, public/{index.html,admin.html}}
  media/
  state/{staged.json, symlinks/}
  scripts/{start.ps1, dev.ps1}
  ```
- `package.json` has `"type":"module"` and scripts: `dev`, `start`, `test`.
- `.gitignore` excludes `media/**` and `state/staged.json` (and `node_modules`).
**How to Test:**
- `npm run dev` prints `watchparty on http://localhost:3000`.
- `curl http://localhost:3000/` returns viewer HTML.

### T0.2 — Windows run scripts (Agent C)
**Goal:** PowerShell helpers to run locally.
**DoD:**
- `scripts/start.ps1`: sets `$env:ADMIN_KEY` if empty; runs server.
- `scripts/dev.ps1`: runs `npm i` if needed; then starts.
**How to Test:**
- `.\scripts\start.ps1` starts server without errors and prints URL.

---

## Milestone 1 — Static hosting & Range streaming

### T1.1 — Express static + range route (Agent A)
**Goal:** Serve static files and a range-enabled media endpoint.
**DoD:**
- `GET /` serves `public/index.html`.
- `GET /media/current.mkv`:
  - Supports `Range` (responds 206) and full requests (200).
  - Sends `Accept-Ranges: bytes` and proper `Content-Range` on partials.
**How to Test:**
- `curl -I http://localhost:3000/media/current.mkv` shows `Accept-Ranges: bytes`.
- `curl -H "Range: bytes=0-1023" http://localhost:3000/media/current.mkv -o NUL -v` → `206` in headers.
- Browser loads and starts playing a local sample within ~1–2s.

### T1.2 — Symlink staging target (Agent A)
**Goal:** Media served through `state/symlinks/current.mkv` symlink.
**DoD:**
- On boot, if symlink missing: create to placeholder or 404 cleanly.
- Server streams via symlink target.
**How to Test:**
```powershell
New-Item -ItemType SymbolicLink `
  -Path .\state\symlinks\current.mkv `
  -Target (Resolve-Path .\media\sample.mkv)
```
- Visit `/media/current.mkv` and verify playback.

---

## Milestone 2 — Admin APIs & Staging

### T2.1 — `GET /api/media` (Agent A)
**Goal:** List available video files (recursive, filtered).
**DoD:**
- Returns JSON array of relative paths in `media/`.
- Filters extensions: `.mkv,.m4v,.mov,.webm`.
- Optional `?path=subdir` scoping.
**How to Test:**
- `curl http://localhost:3000/api/media` returns expected list.
- `curl http://localhost:3000/api/media?path=anime` scopes correctly.

### T2.2 — `GET /api/staged` (Agent A)
**Goal:** Expose current staged metadata.
**DoD:**
- Returns `{ path, etag, updatedAt }` from `state/staged.json`, or `{}` if none.
**How to Test:**
- `curl http://localhost:3000/api/staged` returns values post-staging.

### T2.3 — `POST /api/stage` (Agent A)
**Goal:** Atomically stage a file and emit `load`.
**DoD:**
- Body: `{ "path": "<rel>", "key": "<ADMIN_KEY>" }`.
- Validates readability; temp symlink → rename to `current.mkv`.
- Computes `etag = sha1(absPath + mtimeMs)`.
- Writes `state/staged.json`; responds `{ ok:true, etag }`.
- Broadcasts `{"cmd":"load","etag":"..."}` via WS.
**How to Test:**
- Bad key → `403`.
- Valid path+key → `200` with `etag`.
- `GET /api/staged` shows same `etag`.
- `curl -I "/media/current.mkv?v=<etag>"` succeeds.

---

## Milestone 3 — WebSocket control layer

### T3.1 — WS server + broadcast (Agent A)
**Goal:** WebSocket hub using `ws` at same origin.
**DoD:**
- Accepts connections; broadcasts JSON to all clients.
- Admin-only commands: `play`, `pause`, `seek`, `load` (require `ADMIN_KEY`).
- Ignore unknown or malformed messages safely.
**How to Test:**
- Open two `/` tabs; connect in console, send a test message; both receive.
- `{cmd:"play",key:"bad"}` ignored; `{cmd:"play",key:"<ADMIN_KEY>"}` broadcast received.

### T3.2 — Admin page controls (Agent B)
**Goal:** Admin UI for file staging + playback controls.
**DoD:**
- `admin.html`:
  - Input for `ADMIN_KEY`.
  - File dropdown (from `/api/media`), “Stage” button (POST `/api/stage`).
  - Buttons: **Play**, **Pause**, **Seek…** (prompt seconds), **SetTime** (pause + set).
- Sends WS messages with `key`.
**How to Test:**
- Stage a file from UI → viewer receives `load`.
- Play/Pause/Seek → viewers react in < 250ms locally.

---

## Milestone 4 — Viewer UX & Progressive reveal

### T4.1 — Initial load with etag (Agent B)
**Goal:** Viewer bootstraps from `/api/staged` and loads `?v=<etag>`.
**DoD:**
- On boot: fetch `/api/staged`, set `video.src = "/media/current.mkv?v=<etag>"`, call `load()`.
- `<video preload="metadata">` used.
**How to Test:**
- With a staged file, player loads and is controllable.

### T4.2 — Visible on first chunk (Agent B)
**Goal:** Hide UI until first decodable data arrives.
**DoD:**
- `body.hidden` at start; remove on `loadeddata` or first `progress`.
**How to Test:**
- Throttle network via DevTools; UI becomes visible only after initial buffer.

### T4.3 — Enforce “no pause/play from viewer” (flagged) (Agent B)
**Goal:** Prevent viewer pause/play unless admin-triggered.
**DoD:**
- Feature flag `enforcePausePlay=true` by default.
- If user clicks pause/play, app immediately reverts (allow seek, volume, FS, rate).
**How to Test:**
- Viewer manual pause → auto-resume.
- Admin pause → viewer pauses and stays paused.

---

## Milestone 5 — Cloudflare Tunnel integration

### T5.1 — Tunnel boot script + HTTPS WS (Agent C)
**Goal:** One-liner public sharing with correct WS protocol.
**DoD:**
- `scripts/tunnel.ps1`:
  ```powershell
  cloudflared tunnel --url http://localhost:3000
  ```
- Frontend auto-selects `ws://` vs `wss://` based on page protocol.
- README section with quick steps.
**How to Test:**
- Run script, get `https://<random>.trycloudflare.com`.
- Open on phone/LTE; admin Play/Pause/Seek affects phone within ~200–400ms.

---

## Acceptance Checklist (0→5)

| Feature | DoD | Test Command/Action |
|---|---|---|
| Range streaming | 200/206, `Accept-Ranges` | `curl -I` + `Range` request |
| Stage file | 200 + etag updates | `POST /api/stage` → `GET /api/staged` |
| WS broadcast | All clients react | Open 2 viewers; Admin Play |
| Progressive reveal | Hidden → visible after buffer | Throttle network; watch UI |
| Cloudflare tunnel | Remote playback control | Phone via tunnel URL |
| Block viewer pause | Pause ignored; admin works | Click pause in viewer; verify |

---

## Handy PowerShell (copy/paste)

**Create symlink (dev):**
```powershell
New-Item -ItemType SymbolicLink `
  -Path .\state\symlinks\current.mkv `
  -Target (Resolve-Path .\media\sample.mkv)
```

**Start server with key:**
```powershell
$env:ADMIN_KEY = "superlongrandom"
node .pps\watchparty-server\server.js
```

**Open tunnel:**
```powershell
cloudflared tunnel --url http://localhost:3000
```
