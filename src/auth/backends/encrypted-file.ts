/**
 * Fallback credential backend: a single AES-256-GCM-encrypted JSON file,
 * keyed by a user-supplied passphrase via `scrypt` (Node's built-in KDF —
 * no home-grown cryptography; both primitives are `node:crypto` standard
 * library constructions, not invented here).
 *
 * SECURITY PROPERTIES (stated plainly, per the brief's "clearly document
 * its security properties" — read this before choosing this backend):
 *
 * Protects against:
 *   - Accidental disclosure: the vault file is ciphertext. Committing it to
 *     git, `cat`-ing it, or a screen-share doesn't expose secret values.
 *   - A different OS user account reading the file directly (they still
 *     only get ciphertext) — though this is a weaker guarantee than OS-
 *     native storage, which additionally restricts *decryption* to the
 *     owning OS user/session, not just file-read access.
 *
 * Does NOT protect against:
 *   - Anyone who can run code as the same OS user AND obtain/guess the
 *     passphrase — there is no OS-level binding of the key to "this user's
 *     login session" the way Windows DPAPI or macOS Keychain provide.
 *   - A weak or reused passphrase — this backend does not enforce
 *     passphrase strength.
 *   - Memory inspection of a running CONTINUUM process (the derived key
 *     and any decrypted value necessarily exist in memory while in use,
 *     same as any credential backend).
 *
 * This is why every native OS backend (`windows-dpapi.ts`,
 * `macos-keychain.ts`, `linux-secret-service.ts`) is preferred and
 * auto-selected first (`detect.ts`) — this backend exists so a machine
 * with none of those available still gets *something* better than
 * plaintext, never a silent plaintext fallback.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { resolveVaultFilePath } from "../../config/paths.js";
import type { CredentialBackend } from "../types.js";

const KEY_LENGTH = 32; // AES-256
const SCRYPT_COST = 16384; // N parameter -- Node's documented default cost factor

interface VaultEntry {
  readonly iv: string; // hex
  readonly authTag: string; // hex
  readonly ciphertext: string; // hex
}

interface VaultFile {
  readonly schemaVersion: 1;
  readonly salt: string; // hex, scrypt salt -- not secret, but never reused across vaults
  readonly entries: Readonly<Record<string, VaultEntry>>;
}

export type PassphraseProvider = () => Promise<string>;

export class EncryptedFileCredentialBackend implements CredentialBackend {
  readonly id = "encrypted-file";
  readonly securityLevel = "encrypted-fallback" as const;
  readonly description =
    "AES-256-GCM encrypted local file, protected by a passphrase you supply. Weaker than OS-native " +
    "storage: protects against accidental disclosure, not against someone with your OS account and passphrase.";

  private readonly filePath: string;
  private cachedKey: Buffer | undefined;

  constructor(
    private readonly passphraseProvider: PassphraseProvider,
    dataDir?: string,
  ) {
    this.filePath = resolveVaultFilePath(dataDir);
  }

  async isAvailable(): Promise<boolean> {
    return true; // pure Node crypto + filesystem -- always available as the last resort
  }

  private async loadVault(): Promise<VaultFile> {
    try {
      const raw = await fsPromises.readFile(this.filePath, "utf8");
      return JSON.parse(raw) as VaultFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, salt: randomBytes(16).toString("hex"), entries: {} };
      }
      throw err;
    }
  }

  private async saveVault(vault: VaultFile): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsPromises.writeFile(this.filePath, JSON.stringify(vault, null, 2), "utf8");
    try {
      await fsPromises.chmod(this.filePath, 0o600);
    } catch {
      // chmod is a no-op/unsupported on some Windows filesystems -- the
      // encryption itself is still the real protection here, not the mode bit.
    }
  }

  private async deriveKey(salt: string): Promise<Buffer> {
    if (this.cachedKey) return this.cachedKey;
    const passphrase = await this.passphraseProvider();
    const key = scryptSync(passphrase, Buffer.from(salt, "hex"), KEY_LENGTH, { N: SCRYPT_COST });
    this.cachedKey = key;
    return key;
  }

  private encrypt(key: Buffer, plaintext: string): VaultEntry {
    const iv = randomBytes(12); // 96-bit nonce, the AES-GCM standard size
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex"), ciphertext: encrypted.toString("hex") };
  }

  private decrypt(key: Buffer, entry: VaultEntry): string {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.authTag, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "hex")), decipher.final()]);
    return decrypted.toString("utf8");
  }

  async set(key: string, value: string): Promise<void> {
    const vault = await this.loadVault();
    const cryptoKey = await this.deriveKey(vault.salt);
    const entry = this.encrypt(cryptoKey, value);
    await this.saveVault({ ...vault, entries: { ...vault.entries, [key]: entry } });
  }

  async get(key: string): Promise<string | undefined> {
    const vault = await this.loadVault();
    const entry = vault.entries[key];
    if (!entry) return undefined;
    const cryptoKey = await this.deriveKey(vault.salt);
    return this.decrypt(cryptoKey, entry);
  }

  async delete(key: string): Promise<void> {
    const vault = await this.loadVault();
    if (!(key in vault.entries)) return;
    const remaining = { ...vault.entries };
    delete remaining[key];
    await this.saveVault({ ...vault, entries: remaining });
  }

  async list(): Promise<readonly string[]> {
    const vault = await this.loadVault();
    return Object.keys(vault.entries);
  }
}
