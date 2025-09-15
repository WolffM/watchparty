// Direct Delivery Module (legacy simple range streaming)
// Provides straightforward byte-range responses with no fairness scheduling.

import fs from 'fs';

export function serveDirectRange({ req, res, mediaFile, guid, metaLookup }){
  if (!mediaFile || !fs.existsSync(mediaFile)) { res.status(404).send('No media'); return; }
  let stat; try { stat = fs.statSync(mediaFile); } catch { res.status(404).end(); return; }
  const total = stat.size; const range = req.headers.range;
  res.setHeader('Accept-Ranges','bytes');
  res.setHeader('Content-Type', mediaFile.toLowerCase().endsWith('.webm')? 'video/webm':'video/mp4');
  if(!range){ res.setHeader('Content-Length', total); if(req.method==='HEAD') return res.status(200).end(); if(guid){ const meta=metaLookup(guid); if(meta) meta.mediaBytes += total; } return fs.createReadStream(mediaFile).pipe(res); }
  const m=/bytes=(\d*)-(\d*)/.exec(range); if(!m){ res.status(416).end(); return; }
  let start = m[1]? parseInt(m[1],10):0; let end = m[2]? parseInt(m[2],10): total-1; if(isNaN(start)||isNaN(end)||start>end||end>=total){ res.status(416).setHeader('Content-Range',`bytes */${total}`).end(); return; }
  res.status(206); res.setHeader('Content-Range',`bytes ${start}-${end}/${total}`); res.setHeader('Content-Length', end-start+1); if(req.method==='HEAD') return res.end();
  if(guid){ const meta=metaLookup(guid); if(meta){ const served=end-start+1; meta.mediaBytes += served; meta._lastRange={ start,end,bytes:served,ts:Date.now() }; meta._rangeCount=(meta._rangeCount||0)+1; } }
  return fs.createReadStream(mediaFile,{ start,end }).pipe(res);
}
