// Basic access key validation + role detection.
// Future-ready: returns roomId === supplied key (single-room now).
export function validateAccess({ suppliedKey, requestPath, adminKey }) {
  const ok = suppliedKey === adminKey;
  if (!ok) return { ok:false };
  let isAdmin = false;
  try {
    const p = (requestPath||'').split('?')[0];
    isAdmin = p.startsWith('/admin') || p.startsWith('/watchparty-admin');
  } catch {}
  return { ok:true, isAdmin, roomId: suppliedKey };
}

export default { validateAccess };
