import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../auth-store.mjs';
import { Bridge } from '../bridge.mjs';

const own = '34612345678@s.whatsapp.net';
const other = '34699999999@s.whatsapp.net';
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
