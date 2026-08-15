/**
 * Passphrase provider for the encrypted-file fallback backend.
 *
 * Only consulted when no native OS credential backend is available. Prompts
 * (masked) for a vault passphrase once, and — for first-run — asks for it
 * twice to confirm. The resulting passphrase is used only inside
 * `EncryptedFileCredentialBackend`'s scrypt KDF and is never stored,
 * logged, or returned to any caller.
 */

import type { Prompt } from "../../auth/prompt.js";

export function setupPassphraseProvider(prompt: Prompt): () => Promise<string> {
  return async () => {
    const first = await prompt.askSecret("Vault passphrase");
    const second = await prompt.askSecret("Confirm vault passphrase");
    if (first !== second) {
      throw new Error("Passphrases did not match — credential setup aborted.");
    }
    return first;
  };
}
