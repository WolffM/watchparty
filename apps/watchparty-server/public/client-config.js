// Central client-side configuration extracted from inline scripts
// Adjust values here instead of editing large inline script blocks.
window.WP_CLIENT_CONFIG = {
  version: 'milestone-3',
  styleIds: ['default','outline','yellow','box'],
  langDisplay: {
    eng: 'English', en: 'English',
    jpn: 'Japanese', ja: 'Japanese',
    ger: 'German', de: 'German',
    spa: 'Spanish', es: 'Spanish',
    'spa.spanish-latin-america': 'Spanish (Latin America)',
    'spanish-latin-america': 'Spanish (Latin America)',
    por: 'Portuguese', pt: 'Portuguese',
    ita: 'Italian', it: 'Italian',
    rus: 'Russian', ru: 'Russian',
    fre: 'French', fr: 'French',
    ara: 'Arabic', ar: 'Arabic',
    chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
    kor: 'Korean', ko: 'Korean',
    vie: 'Vietnamese', vi: 'Vietnamese',
    tur: 'Turkish', tr: 'Turkish'
  },
  chat: {
    hideAfterMs: 10000,
    floating: { maxMessages: 12, lifetimeMs: 9000, fadeMs: 1500 }
  },
  drift: { alertThresholdSec: 30, checkIntervalMs: 5000 },
  subtitles: {
    preferredLang: 'eng',
    autoEnableRetriesInitial: 5,
    autoEnableRetriesMetadata: 3,
    autoEnableDelayMs: 300,
    trackInitDelayMs: 180,
    layoutRefreshIntervalMs: 600
  },
  telemetry: { sampleIntervalMs: 1000 },
  dev: { refreshIntervalMs: 4000 },
  network: { pingIntervalMs: 5000 },
  transitions: { wipeDurationMs: 1260, wipeCleanupExtraMs: 40 }, // total used ~ wipeDurationMs + wipeCleanupExtraMs
  starfield: {
    maxStars: 1600,
    densityDivisor: 2200,
    speedMin: 0.000135,
    speedVar: 0.00036,
    recycleZ: 0.0005,
    fadeOutMs: 520,
    fadeCssMs: 500
  },
  controls: {
    initialShowDelayMs: 100,
    seekInitialResizeDelayMs: 400,
    seekResizeIntervalMs: 1500
  },
  audio: {
    sidecarSyncIntervalMs: 750,
    sidecarGuardIntervalMs: 1000,
    trackScanDelayMs: 100
  },
  toast: { durationMs: 2200, fadeMs: 400 }
};
