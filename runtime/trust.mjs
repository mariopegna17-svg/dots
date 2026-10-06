// Chromium on Linux uses NSS for locally trusted certificate authorities.
// Import the environment's verified CA bundle; never bypass certificate checks.
import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
export async function configureBrowserTrust() {
  const bundle = new URL('./environment-ca-bundle.pem', import.meta.url);
  let contents;
  try { contents = await readFile(bundle, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const directory = path.join(process.env.HOME || '/home/pwuser', '.pki', 'nssdb');
  await mkdir(directory, { recursive: true });
  const db = `sql:${directory}`;
  try { await readFile(path.join(directory, 'cert9.db')); }
  catch { await exec('certutil', ['-N', '-d', db, '--empty-password']); }
  for (const pem of contents.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []) {
    const certificate = new X509Certificate(pem);
    if (!certificate.ca) continue;
    const fingerprint = certificate.fingerprint256.replaceAll(':', '');
    const temporary = path.join(directory, `${fingerprint}.pem`);
    await writeFile(temporary, pem, { mode: 0o600 });
    try { await exec('certutil', ['-A', '-d', db, '-n', `environment-${fingerprint}`, '-t', 'C,,', '-i', temporary]); }
    finally { await unlink(temporary); }
  }
}
