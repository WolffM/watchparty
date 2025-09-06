// Episode key extraction utility (pure function)
// Derives a normalized episode key from a filename (supports SxxEyy, Exx, and " - 01 " patterns)
export function episodeKeyFromName(name){
  if(!name) return null;
  const base = name.replace(/\.(wp\.mp4|webm)$/i,'');
  const lower = base.toLowerCase();
  let m = lower.match(/(s\d{1,2}e\d{1,3})/i); if (m) return m[1].toUpperCase();
  m = lower.match(/\b(e\d{2,3})\b/i); if (m) return m[1].toUpperCase();
  m = lower.match(/ - (\d{2,3})(?=\s|\[|$)/); if (m) { const num = m[1]; return 'S01E' + num.padStart(2,'0'); }
  return null;
}
export default episodeKeyFromName;
