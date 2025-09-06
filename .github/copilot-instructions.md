# Copilot Project Instructions — watchparty

These directives guide AI assistance and code suggestions for this repository.
Keep the system minimal, observable, and dependency-light while enabling multi-user robustness.

## 0. Current Prime Objectives
1. Instrumentation: Strengthen runtime visibility to diagnose the first multi-user failure.
2. Logging Consolidation: Two clear channels only:
   - System Log: lifecycle (connections, disconnects, presence timeouts), playback state changes, media load/unload, errors/exceptions, drift alerts, bandwidth summaries, refactor transition notices.
   - User Telemetry Log: explicit user/UI actions (button clicks, seeks initiated, rename attempts, rate-limit hits, subtitle/audio track switches, drift correction events, client error handlers firing).

## 1. Design Principles
- Single-process, in-memory authoritative state (persistence files under `state/`).
- Explicit over magic: small helper functions; no deep inheritance or hidden mutable singletons.
- Bounded growth: ring buffers / capped arrays (chat history, telemetry tail if future in-memory indexing added).
- Fail fast on malformed input; ignore safely when possible.
- Keep diff surface small when refactoring—preserve external behavior and message schemas.

## 2. State & Data Shapes (Canonical)
Playback state (broadcast envelope):
```
{ t:number, paused:boolean, ts:epoch_ms, rev:number, path:string|null }
```
Chat message:
```
{ type:'chat', id:number, name:string, color:string|null, text:string, ts:epoch_ms }
```
Presence list:
```
{ type:'presence', users:[{ id, name, color }] }
```
Rename result:
```
{ type:'rename-result', ok:boolean, reason?:string, color?:string, name?:string }
```
Telemetry entry (file `state/logs/telemetry.log`): JSONL lines with:
```
{ ts, ev, id, guid, color, admin:boolean, data?:object }
```
System log (stdout or future `state/logs/system.log` if redirected) lines should be structured where practical:
```
[SYSTEM] <category> key=value ... message
```
Minimum categories: ws, media, presence, auth, error, drift, perf.

## 3. Logging & Instrumentation Rules
- All connection open/close: System log category `ws` with client id, color, isAdmin.
- Presence timeouts: category `presence` + idleMs.
- Media load/unload: category `media` + filename/relative path + rev.
- Playback transitions (play, pause, seek): category `media` with previous vs new t/paused.
- Errors (catch blocks, JSON parse failures, ffprobe failures): category `error` + err.message.
- Large drift self-report (current behavior >30s) stays System admin-only (`drift`).
- Telemetry: use existing `logTelemetry`; add new events by whitelisting event name constants near logging helper (avoid ad-hoc strings scattering).
- Do NOT duplicate the same event in both logs.
- If adding future structured JSON system file: keep one line per event, no multiline.

## 4. Performance / Safety Guidelines
- Avoid high-frequency timers (<1000ms) unless strictly necessary; current presence sweep is acceptable.
- Ensure any added arrays are truncated or cached by revision (pattern: `cachedXRev`).
- Large synchronous directory walks: keep only on demand endpoints; consider caching results tied to `mediaRev` if they become hot.

## 5. Error Handling Conventions
- Return plain text for simple 4xx/404 or JSON where already established—mixed style is acceptable; do not standardize unless required.
- On recoverable errors (e.g. ffprobe fail): system log an `error` category and return empty result object instead of throwing.
- For WebSocket malformed JSON: ignore silently (system log optional with throttle if future noise observed).

## 6. Style & Structure
- Continue current 2-space indent, semicolons, single quotes.
- Minimal comments; add only for non-obvious logic (episode key extraction heuristics, normalization rules, caching rationale).
- No linting/formatter config ("trust the author").
 - UI styling belongs in CSS files (`app.css`, `theme.css`). Avoid injecting ad-hoc `element.style.*` assignments for static layout (padding, font-size, border-radius, colors) inside JS/HTML except for transient state (hover/active feedback, dynamic measurements). When you see repeated inline style mutations for constant dimensions, extract a semantic class and move rules to CSS.

## 7. User Telemetry Guidance
Event naming examples (lowercase, hyphen-separated):
- `ui-play-click`, `ui-pause-click`, `ui-seek-slider`, `rename-attempt`, `rename-success`, `subtitle-switch`, `audio-track-switch`, `drift-correction`, `rate-limit-hit`, `client-error` (caught window error), `visibility-change` (tab hidden/visible), `reconnect-attempt`.
Add new events by centralizing an exported `TELEMETRY_EVENTS` object (future) to avoid typos.

---

This file should be updated BEFORE implementing major structural changes or introducing new dependencies.

End of instructions.
