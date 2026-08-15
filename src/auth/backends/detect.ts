/**
 * Backend auto-selection: try the platform's native backend first, and
 * only fall back to the encrypted-file backend when no native option is
 * actually available — never a silent, unannounced fallback (callers see
 * exactly which backend was picked and why via the returned `reason`).
 */

import { WindowsDpapiCredentialBackend } from "./windows-dpapi.js";
import { MacosKeychainCredentialBackend } from "./macos-keychain.js";
import { LinuxSecretServiceCredentialBackend } from "./linux-secret-service.js";
import { EncryptedFileCredentialBackend, type PassphraseProvider } from "./encrypted-file.js";
import type { CredentialBackend } from "../types.js";

export function nativeBackendForPlatform(dataDir?: string): CredentialBackend | undefined {
  switch (process.platform) {
    case "win32":
      return new WindowsDpapiCredentialBackend(dataDir);
    case "darwin":
      return new MacosKeychainCredentialBackend();
    case "linux":
      return new LinuxSecretServiceCredentialBackend();
    default:
      return undefined;
  }
}

export interface BackendSelection {
  readonly backend: CredentialBackend;
  readonly reason: string;
}

/**
 * Tries the platform-native backend; if it's unavailable (not installed,
 * not running, or simply not this platform), falls back to the encrypted
 * file backend — which requires a passphrase provider since it has no OS
 * keychain to lean on.
 */
export async function selectCredentialBackend(
  passphraseProvider: PassphraseProvider,
  dataDir?: string,
): Promise<BackendSelection> {
  const native = nativeBackendForPlatform(dataDir);
  if (native && (await native.isAvailable())) {
    return { backend: native, reason: `native ${process.platform} backend detected and working` };
  }
  const fallback = new EncryptedFileCredentialBackend(passphraseProvider, dataDir);
  const nativeNote = native ? `"${native.id}" was not available on this machine` : `no native backend exists for platform "${process.platform}"`;
  return { backend: fallback, reason: `${nativeNote}; using the encrypted-file fallback` };
}
