// Simple WebSocket smoke test (optional) - run with: node scripts/ws-smoke.mjs
import WebSocket from 'ws';

const KEY = process.env.ADMIN_KEY || 'testkey123';
const URL = process.env.WS_URL || 'ws://localhost:3000';

const a = new WebSocket(URL);
const b = new WebSocket(URL);

function once(ws, event) { return new Promise(res => ws.once(event, res)); }

async function run(){
  await Promise.all([once(a,'open'), once(b,'open')]);
  console.log('Both clients connected');
  const received = new Promise(res => b.on('message', data => res(data.toString())));
  a.send(JSON.stringify({ cmd:'play', key: KEY }));
  const msg = await Promise.race([received, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),2000))]);
  console.log('Client B received:', msg);
  a.close(); b.close();
}
run().catch(e => { console.error(e); process.exit(1); });