import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectAntigravityAuthenticated,
  readActiveAccount,
  antigravityAuthMetadata,
} from "../provider-auth/antigravity.js";

function fakeGeminiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cont-agy-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("antigravity auth detection (local, non-secret, account-only)", () => {
  it("reports authenticated when an active account is recorded", async () => {
    const dir = fakeGeminiDir();
    writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "user@example.com", old: [] }));
    expect(await detectAntigravityAuthenticated({ geminiDir: dir })).toBe("authenticated");
  });

  it("reports authenticated on account presence alone — token expiry is a runtime concern (keyring-authoritative, never read)", async () => {
    const dir = fakeGeminiDir();
    // Even with no oauth_creds.json present, an active account means a session
    // was recorded; agy refreshes its own keyring token. No credential file is
    // opened by the detector.
    writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "user@example.com" }));
    expect(await detectAntigravityAuthenticated({ geminiDir: dir })).toBe("authenticated");
  });

  it("reports not-authenticated when no active account is recorded", async () => {
    const dir = fakeGeminiDir();
    writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "", old: [] }));
    expect(await detectAntigravityAuthenticated({ geminiDir: dir })).toBe("not-authenticated");
  });

  it("readActiveAccount returns only the account identifier, never a token value", async () => {
    const dir = fakeGeminiDir();
    writeFileSync(join(dir, "google_accounts.json"), JSON.stringify({ active: "user@example.com", old: ["old@example.com"] }));
    expect(await readActiveAccount(dir)).toBe("user@example.com");
  });

  it("is resilient to missing/unparseable files", async () => {
    const dir = fakeGeminiDir();
    expect(await detectAntigravityAuthenticated({ geminiDir: dir })).toBe("not-authenticated");
    writeFileSync(join(dir, "google_accounts.json"), "not-json");
    expect(await detectAntigravityAuthenticated({ geminiDir: dir })).toBe("not-authenticated");
  });

  it("auth metadata declares a cli-session auth with no api secret", () => {
    expect(antigravityAuthMetadata.cli.supported).toBe(true);
    if (antigravityAuthMetadata.cli.supported) {
      expect(antigravityAuthMetadata.cli.executable).toBe("agy");
    }
    expect(antigravityAuthMetadata.api.supported).toBe(false);
  });
});
