# Watchparty Project Retrospective (Current Codebase Inventory)

> Purpose: Capture what exists today (features, structure, behaviors) to inform a cleaner redesign. Focus is on functional intent, not logging, fallback branches, or low‑level implementation quirks.

## 1. High-Level Summary
A single-process Node.js application providing synchronized video playback, basic chat with character slots/colors, subtitle handling (auto‑selection and style overlay), and an admin-driven control model. Frontend is a single HTML file (`index.html`) that serves both admin and viewer modes (route + key determine role). No build tooling; plain JS in browser + `express` + `ws` on server.

## 2. Repository Structure (Essentials)
```
apps/
  watchparty-server/
    server.js              # Main HTTP + WebSocket orchestrator
    config.js              # Central runtime configuration (env overrides)
    lib/
      auth.js              # Shared key validation + admin role detection
      media-listing.js     # Safe media list / resolution / episode grouping
      subtitles.js         # Subtitle selection, conversion (SRT→VTT), enumeration
      audio-probe.js       # (Audio track enumeration logic – sidecar & embedded)
      fair-delivery.js     # Fair media chunk scheduling (optional env-controlled)
      direct-delivery.js   # Legacy direct streaming path
      episode.js           # Episode key extraction heuristics
      templates.js         # (Template utilities for server-sent snippets)
      logging.js           # (Logging helpers – intentionally not detailed here)
    public/
      index.html           # Unified SPA (viewer + admin UI)
      app.css / theme.css  # Styling (not enumerated in detail)
    templates/             # Ancillary template assets
    state/                 # (Server runtime artifacts – ephemeral)
media/
  output/                  # Transcoded playable media (.wp.mp4 / .webm + subs/audio)
  anime/ (raw sources)     # Input sources prior to transcoding pipeline
  sprites/                 # Character avatar images (square & small variants)
scripts/                   # PowerShell operational & media pipeline scripts
state/                     # Global runtime state folder (keys, logs, symlinks, cache)
```

## 3. Working Components (Strengths to Preserve)
- Media preparation & transcoding workflow (`scripts/` + `media/output/` convention).
- Deployment & lifecycle scripts (start, deploy, shutdown, tunnel, transcription wrappers).
- Single shared key model for simplicity (low ceremony for small private groups).
- Direct progressive file streaming with HTTP Range support.
- Automatic subtitle discovery, SRT normalization to WebVTT, basic cleaning & language preference.
- Character-based chat with color palette & rename support.
- Admin authoritative playback state (play, pause, seek, load/unload media).
- Dynamic viewer drift correction model (client adjusts to admin timeline).
- Simple UI (no bundler) enabling quick iteration.

## 4. Core Server Responsibilities (from `server.js` & libs)
- Serve static assets (`public/`, sprites, transcoded outputs).
- Gated entry routes for viewer vs admin (`/watchparty*` vs `/watchparty-admin*` plus legacy paths) – same HTML delivered.
- WebSocket hub: manages clients, assigns incremental IDs & optional color roles, tracks presence, relays admin commands.
- Playback state tracking: current media path, revision/version increment on change, paused flag, timestamp anchoring for drift calculations.
- Media selection: Admin chooses a file under configured media output root; server updates canonical state and triggers client reload.
- Progressive media endpoint (`/media/current.mp4`): Range-capable streaming (may route through fairness scheduler or direct streaming).
- Subtitle endpoints: serve transformed current subtitle (`/media/current.vtt`), enumerate available subtitles (`/media/current-subs.json`).
- Audio track enumeration (`/media/current-audio.json`) to support sidecar or embedded track switching.
- Media file listing API (`/api/files`) returning selectable media based on grouping/episode heuristics.
- Color palette API (`/api/colors`) for client UI theming of chat roles.
- Access key gate: All WebSocket connections and gated HTML require the shared key; admin role inferred from path prefix.

## 5. Client (Frontend) Functional Inventory (`index.html`)
- Single HTML page parameterized by query (`?key=`) and path to determine admin vs viewer mode.
- Video element configured for progressive playback, muted autoplay for viewers on join.
- Admin-only control bar elements:
  - Play/Pause toggle button.
  - Seek bar with hover/tooltip preview and live time label updating.
  - Media selection button / home-start control (staging new media).
  - Fullscreen toggle.
  - Audio track cycling button (embedded track selection & sidecar audio logic).
  - Subtitle toggle + language dropdown + style selector (multiple overlay style themes: default, outline, yellow, box, etc.).
- Viewer/shared controls:
  - Volume slider with custom fill visualization & unmute-on-change behavior.
  - Chat panel toggle & message form.
  - Character rename (color slot adoption) mechanism (implicit via chat rename command or UI element).
  - Fullscreen (shared) and subtitle style adjustments.
- Starfield “home” / idle visual scene displayed before media staged (and hidden when media loads).
- Automatic attempt to enable subtitles in a preferred language (e.g., English) when present.
- Drift correction logic: applies server state, monitors difference vs local `currentTime`, seeks when out of tolerance (conceptually present though lower-level details inside omitted here).
- Sidecar audio handling: ability to load alternative language audio as a separate `<audio>` element synchronized (play/pause/seek mirrored) when selected.
- Chat rendering: colored names mapped to role palette; limited scrolling region.
- Presence & self-state initialization: receives initial chat history subset and presence snapshot.
- Function instrumentation wrappers (lightweight; excluded from new design spec emphasis but indicates dynamic wrapping is feasible if needed).

## 6. Media & Subtitle Handling
- Preferred file formats: `.wp.mp4` (transcoded fast-start baseline) then `.webm` fallback.
- Episode grouping heuristics: Detect season/episode patterns (SxxEyy or Exx) to group variants and pick a canonical candidate per episode.
- Subtitle selection priority: explicit `?lang=` request → English fallback → base name match → first available.
- SRT to WebVTT conversion & basic sanitization (remove translator notes, curly brace markup, duplicate sequential lines).
- Language & variant labeling for UI enumeration (tracks sorted by language code).
- Audio track enumeration (embedded + sidecar) enabling runtime selection & enforced exclusive mode.

## 7. Chat & Presence Features
- In-memory ring buffer of recent chat messages (history limit & subset sent on join).
- Rate limiting: window-based max messages per interval.
- User identity model: auto-assigned incremental numeric ID; color role slot chosen or null until assigned; custom name overrides color name when provided.
- Presence broadcast: clients receive current user list (ID, color/role, possibly derived display name) on join and when membership changes.

## 8. Operational Scripts (Keep Patterns)
Scripts (PowerShell) orchestrate local development, deployment, transcoding, and tunnel exposure. Key behaviors to carry forward:
- `start.ps1`: Ensures admin key file, optionally seeds media, launches server locally.
- `deploy.ps1`: Production bring-up; clears offline sentinel, starts server with logging, may initiate named Cloudflare tunnel, writes discovered public URLs.
- `shutdown.ps1`: Graceful termination (creates offline flag, stops server and optionally tunnel).
- `transcribe-all.ps1`: Unified pipeline: video transcode to standardized `.wp.mp4`, audio sidecar extraction (`.audio.<lang>.m4a`), subtitle extraction & conversion (to `.vtt` or separating forced subs). Supports selective skipping (`-SkipVideo`, `-SkipAudio`, `-SkipSubs`), language filters, dry-run, and force overwrite.
- `transcribe-audio.ps1`, `transcribe-subtitles.ps1`: Focused wrappers for subset tasks.
- `tunnel` / quick tunnel script: ephemeral Cloudflare tunnel for ad-hoc sharing without full deploy script.
- Key generation & reuse: `state/admin.key` persistence; environment variable precedence for override.
- Media layout assumptions for pipeline: input vs output separation, naming conventions enabling subtitle & audio pairing.

## 9. Notable Design Decisions (To Inform Redesign)
- Single shared key instead of per-user accounts to reduce complexity; admin role inferred purely by URL path.
- Unified SPA rather than separate build for admin vs viewer keeps duplication low but increases conditional logic complexity.
- Direct file-based progressive streaming chosen over HLS/DASH for minimal latency and implementation simplicity.
- Subtitle overlay custom rendering (rather than native `<track>` cues) for consistent styling & multi-theme support.
- Sidecar audio approach permits multi-language audio without container remuxing each variant.
- Episode grouping logic attempts to simplify large media libraries by deduplicating variants; directory walking performed synchronously at listing time.

## 10. Pain Points / Complexity Sources (Motivation for Rewrite)
(Expressed or implied by current sprawl and maintenance difficulty; extracted at a feature level without touching logging specifics):
- Monolithic `server.js` holding diverse concerns (auth, presence, chat, media state, delivery strategy switching, subtitle endpoints, audio enumeration) → difficult to evolve.
- Tight coupling between client and server message schema embedded directly in frontend without versioning layer.
- Inlined UI logic with large procedural script in `index.html` complicates modular enhancements (audio, subtitle styles, transitions, starfield effects all intertwined).
- Media fairness / scheduling logic sits adjacent to core streaming path without a clean abstraction boundary for alternative strategies.
- Absence of explicit state versioning or diff model — full state re-broadcast patterns risk over-sending or complicate partial updates.
- Mixed responsibilities (e.g., admin gating, playback sync, chat) in single WS channel without namespacing or message routing abstraction.

## 11. Extracted Functional Requirements (Carry Forward)
- Progressive synchronized playback with admin authoritative control (play, pause, seek, load/unload).
- Drift detection + correction on viewers (silent auto-correct within tolerance). 
- Media library browsing & episode grouping (season/episode recognition; canonical pick per group).
- Subtitle auto-selection, style theming, SRT conversion, language enumeration & manual switching.
- Optional multi-language audio (embedded track switch + sidecar fallback) with seamless mute/unmute consistency.
- Chat with: role/color slots, rename, rate limiting, recent history on join.
- Presence roster (user list) + join/leave announcements.
- Home/idle screen (visual placeholder) before media loads.
- Single shared access key model with admin URL differentiation.
- Operational scripts for: start, deploy, shutdown, tunnel, full & partial media transcription.
- Media directory conventions: `media/output` for ready assets, `media/sprites` for avatars, sidecar subtitle/audio naming patterns.

## 12. Candidate Simplifications for Next Iteration
(Forward-looking suggestions derived from current inventory—kept feature-focused):
- Modularize backend into discrete service layers: Auth, Media Catalog, Playback State, Chat/Presence, Subtitle Service, Audio Service.
- Introduce a lightweight message schema registry (versioned) to decouple client evolution.
- Split admin vs viewer bundles or use progressive enhancement modules to reduce conditional code paths.
- Abstract delivery strategy behind an interface so fairness / direct / future HLS share a contract.
- Externalize subtitle transformation & caching to a dedicated module with deterministic outputs.
- Define explicit state sync diff messages (e.g., state patch events) instead of broad full state sends.
- Provide typed configuration layer (schema + validation) to guard env override drift.

## 13. Items Explicitly Excluded From This Retrospective
Per instructions, logging subsystems, telemetry hooks, test scaffolding (none obvious), and fallback branches or defensive branches are not documented here. Dynamic function instrumentation and detailed fairness scheduling internals likewise omitted.

---
This document should enable drafting a clean specification for a re-architected watchparty service with clearer modular boundaries and maintainable evolution paths.
