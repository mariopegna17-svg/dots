import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

// A personal, single-process bridge: atomic encrypted snapshots include every
// Signal key update. Never log credentials, QR contents or WhatsApp messages.
export class AuthStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.file = join(directory, 'session.enc');
    const keyFile = join(directory, 'session.key');
    if (!existsSync(keyFile)) {
      if (existsSync(this.file)) throw new Error('Missing WhatsApp encryption key');
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Invalid WhatsApp encryption key');
    chmodSync(keyFile, 0o600);
    if (existsSync(this.file)) {
      const bytes = readFileSync(this.file);
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      this.data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(), BufferJSON.reviver);
    } else this.reset();
  }

  reset() {
    this.data = { creds: initAuthCreds(), keys: {}, events: [], seen: [], outgoing: [] };
    this.save();
  }

  save() {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data, BufferJSON.replacer)), cipher.final()]);
    writeFileSync(this.file + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  auth() {
    const snapshot = this.data;
    return {
      creds: snapshot.creds,
      keys: {
        get: async (type, ids) => Object.fromEntries(ids.map(id => {
          let value = snapshot.keys[type]?.[id];
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          return [id, value];
        })),
        set: async updates => {
          if (snapshot !== this.data) return;
          for (const [type, values] of Object.entries(updates)) {
            snapshot.keys[type] ||= {};
            for (const [id, value] of Object.entries(values)) {
              if (value == null) delete snapshot.keys[type][id];
              else snapshot.keys[type][id] = value;
            }
          }
          this.save();
        },
      },
    };
  }
}
