import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { AuthStore } from './auth-store.mjs';
import { Bridge } from './bridge.mjs';

const token = process.env.WHATSAPP_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error('Private bridge token is required');
const bridge = new Bridge(new AuthStore(join(process.env.DATA_DIR || '../server/.data', 'whatsapp')));
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  if (!equal(Buffer.from(request.headers.authorization || ''), Buffer.from('Bearer ' + token))) {
    response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  try {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 16384) {
        response.writeHead(413).end(JSON.stringify({ error: 'Body too large' }));
        return;
      }
    }
    const data = body ? JSON.parse(body) : {};
    let result;
    const route = request.method + ' ' + request.url;
    if (route === 'GET /status') result = bridge.status();
    else if (route === 'GET /events') result = bridge.events();
    else if (route === 'POST /connect') result = await bridge.connect({ mode: data.mode, owner_phone_number: data.owner_phone_number || '' }, { renew: data.renew === true });
    else if (route === 'POST /disconnect') result = await bridge.disconnect({ logout: data.logout === true });
    else if (route === 'POST /reply') result = await bridge.reply(data.id, data.text);
    else if (route === 'POST /ack') { bridge.ack(data.id); result = { ok: true }; }
    else { response.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return; }
    response.end(JSON.stringify(result));
  } catch {
    // Third-party exceptions may contain credentials or message contents.
    response.writeHead(409).end(JSON.stringify({ error: 'No se pudo completar la operación de WhatsApp. Revisa el estado e inténtalo de nuevo.' }));
  }
});
server.listen(Number(process.env.WHATSAPP_BRIDGE_PORT || 8787), '127.0.0.1', () => console.log('Dots WhatsApp bridge listening on loopback'));
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await bridge.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
