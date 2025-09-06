import path from 'path';

// Central configuration (override via environment variables when applicable)
const ROOT = process.cwd();

export const config = {
  media: {
    outputDir: process.env.MEDIA_OUTPUT_DIR || path.join(ROOT, 'media', 'output'),
    spritesDir: process.env.MEDIA_SPRITES_DIR || path.join(ROOT, 'media', 'sprites')
  },
  chat: {
    historyLimit: Number(process.env.CHAT_HISTORY_LIMIT || 200),
    historySend: Number(process.env.CHAT_HISTORY_SEND || 100),
    rateMax: Number(process.env.CHAT_RATE_MAX || 5),
    rateWindowMs: Number(process.env.CHAT_RATE_WINDOW_MS || 5000)
  },
  presence: {
    timeoutMs: Number(process.env.PRESENCE_TIMEOUT_MS || 40000),
    sweepIntervalMs: Number(process.env.PRESENCE_SWEEP_INTERVAL || 10000)
  },
  roles: {
    colorPalette: (process.env.COLOR_PALETTE || 'frieren,himmel,heiter,eisen,fern,stark,sein,übel').split(',').map(s=>s.trim()).filter(Boolean),
    colorHex: {
      frieren: '#7f7c84',
      himmel:  '#bddaf9',
      heiter:  '#78855e',
      eisen:   '#cfccc0',
      fern:    '#794983',
      stark:   '#af4a33',
      sein:    '#936f42',
      'übel':  '#667240'
    }
  },
  routes: {
    // Accepted viewer entry paths (all gated). Root '/' redirects to '/watchparty'.
    viewer: [
      '/watchparty','/watchparty/','/watchparty/index.html',
      '/index.html' // kept for backward compatibility (not labeled legacy)
    ],
    // Accepted admin entry paths (all gated).
    admin: [
      '/watchparty-admin','/watchparty-admin/','/watchparty-admin/index.html',
      '/admin','/admin.html' // backward compatible admin paths
    ]
  },
  auth: {
    allowAutoKey: process.env.ALLOW_AUTO_KEY !== '0' // whether to accept ?admin=auto
  },
  subtitles: {
    // future placeholders (e.g., default language preference list)
  }
};

export default config;
