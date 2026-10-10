import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../auth-store.mjs';
import { Readable } from 'node:stream';
import { Bridge } from '../bridge.mjs';

const own = '34612345678@s.whatsapp.net';
const other = '34699999999@s.whatsapp.net';
const ownerRequest = (bridge, overrides = {}) => ({ id: 'a'.repeat(32), text: '2+2=4', connection_id: bridge.generation,
  account_phone: bridge.status().account_phone, mode: bridge.scope.mode,
  owner_phone_number: bridge.scope.mode === 'self' ? bridge.status().account_phone : bridge.scope.owner_phone_number, ...overrides });
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dots-wa-test-'));
  const store = new AuthStore(directory);
  const sends = [];
  const sockets = [];
  const bridge = new Bridge(store, () => {
    const socket = {
      ev: new EventEmitter(), user: { id: '34612345678:1@s.whatsapp.net', lid: '999:1@lid' },
      signalRepository: { lidMapping: { getPNForLID: async lid => lid === '999@lid' ? own : other } },
      sendMessage: async (peer, body, options) => { sends.push({ peer, body, options }); return { key: { id: options.messageId } }; },
      end() {}, async logout() {},
    };
    sockets.push(socket);
    return socket;
  });
  t.after(async () => { await bridge.disconnect(); rmSync(directory, { recursive: true, force: true }); });
  const open = async scope => {
    await bridge.connect(scope || { mode: 'self', owner_phone_number: '' });
    await bridge.connectionUpdate(bridge.socket, { connection: 'open' });
  };
  const receive = async (id, peer, { fromMe = true, type = 'notify', text = 'Hola', alt } = {}) => bridge.accept(bridge.socket, { type, messages: [{ key: { id, remoteJid: peer, fromMe, remoteJidAlt: alt }, message: { conversation: text } }] });
  return { store, bridge, sends, sockets, open, receive, directory };
}

const attachment = (id, kind, peer = own, overrides = {}) => ({ type: 'notify', messages: [{
  key: { id, remoteJid: peer, fromMe: true },
  message: { [kind + 'Message']: { mimetype: kind === 'image' ? 'image/jpeg' : 'audio/ogg; codecs=opus', fileLength: 8, seconds: 2, ...overrides } },
}] });

test('owner photos and voice notes are encrypted, queued once and erased after acknowledgment', async t => {
  const { bridge, store, open, directory } = setup(t);
  await open();
  const bytes = Buffer.from('private-media-bytes');
  let downloads = 0;
  bridge.mediaDownloader = async () => { downloads++; return Readable.from([bytes]); };
  await bridge.accept(bridge.socket, attachment('photo', 'image', own, { caption: '¿Qué pone aquí?' }));
  assert.equal(bridge.events()[0].text, '¿Qué pone aquí?');
  assert.equal(bridge.events()[0].media.kind, 'image');
  assert.deepEqual(bridge.media('photo').bytes, bytes);
  const encrypted = join(directory, 'media', store.mediaName('photo'));
  assert.equal(readFileSync(encrypted).includes(bytes), false);
  assert.equal(statSync(encrypted).mode & 0o777, 0o600);
  assert.equal(readFileSync(store.file).includes(bytes), false);
  assert.deepEqual(new AuthStore(directory).readMedia('photo'), bytes);
  await Promise.all([bridge.accept(bridge.socket, attachment('voice', 'audio')), bridge.accept(bridge.socket, attachment('voice', 'audio'))]);
  assert.equal(downloads, 2);
  bridge.ack('photo');
  assert.throws(() => readFileSync(encrypted));
  assert.equal(bridge.events()[0].media.kind, 'audio');
  assert.equal(bridge.events()[0].media.mime, 'audio/ogg');
  bridge.ack('voice');
  assert.deepEqual(bridge.events(), []);
});

test('attachments from other chats, groups, history and bot echoes never get downloaded', async t => {
  const { bridge, open, store } = setup(t);
  await open();
  let downloads = 0;
  bridge.mediaDownloader = async () => { downloads++; return Readable.from([Buffer.from('safe')]); };
  for (const peer of [other, '123@g.us', 'status@broadcast']) await bridge.accept(bridge.socket, attachment('blocked-' + peer, 'image', peer));
  await bridge.accept(bridge.socket, { ...attachment('old-photo', 'image'), type: 'append' });
  store.data.outgoing.push('echo-photo');
  await bridge.accept(bridge.socket, attachment('echo-photo', 'image'));
  assert.equal(downloads, 0);
  assert.deepEqual(bridge.events(), []);
  assert.equal(bridge.state, 'connected');
});

test('oversize, long, corrupt and unsupported media produce one helpful event and keep WhatsApp connected', async t => {
  const { bridge, open, receive } = setup(t);
  await open();
  let downloads = 0;
  bridge.mediaDownloader = async () => { downloads++; throw new Error('credential-secret must never be exposed'); };
  for (const [id, kind, fields, error] of [
    ['large', 'image', { fileLength: 7 * 1024 * 1024 }, 'demasiado grande'],
    ['long', 'audio', { seconds: 121 }, 'demasiado largo'],
    ['format', 'image', { mimetype: 'text/html' }, 'Formato'],
    ['broken', 'audio', {}, 'descargar'],
  ]) {
    await bridge.accept(bridge.socket, attachment(id, kind, own, fields));
    assert.match(bridge.events()[0].media_error, new RegExp(error));
    assert.doesNotMatch(bridge.events()[0].media_error, /secret/);
    await bridge.accept(bridge.socket, attachment(id, kind, own, fields));
    assert.equal(bridge.store.data.events.length, 1);
    bridge.ack(id);
  }
  assert.equal(downloads, 1);
  assert.equal(bridge.state, 'connected');
  await receive('next-text', own);
  assert.equal(bridge.events()[0].text, 'Hola');
});

test('the actual stream size is bounded even if WhatsApp metadata understates it', async t => {
  const { bridge, open } = setup(t);
  await open();
  bridge.mediaDownloader = async () => Readable.from([Buffer.alloc(4 * 1024 * 1024), Buffer.alloc(4 * 1024 * 1024)]);
  await bridge.accept(bridge.socket, attachment('oversize-stream', 'image'));
  assert.match(bridge.events()[0].media_error, /demasiado grande/);
  assert.equal(bridge.events()[0].media, undefined);
});

test('disconnect during media download never queues or stores the old attachment', async t => {
  const { bridge, open, store } = setup(t);
  await open();
  bridge.mediaDownloader = async () => {
    await bridge.disconnect();
    return Readable.from([Buffer.from('discard')]);
  };
  await bridge.accept(bridge.socket, attachment('late', 'image'));
  assert.deepEqual(bridge.events(), []);
  assert.throws(() => store.readMedia('late'));
});

test('media URLs cannot fetch private addresses or follow redirects', async t => {
  const { bridge, open } = setup(t);
  await open();
  let downloads = 0;
  bridge.mediaDownloader = async (message, kind, options) => {
    downloads++;
    assert.equal(options.options.redirect, 'error');
    assert.equal(options.host, 'mmg.whatsapp.net');
    return Readable.from([Buffer.from('safe')]);
  };
  for (const [id, fields] of [
    ['private', { url: 'http://127.0.0.1:8000/admin' }],
    ['foreign', { url: 'https://example.com/file' }],
    ['credentials', { url: 'https://user:password@mmg.whatsapp.net/file' }],
    ['path', { directPath: '//private/file' }],
  ]) {
    await bridge.accept(bridge.socket, attachment(id, 'image', own, fields));
    assert.match(bridge.events()[0].media_error, /descargar/);
    bridge.ack(id);
  }
  assert.equal(downloads, 0);
  await bridge.accept(bridge.socket, attachment('valid', 'image', own, { url: 'https://mmg.whatsapp.net/file', directPath: '/v/t62/file' }));
  assert.equal(downloads, 1);
});

test('encrypted credentials and Signal buffers survive restart; corrupt state fails closed', async t => {
  const { store, directory } = setup(t);
  store.data.creds.testSecret = 'never-publish-session';
  await store.auth().keys.set({ session: { example: Buffer.from([1, 2, 3]) } });
  assert.equal(readFileSync(store.file).includes(Buffer.from('never-publish-session')), false);
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'session.key')).mode & 0o777, 0o600);
  const reopened = new AuthStore(directory);
  assert.equal(reopened.data.creds.testSecret, 'never-publish-session');
  assert.deepEqual((await reopened.auth().keys.get('session', ['example'])).example, Buffer.from([1, 2, 3]));
  await reopened.auth().keys.set({ session: { example: null } });
  assert.equal((await reopened.auth().keys.get('session', ['example'])).example, undefined);
  writeFileSync(store.file, 'corrupt');
  assert.throws(() => new AuthStore(directory));
});

test('self chat replies once and ignores duplicates, echoes, groups, other chats and history', async t => {
  const { bridge, open, receive, sends } = setup(t);
  assert.equal(bridge.state, 'disconnected');
  await open();
  await receive('old', own, { type: 'append' });
  await receive('group', '123@g.us');
  await receive('other', other, { fromMe: false });
  await receive('outgoing-other', other);
  await receive('real', own);
  await receive('real', own);
  assert.equal(bridge.events().length, 1);
  assert.equal(bridge.status().account_phone, '+34612345678');
  const result = await bridge.reply('real', 'Hola, soy tu Dot');
  await bridge.reply('real', 'No debe reenviarse');
  await receive(result.id, own);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].peer, own);
  assert.equal(sends[0].body.text, 'Hola, soy tu Dot');
  bridge.ack('real');
  assert.equal(bridge.events().length, 0);
});

test('private chats using WhatsApp LIDs resolve to the authorized phone', async t => {
  const { bridge, open, receive } = setup(t);
  await open();
  await receive('self-lid', '999@lid');
  assert.equal(bridge.events().length, 1);
  bridge.ack('self-lid');
  await open({ mode: 'separate', owner_phone_number: '+34699999999' });
  await receive('owner-lid', '888@lid', { fromMe: false });
  assert.equal(bridge.events()[0].id, 'owner-lid');
});

test('separate-number mode only accepts the owner and never sent or self messages', async t => {
  const { bridge, open, receive } = setup(t);
  await open({ mode: 'separate', owner_phone_number: '+34699999999' });
  await receive('self', own);
  await receive('sent', other);
  await receive('stranger', '34611111111@s.whatsapp.net', { fromMe: false });
  await receive('allowed', other, { fromMe: false });
  assert.deepEqual(bridge.events().map(event => event.id), ['allowed']);
});

test('disconnect and changing the allowed phone block already generated replies', async t => {
  const { bridge, open, receive, sends } = setup(t);
  await open();
  await receive('before-disconnect', own);
  await bridge.disconnect({ logout: true });
  await assert.rejects(bridge.reply('before-disconnect', 'Respuesta'));
  await open();
  await receive('before-change', own);
  bridge.configure({ mode: 'separate', owner_phone_number: '+34699999999' });
  await assert.rejects(bridge.reply('before-change', 'Respuesta'));
  assert.equal(sends.length, 0);
  assert.equal(bridge.store.data.creds.testSecret, undefined);
});

test('uncertain sends never automatically resend', async t => {
  const { bridge, open, receive } = setup(t);
  await open();
  await receive('failure', own);
  let count = 0;
  bridge.socket.sendMessage = async () => { count++; throw new Error('Network down'); };
  await assert.rejects(bridge.reply('failure', 'Hola'));
  await assert.rejects(bridge.reply('failure', 'Hola'));
  assert.equal(count, 1);
});

test('QR renews, expires privately, and logout invalidates stale socket events', async t => {
  const { bridge, sockets } = setup(t);
  const scope = { mode: 'self', owner_phone_number: '' };
  await bridge.connect(scope);
  const first = bridge.socket;
  await bridge.connectionUpdate(first, { qr: 'test-qr-no-real-account' });
  assert.match(bridge.status().qr, /^data:image\/png;base64,/);
  bridge.qrExpiresAt = Date.now() - 1;
  assert.equal(bridge.status().qr, null);
  await bridge.connect(scope, { renew: true });
  assert.equal(sockets.length, 2);
  await bridge.connectionUpdate(first, { connection: 'open' });
  assert.equal(bridge.state, 'connecting');
  await bridge.disconnect({ logout: true });
  await bridge.connectionUpdate(sockets[1], { qr: 'stale' });
  assert.equal(bridge.status().qr, null);
  assert.equal(bridge.state, 'disconnected');
});

test('web messages reach the self chat without an incoming event and cannot trigger an echo loop', async t => {
  const { bridge, open, receive, sends, store, directory } = setup(t);
  await open();
  assert.equal(bridge.events().length, 0);
  const data = ownerRequest(bridge);
  const result = await bridge.sendOwner(data);
  assert.deepEqual(await bridge.sendOwner(data), result);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].peer, own);
  assert.equal(sends[0].body.text, '2+2=4');
  await receive(result.id, own);
  assert.equal(bridge.events().length, 0);
  assert.equal(readFileSync(store.file).includes(Buffer.from('2+2=4')), false);
  assert.equal(new AuthStore(directory).data.ownerSends[0].sent, result.id);
});

test('new explicit requests may send identical text while replaying one ID never repeats it', async t => {
  const { bridge, open, receive, sends, store, directory } = setup(t);
  await open();
  const first = ownerRequest(bridge, { id: '1'.repeat(32) });
  const firstResult = await bridge.sendOwner(first);
  await receive(firstResult.id, own);
  const reloaded = new AuthStore(directory);
  assert.equal(reloaded.data.ownerSends[0].sent, firstResult.id);
  // Simulate reloading the encrypted state without opening any real socket.
  bridge.store = reloaded;
  for (const id of ['2'.repeat(32), '3'.repeat(32)]) {
    const request = ownerRequest(bridge, { id });
    const result = await bridge.sendOwner(request);
    assert.deepEqual(await bridge.sendOwner(request), result);
    await receive(result.id, own);
  }
  assert.equal(sends.length, 3);
  assert.equal(new Set(sends.map(item => item.options.messageId)).size, 3);
  assert.equal(sends.every(item => item.peer === own && item.body.text === '2+2=4'), true);
  assert.deepEqual(await bridge.sendOwner(first), firstResult);
  assert.equal(sends.length, 3);
  assert.equal(bridge.events().length, 0);
  assert.equal(store.data.ownerSends.length, 1);
});

test('a failed unrelated LID or malformed event does not disable the next owner send', async t => {
  const { bridge, open, sends } = setup(t);
  await open();
  await bridge.sendOwner(ownerRequest(bridge, { id: '1'.repeat(32) }));
  bridge.socket.signalRepository.lidMapping.getPNForLID = async () => { throw new Error('Fixture private lookup failure'); };
  bridge.socket.ev.emit('messages.upsert', { type: 'notify', messages: [
    { key: { id: 'unrelated-lid', remoteJid: '888@lid', fromMe: false }, message: { conversation: 'Mensaje ajeno.' } },
    null,
    { key: { id: 'malformed-owner', remoteJid: own, fromMe: true }, message: { conversation: { invalid: true } } },
  ] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.state, 'connected');
  assert.equal(bridge.error, '');
  assert.equal(bridge.events().length, 0);
  await bridge.sendOwner(ownerRequest(bridge, { id: '2'.repeat(32) }));
  assert.equal(sends.length, 2);
  assert.equal(sends.every(item => item.peer === own), true);
  await bridge.accept(bridge.socket, { type: 'notify', messages: [{ key: { id: 'real-self-lid', remoteJid: '999@lid', fromMe: true }, message: { conversation: 'Nueva pregunta propia.' } }] });
  assert.equal(bridge.events()[0].id, 'real-self-lid');
});

test('web messages in separate-number mode can only reach the configured owner', async t => {
  const { bridge, open, sends } = setup(t);
  await open({ mode: 'separate', owner_phone_number: '+34699999999' });
  await assert.rejects(bridge.sendOwner(ownerRequest(bridge, { owner_phone_number: '+34611111111' })));
  await bridge.sendOwner(ownerRequest(bridge));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].peer, other);
});

test('changed connection, account, scope and disconnect invalidate approved web messages', async t => {
  const { bridge, open, sends } = setup(t);
  await open();
  const data = ownerRequest(bridge);
  await assert.rejects(bridge.sendOwner({ ...data, connection_id: 'stale' }));
  await assert.rejects(bridge.sendOwner({ ...data, account_phone: '+34611111111' }));
  bridge.configure({ mode: 'separate', owner_phone_number: '+34699999999' });
  await assert.rejects(bridge.sendOwner(data));
  const separate = ownerRequest(bridge);
  await bridge.disconnect();
  await assert.rejects(bridge.sendOwner(separate));
  assert.equal(sends.length, 0);
});

test('uncertain and concurrent web requests never dispatch the same message twice', async t => {
  const { bridge, open } = setup(t);
  await open();
  let count = 0;
  bridge.socket.sendMessage = async () => { count++; throw new Error('Uncertain network result'); };
  const data = ownerRequest(bridge);
  const results = await Promise.allSettled([bridge.sendOwner(data), bridge.sendOwner(data)]);
  assert.equal(results.every(item => item.status === 'rejected'), true);
  await assert.rejects(bridge.sendOwner(data));
  assert.equal(count, 1);
});

test('an explicitly new request is allowed after an uncertain earlier request remains blocked', async t => {
  const { bridge, open } = setup(t);
  await open();
  let count = 0;
  bridge.socket.sendMessage = async () => { count++; throw new Error('Fixture uncertain result'); };
  const first = ownerRequest(bridge, { id: '1'.repeat(32) });
  await assert.rejects(bridge.sendOwner(first));
  bridge.socket.sendMessage = async (_peer, _body, options) => { count++; return { key: { id: options.messageId } }; };
  await assert.rejects(bridge.sendOwner(first));
  const second = ownerRequest(bridge, { id: '2'.repeat(32) });
  const result = await bridge.sendOwner(second);
  assert.equal(result.status, 'sent');
  assert.deepEqual(await bridge.sendOwner(second), result);
  assert.equal(count, 2);
});

test('invalid messages and unconfirmed results are never reported as successful', async t => {
  const { bridge, open, sends } = setup(t);
  await open();
  for (const changes of [{ text: '' }, { text: 'x'.repeat(1501) }, { id: '../invalid' }]) {
    await assert.rejects(bridge.sendOwner(ownerRequest(bridge, changes)));
  }
  assert.equal(sends.length, 0);
  let count = 0;
  bridge.socket.sendMessage = async () => { count++; return undefined; };
  await assert.rejects(bridge.sendOwner(ownerRequest(bridge)));
  await assert.rejects(bridge.sendOwner(ownerRequest(bridge)));
  assert.equal(count, 1);
});
