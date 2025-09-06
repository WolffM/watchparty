import { spawnSync } from 'child_process';

// Cached probe results keyed by (rev,file)
let cachedRev = -1;
let cachedFile = null;
let cachedList = [];

export function probeAudioStreams(file, mediaRev){
  try {
    if (!file) return [];
    if (cachedRev === mediaRev && cachedFile === file && cachedList.length) return cachedList;
    const args = [
      '-v','error',
      '-select_streams','a',
      '-show_entries','stream=index,codec_name,channels,sample_rate:stream_tags=language,title:stream_disposition=default',
      '-of','json',
      file
    ];
    const res = spawnSync('ffprobe', args, { encoding: 'utf8' });
    if (res.error) { console.warn('[ffprobe] spawn error', res.error); return []; }
    const txt = (res.stdout||'').trim();
    if (!txt) return [];
    let j; try { j = JSON.parse(txt); } catch { return []; }
    const out = [];
    if (j && Array.isArray(j.streams)) {
      for (const s of j.streams) {
        out.push({
          index: s.index,
          lang: (s.tags && (s.tags.language || s.tags.LANGUAGE) || '').toLowerCase(),
          title: (s.tags && (s.tags.title || s.tags.TITLE) || ''),
          codec: s.codec_name || '',
          channels: s.channels || null,
          sample_rate: s.sample_rate ? Number(s.sample_rate) : null,
          default: !!(s.disposition && s.disposition.default)
        });
      }
    }
    cachedList = out;
    cachedRev = mediaRev;
    cachedFile = file;
    return out;
  } catch (e) {
    console.warn('[ffprobe] error', e); return [];
  }
}

export default { probeAudioStreams };
