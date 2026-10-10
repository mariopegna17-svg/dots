import { createHash, randomBytes, randomUUID } from 'node:crypto';
import makeWASocket, { Browsers, DisconnectReason, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

const phoneJid = phone => phone.replace(/^\+/, '') + '@s.whatsapp.net';
const direct = jid => /@(?:s\.whatsapp\.net|lid)$/.test(jid || '');

export class Bridge {
  constructor(store, socketFactory = makeWASocket) {
    this.store = store;
    this.socketFactory = socketFactory;
    this.scope = { mode: 'self', owner_phone_number: '' };
    this.state = 'disconnected';
    this.enabled = false;
    this.generation = randomUUID();
    this.retries = 0;
    this.error = '';
  }

  status() {
    return {
      state: this.state, error: this.error,
      qr: this.qrExpiresAt > Date.now() ? this.qr : null,
      qr_expires_at: this.qrExpiresAt || null,
      account_phone: this.account?.endsWith('@s.whatsapp.net') ? '+' + this.account.split('@')[0] : '',
      mode: this.scope.mode,
      connection_id: this.generation,
    };
  }

  configure(scope) {
    if (!['self', 'separate'].includes(scope.mode) || (scope.mode === 'separate' && !/^\+[1-9][0-9]{6,14}$/.test(scope.owner_phone_number || ''))) {
      throw new Error('Configuración inválida.');
    }
    if (JSON.stringify(scope) !== JSON.stringify(this.scope)) {
      this.generation = randomUUID();
      this.store.data.events = [];
      this.store.save();
    }
    this.scope = scope;
  }

  async connect(scope, { renew = false } = {}) {
    this.configure(scope);
    this.enabled = true;
    if (this.socket && ['connecting', 'qr', 'connected'].includes(this.state) && !(renew && this.state !== 'connected')) return this.status();
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.error = '';
    this.state = 'connecting';
    const auth = this.store.auth();
    const socket = this.socketFactory({
      auth, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Dots'),
      markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: jid => !direct(jid),
      getMessage: async () => undefined,
      connectTimeoutMs: 25000, qrTimeout: 60000,
    });
    this.socket = socket;
    socket.ev.on('creds.update', () => {
      if (this.socket === socket && this.store.data.creds === auth.creds) this.store.save();
    });
    socket.ev.on('connection.update', update => {
      this.connectionUpdate(socket, update).catch(() => this.fail('No se pudo actualizar la conexión. Pulsa Conectar de nuevo.'));
    });
    socket.ev.on('messages.upsert', event => {
      this.accept(socket, event).catch(() => this.fail('No se pudo leer un mensaje de WhatsApp.'));
    });
    return this.status();
  }

  async connectionUpdate(socket, update) {
    if (this.socket !== socket || !this.enabled) return;
    if (update.qr) {
      const qr = await QRCode.toDataURL(update.qr, { margin: 2, width: 320 });
      if (this.socket !== socket || !this.enabled) return;
      this.qr = qr;
      this.qrExpiresAt = Date.now() + 55000;
      this.state = 'qr';
    }
    if (update.connection === 'open') {
      this.state = 'connected';
      this.qr = null;
      this.qrExpiresAt = null;
      this.error = '';
      this.retries = 0;
      this.account = jidNormalizedUser(socket.user?.id || '');
      this.accountLid = jidNormalizedUser(socket.user?.lid || '');
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      this.closeSocket();
      if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden].includes(code)) {
        this.enabled = false;
        if (code !== DisconnectReason.connectionReplaced) this.store.reset();
        this.fail('La sesión se ha cerrado. Pulsa Conectar y vuelve a vincular WhatsApp.');
        return;
      }
      this.state = 'reconnecting';
      this.retryTimer = setTimeout(() => {
        if (this.enabled) this.connect(this.scope).catch(() => this.fail('No se pudo conectar con WhatsApp. Vuelve a intentarlo.'));
      }, code === DisconnectReason.restartRequired ? 500 : Math.min(30000, 2000 * 2 ** Math.min(this.retries++, 4)));
    }
  }

  fail(message) { this.error = message; this.state = 'error'; }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    this.qr = null;
    this.qrExpiresAt = null;
    socket?.end(new Error('Dots disconnected'));
  }

  async disconnect({ logout = false } = {}) {
    this.enabled = false;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null; // Invalidate event handlers before logout emits events.
    if (logout) {
      try { await socket?.logout(); } catch { /* Local credentials still removed. */ }
    }
    socket?.end(new Error('Dots disconnected'));
    this.state = 'disconnected';
    this.qr = null;
    this.qrExpiresAt = null;
    this.error = '';
    this.account = '';
    this.accountLid = '';
    this.generation = randomUUID();
    this.store.data.events = [];
    if (logout) this.store.reset();
    else this.store.save();
    return this.status();
  }

  async permittedPeer(socket, key) {
    if (typeof key?.remoteJid !== 'string' || !direct(key.remoteJid)) return false;
    const peer = jidNormalizedUser(key.remoteJid);
    // Our own LID is already authenticated by this socket. An unrelated
    // contact lookup must not disable an otherwise healthy connection.
    if (this.scope.mode === 'self' && this.accountLid && peer === this.accountLid) return true;
    let pn = peer;
    if (peer.endsWith('@lid')) {
      try {
        pn = typeof key.remoteJidAlt === 'string' && key.remoteJidAlt.endsWith('@s.whatsapp.net') ? jidNormalizedUser(key.remoteJidAlt) :
          await socket.signalRepository?.lidMapping?.getPNForLID(peer);
      } catch {
        // Unresolved peers stay unauthorized; do not mark the socket offline.
        return false;
      }
      pn = typeof pn === 'string' ? jidNormalizedUser(pn) : '';
    }
    if (this.scope.mode === 'self') return (pn && pn === this.account) || (this.accountLid && peer === this.accountLid);
    return !key.fromMe && pn === phoneJid(this.scope.owner_phone_number) && pn !== this.account;
  }

  async accept(socket, event) {
    // notify only: history sync and reconnect backfills must not trigger replies.
    if (this.socket !== socket || this.state !== 'connected' || !this.enabled || event?.type !== 'notify') return;
    for (const message of Array.isArray(event.messages) ? event.messages : []) {
      const id = message?.key?.id;
      if (typeof id !== 'string' || !id || this.store.data.seen.includes(id) || this.store.data.outgoing.includes(id)) continue;
      const generation = this.generation;
      if (!(await this.permittedPeer(socket, message.key))) continue;
      if (this.socket !== socket || generation !== this.generation || !this.enabled) return;
      let body;
      try { body = normalizeMessageContent(message.message); } catch { continue; }
      const rawText = body?.conversation || body?.extendedTextMessage?.text;
      const text = typeof rawText === 'string' ? rawText.trim() : '';
      if (!text || text.length > 4000 || this.store.data.events.length >= 50) continue;
      this.store.data.seen = [...this.store.data.seen, id].slice(-1000);
      this.store.data.events.push({ id, peer: message.key.remoteJid, text, generation });
      this.store.save();
    }
  }

  events() { return this.store.data.events.slice(0, 1); }

  ack(id) {
    this.store.data.events = this.store.data.events.filter(event => event.id !== id);
    this.store.save();
  }

  async sendOwner(data) {
    const account = this.status().account_phone;
    const owner = this.scope.mode === 'self' ? account : this.scope.owner_phone_number;
    if (!this.enabled || this.state !== 'connected' || !this.socket || !/^\+[1-9][0-9]{6,14}$/.test(account) ||
        data.connection_id !== this.generation || data.account_phone !== account || data.mode !== this.scope.mode ||
        data.owner_phone_number !== owner || (this.scope.mode === 'separate' && owner === account)) {
      throw new Error('La conexión o el destinatario han cambiado.');
    }
    if (!/^[a-f0-9]{32}$/.test(data.id || '') || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 1500) {
      throw new Error('Mensaje inválido.');
    }
    const text = data.text.trim();
    const digest = createHash('sha256').update(JSON.stringify([text, account, owner, this.scope.mode, this.generation])).digest('hex');
    this.store.data.ownerSends ||= [];
    const previous = this.store.data.ownerSends.find(item => item.id === data.id);
    if (previous) {
      if (previous.digest !== digest || !previous.sent) throw new Error('No se pudo confirmar el envío anterior. Revisa WhatsApp.');
      return { id: previous.sent, status: 'sent' };
    }
    const idOut = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
    const record = { id: data.id, digest };
    this.store.data.ownerSends = [...this.store.data.ownerSends, record].slice(-1000);
    this.store.data.outgoing = [...this.store.data.outgoing, idOut].slice(-1000);
    // Persist the attempt and echo ID before dispatch; uncertain retries never resend.
    this.store.save();
    const result = await this.socket.sendMessage(phoneJid(owner), { text }, { messageId: idOut });
    if (!result?.key?.id) throw new Error('WhatsApp no confirmó el envío.');
    record.sent = result.key.id;
    if (!this.store.data.outgoing.includes(record.sent)) this.store.data.outgoing.push(record.sent);
    this.store.data.outgoing = this.store.data.outgoing.slice(-1000);
    this.store.save();
    return { id: record.sent, status: 'sent' };
  }

  async reply(id, text) {
    const event = this.store.data.events.find(item => item.id === id);
    if (!event || !this.enabled || this.state !== 'connected' || event.generation !== this.generation) throw new Error('La conexión ha cambiado.');
    if (event.sent) return { id: event.sent, status: 'sent' };
    if (event.attempted) throw new Error('No se pudo confirmar la entrega. Revisa WhatsApp.');
    if (typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error('Respuesta inválida.');
    const idOut = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
    // Save before sending so echoes and uncertain retries cannot create loops.
    event.attempted = true;
    this.store.data.outgoing = [...this.store.data.outgoing, idOut].slice(-1000);
    this.store.save();
    const result = await this.socket.sendMessage(event.peer, { text }, { messageId: idOut });
    event.sent = result?.key?.id || idOut;
    if (!this.store.data.outgoing.includes(event.sent)) this.store.data.outgoing.push(event.sent);
    this.store.data.outgoing = this.store.data.outgoing.slice(-1000);
    this.store.save();
    return { id: event.sent, status: 'sent' };
  }
}
