import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileCredentialBackend } from "../backends/encrypted-file.js";

describe("EncryptedFileCredentialBackend", () => {
  it("round-trips set/get/delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-vault-"));
    const backend = new EncryptedFileCredentialBackend(async () => "test-passphrase", dir);
    await backend.set("continuum:deepseek:api-key", "sk-secret-1");
    expect(await backend.get("continuum:deepseek:api-key")).toBe("sk-secret-1");
    await backend.delete("continuum:deepseek:api-key");
    expect(await backend.get("continuum:deepseek:api-key")).toBeUndefined();
  });

  it("never writes the plaintext secret to the vault file (ciphertext only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-vault-"));
    const backend = new EncryptedFileCredentialBackend(async () => "test-passphrase", dir);
    await backend.set("continuum:deepseek:api-key", "sk-super-secret-value");
    const raw = readFileSync(join(dir, "vault.enc.json"), "utf8");
    expect(raw).not.toContain("sk-super-secret-value");
  });

  it("a wrong passphrase cannot decrypt (GCM auth failure surfaces, value is never revealed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "continuum-vault-"));
    const write = new EncryptedFileCredentialBackend(async () => "passphrase-A", dir);
    await write.set("continuum:claude:api-key", "sk-value");
    // Fresh instance with a different passphrase over the same file.
    const read = new EncryptedFileCredentialBackend(async () => "passphrase-B", dir);
    await expect(read.get("continuum:claude:api-key")).rejects.toThrow();
  });
});
