/**
 * Saved hosts for a remote client: `<dir>/hosts.json` (0600, dir 0700).
 * Device private keys are encrypted with an injected SecretCipher when one is provided;
 * otherwise they are stored in plaintext, protected only by file permissions.
 */
import { join } from 'node:path';
import type { CapabilityV2, SecretCipher } from '@your-bot/contracts';
import { normalizeFingerprint, privateDirectory, readPrivateFile, writePrivateFile } from './certificate.js';
import { credentialsFrom, type DeviceCredentials, type PairedHost } from './client.js';

export type StoredKey = { kind: 'plain'; pkcs8: string } | { kind: 'encrypted'; cipher: string; ciphertext: string };
export interface SavedHost {
  hostId: string; hostName: string; deviceId: string; deviceName: string; urls: string[]; fingerprint: string;
  capabilities: CapabilityV2[]; pairedAt: string;
  /** Last fully observed event sequence, for resuming. */
  lastSequence?: number;
}
interface StoredHost extends SavedHost { key: StoredKey; }
interface DirectoryFile { version: 1; hosts: StoredHost[]; }

export class HostDirectory {
  readonly file: string;
  constructor(readonly directory: string, private readonly options: { cipher?: SecretCipher } = {}) {
    this.file = join(directory, 'hosts.json');
  }
  private read(): DirectoryFile {
    privateDirectory(this.directory);
    let text: string;
    try { text = readPrivateFile(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: [] }; throw error; }
    const parsed = JSON.parse(text) as DirectoryFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.hosts)) throw new Error(`Unsupported host directory format in ${this.file}`);
    return parsed;
  }
  private write(file: DirectoryFile): void {
    privateDirectory(this.directory);
    writePrivateFile(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }
  /** Saved hosts without key material. */
  list(): SavedHost[] { return this.read().hosts.map(({ key: _key, ...host }) => host); }
  get(hostId: string): SavedHost | undefined { return this.list().find(h => h.hostId === hostId); }
  /** Adds or replaces (same hostId) a paired host. */
  add(paired: PairedHost): SavedHost {
    const cipher = this.options.cipher;
    const key: StoredKey = cipher ? { kind: 'encrypted', cipher: cipher.id, ciphertext: cipher.encrypt(paired.privateKeyPem) } : { kind: 'plain', pkcs8: paired.privateKeyPem };
    const host: StoredHost = {
      hostId: paired.hostId, hostName: paired.hostName, deviceId: paired.deviceId, deviceName: paired.deviceName, urls: [...paired.urls],
      fingerprint: normalizeFingerprint(paired.fingerprint), capabilities: [...paired.capabilities], pairedAt: paired.pairedAt, key,
    };
    const file = this.read();
    file.hosts = [...file.hosts.filter(h => h.hostId !== host.hostId), host];
    this.write(file);
    const { key: _key, ...saved } = host;
    return saved;
  }
  remove(hostId: string): boolean {
    const file = this.read();
    const before = file.hosts.length;
    file.hosts = file.hosts.filter(h => h.hostId !== hostId);
    if (file.hosts.length !== before) this.write(file);
    return file.hosts.length !== before;
  }
  setLastSequence(hostId: string, sequence: number): void {
    const file = this.read();
    const host = file.hosts.find(h => h.hostId === hostId);
    if (host && host.lastSequence !== sequence) { host.lastSequence = sequence; this.write(file); }
  }
  credentials(hostId: string): DeviceCredentials {
    const host = this.read().hosts.find(h => h.hostId === hostId);
    if (!host) throw new Error(`Unknown host ${hostId}`);
    let pem: string;
    if (host.key.kind === 'plain') pem = host.key.pkcs8;
    else {
      const cipher = this.options.cipher;
      if (!cipher || cipher.id !== host.key.cipher) throw new Error(`Device key for ${hostId} is encrypted with cipher "${host.key.cipher}", which is not available`);
      pem = cipher.decrypt(host.key.ciphertext);
    }
    return credentialsFrom(host, pem);
  }
}
