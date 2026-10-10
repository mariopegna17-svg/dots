import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { getMediaKeys } from '@whiskeysockets/baileys';
import { downloadMediaContent } from '../media-download.mjs';

async function fixture(kind = 'image') {
  const mediaKey = Buffer.alloc(32, 42);
  const plaintext = Buffer.from('example WhatsApp owner attachment');
  const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, kind);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  const encrypted = Buffer.concat([ciphertext, mac]);
  return { plaintext, encrypted, message: { mediaKey, url: 'https://mmg.whatsapp.net/file',
    fileSha256: createHash('sha256').update(plaintext).digest(), fileEncSha256: createHash('sha256').update(encrypted).digest() } };
}

const options = { host: 'mmg.whatsapp.net', options: { signal: new AbortController().signal } };
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('photo and audio WhatsApp ciphertext really authenticate and decrypt with Baileys keys', async () => {
  for (const kind of ['image', 'audio']) {
    const { message, encrypted, plaintext } = await fixture(kind);
    const stream = await downloadMediaContent(message, kind, options, async (url, config) => {
      assert.equal(url.hostname, 'mmg.whatsapp.net');
      assert.equal(config.redirect, 'error');
      assert.equal(config.signal, options.options.signal);
      return new Response(encrypted);
    });
    assert.deepEqual(await collect(stream), plaintext);
  }
});

test('tampered media or incorrect advertised hashes never become model inputs', async () => {
  const { message, encrypted } = await fixture();
  const tampered = Buffer.from(encrypted);
  tampered[0] ^= 1;
  await assert.rejects(downloadMediaContent(message, 'image', options, async () => new Response(tampered)), /authentication/);
  await assert.rejects(downloadMediaContent({ ...message, fileSha256: Buffer.alloc(32) }, 'image', options, async () => new Response(encrypted)), /digest/);
  await assert.rejects(downloadMediaContent({ ...message, fileEncSha256: Buffer.alloc(32) }, 'image', options, async () => new Response(encrypted)), /digest/);
});

test('the real downloader rejects foreign hosts before any fetch and caps encrypted response bytes', async () => {
  const { message } = await fixture();
  let fetched = false;
  await assert.rejects(downloadMediaContent({ ...message, url: 'https://127.0.0.1/file' }, 'image', options, async () => { fetched = true; }), /host/);
  assert.equal(fetched, false);
  await assert.rejects(downloadMediaContent(message, 'image', options, async () => new Response(Buffer.alloc(6 * 1024 * 1024 + 27))), /demasiado grande/);
});

test('aborting the download reaches the HTTP request and releases the pending operation', async () => {
  const { message } = await fixture();
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = downloadMediaContent(message, 'image', { ...options, options: { signal: controller.signal } }, async (url, config) => {
    started();
    return new Promise((resolve, reject) => config.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  await ready;
  controller.abort();
  await assert.rejects(pending, /aborted/);
});
