/**
 * The provider-facing credential API. Builds/parses `credential://<provider>/<name>`
 * references (what CONTINUUM config stores — never a value) and delegates
 * actual storage to whichever `CredentialBackend` was selected.
 */

import { CredentialNotFoundError } from "./errors.js";
import type { CredentialBackend, CredentialBackendSecurityLevel } from "./types.js";

const KEY_PREFIX = "continuum:";

export function credentialKeyFor(providerId: string, name: string): string {
  return `${KEY_PREFIX}${providerId}:${name}`;
}

export function credentialUriFor(providerId: string, name: string): string {
  return `credential://${providerId}/${name}`;
}

export function parseCredentialUri(uri: string): { providerId: string; name: string } | undefined {
  const match = uri.match(/^credential:\/\/([^/]+)\/(.+)$/);
  if (!match) return undefined;
  return { providerId: match[1]!, name: match[2]! };
}

/**
 * Provider-id aliases for credential lookups. When a bundled provider is
 * renamed (ox-alpha → glm-5-2-free), a key stored under the old id must keep
 * resolving so existing auth is never lost: reads try the canonical id first,
 * then each legacy alias. Writes always use the canonical id, so the next
 * `continuum auth` migrates the key automatically; `deleteCredential` removes
 * the canonical and legacy keys together.
 */
export const DEFAULT_CREDENTIAL_ID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "glm-5-2-free": ["ox-alpha"],
};

export class CredentialManager {
  constructor(
    private readonly backend: CredentialBackend,
    private readonly idAliases: Readonly<Record<string, readonly string[]>> = DEFAULT_CREDENTIAL_ID_ALIASES,
  ) {}

  get backendId(): string {
    return this.backend.id;
  }

  get securityLevel(): CredentialBackendSecurityLevel {
    return this.backend.securityLevel;
  }

  get backendDescription(): string {
    return this.backend.description;
  }

  /** Stores a credential and returns its `credential://` reference — the only thing that should ever land in config. */
  async setCredential(providerId: string, name: string, value: string): Promise<string> {
    await this.backend.set(credentialKeyFor(providerId, name), value);
    return credentialUriFor(providerId, name);
  }

  private async backendGet(providerId: string, name: string): Promise<string | undefined> {
    for (const id of [providerId, ...(this.idAliases[providerId] ?? [])]) {
      const value = await this.backend.get(credentialKeyFor(id, name));
      if (value !== undefined) return value;
    }
    return undefined;
  }

  async getCredential(providerId: string, name: string): Promise<string> {
    const value = await this.backendGet(providerId, name);
    if (value === undefined) throw new CredentialNotFoundError(credentialUriFor(providerId, name));
    return value;
  }

  async hasCredential(providerId: string, name: string): Promise<boolean> {
    return (await this.backendGet(providerId, name)) !== undefined;
  }

  async deleteCredential(providerId: string, name: string): Promise<void> {
    for (const id of [providerId, ...(this.idAliases[providerId] ?? [])]) {
      await this.backend.delete(credentialKeyFor(id, name));
    }
  }

  /** Credential *names* for one provider — e.g. for `providers`/`doctor` listings. Never returns values. */
  async listProviderCredentialNames(providerId: string): Promise<readonly string[]> {
    const prefix = `${KEY_PREFIX}${providerId}:`;
    const allKeys = await this.backend.list();
    return allKeys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }
}
