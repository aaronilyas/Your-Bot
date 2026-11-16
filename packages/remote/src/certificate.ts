/**
 * Self-signed TLS identity for the remote host. Dependency-free: a minimal DER encoder over
 * node:crypto (ECDSA P-256 / SHA-256). Clients never validate a CA chain; they pin the
 * SHA-256 fingerprint of the certificate's DER bytes, which is distributed in the pairing code.
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const length = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);
const integer = (value: Buffer): Buffer => {
  let v = value;
  while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.subarray(1);
  return tlv(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const part of rest) {
    const chunk: number[] = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const time = (date: Date): Buffer => {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2))) : tlv(0x18, Buffer.from(iso));
};
const name = (commonName: string): Buffer => sequence(set(sequence(oid('2.5.4.3'), utf8(commonName))));

/** Builds a DER self-signed certificate for a P-256 key pair. */
export function createSelfSignedCertificate(commonName: string, now = new Date()): { keyPem: string; certPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const serial = randomBytes(16); serial[0]! &= 0x7f;
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const notAfter = new Date(now.getTime() + 10 * 365 * 24 * 3600_000);
  const basicConstraints = sequence(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence()));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), integer(serial), algorithm, name(commonName),
    sequence(time(notBefore), time(notAfter)), name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }), explicit(3, sequence(basicConstraints)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, certPem };
}

/** Lowercase hex SHA-256 of the certificate DER. */
export function certificateFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex');
}
/** Accepts `ab12…` or `AB:12:…`; returns lowercase hex or throws. */
export function normalizeFingerprint(value: string): string {
  const hex = value.replace(/:/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('Fingerprint must be a SHA-256 hex digest');
  return hex;
}

/** Owner-only directory (0700); refuses a symlinked directory. */
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${path} must be a real directory`);
  chmodSync(path, 0o700);
}
/** Atomically writes an owner-only (0600) file. */
export function writePrivateFile(path: string, content: string): void {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, content); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch { /* ignore */ } throw error; }
}
/** Reads a regular file without following a final symlink, tightening its mode to 0600. */
export function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} must be a regular file`);
    fchmodSync(fd, 0o600);
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

export interface TlsIdentity { key: string; cert: string; fingerprint: string; }
/** Loads `<dir>/key.pem` + `<dir>/cert.pem`, generating them once if absent. */
export function loadOrCreateTlsIdentity(directory: string, commonName: string): TlsIdentity {
  privateDirectory(directory);
  const keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  let key: string, cert: string;
  try { key = readPrivateFile(keyPath); cert = readPrivateFile(certPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    ({ keyPem: key, certPem: cert } = createSelfSignedCertificate(commonName));
    writePrivateFile(keyPath, key); writePrivateFile(certPath, cert);
  }
  const x509 = new X509Certificate(cert);
  if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error('TLS key does not match certificate');
  return { key, cert, fingerprint: certificateFingerprint(x509.raw) };
}
