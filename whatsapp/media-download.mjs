import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { getMediaKeys } from '@whiskeysockets/baileys';

// Use Baileys' WhatsApp key derivation, but own the bounded HTTP fetch:
// the library's current getHttpStream ignores AbortSignal and redirect options.
export async function downloadMediaContent(message, kind, { host, options }, fetcher = fetch) {
  const limit = (kind === 'image' ? 6 : 8) * 1024 * 1024;
  const url = new URL(message.directPath ? `https://${host}${message.directPath}` : message.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.whatsapp.net') || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Invalid media host');
  const response = await fetcher(url, { signal: options.signal, redirect: 'error', headers: { Origin: 'https://web.whatsapp.com' } });
  if (!response.ok || !response.body) throw new Error('Media unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    // PKCS7 padding adds <=16 bytes, then WhatsApp appends a 10-byte MAC.
    if (size > limit + 26) throw new Error('El archivo es demasiado grande. Envía una foto de hasta 6 MB o un audio de hasta 8 MB.');
    chunks.push(Buffer.from(chunk));
  }
  const encrypted = Buffer.concat(chunks, size);
  if (encrypted.length < 26) throw new Error('Invalid media');
  const { cipherKey, iv, macKey } = await getMediaKeys(message.mediaKey, kind);
  const ciphertext = encrypted.subarray(0, -10);
  const mac = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, encrypted.subarray(-10))) throw new Error('Invalid media authentication');
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  for (const [expected, content] of [[message.fileSha256, bytes], [message.fileEncSha256, encrypted]]) {
    if (expected && (!Buffer.isBuffer(expected) && !(expected instanceof Uint8Array) || expected.length !== 32 || !timingSafeEqual(Buffer.from(expected), createHash('sha256').update(content).digest()))) throw new Error('Invalid media digest');
  }
  return Readable.from([bytes]);
}
