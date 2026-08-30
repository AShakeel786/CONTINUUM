import { describe, expect, it } from "vitest";
import { claudeProfile } from "../profiles/claude.js";
import { deepseekProfile } from "../profiles/deepseek.js";
import { codexProfile } from "../profiles/codex.js";
import { glm52FreeProfile } from "../profiles/glm-5-2-free.js";
import { createDefaultProviderRegistry } from "../index.js";

/**
 * Requirement 6 / test bullet "no secrets in logs/config/diffs": provider
 * profiles must be safe to serialize, log, or diff as-is — every auth field
 * must be a SecretRef ({ envVar: string }) and never a literal credential.
 */

const SECRET_SHAPED = /sk-[a-zA-Z0-9_-]{8,}|AKID[a-zA-Z0-9]{8,}|-----BEGIN/;

function assertNoLiteralSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    expect(value, `possible literal secret at ${path}: ${JSON.stringify(value)}`).not.toMatch(SECRET_SHAPED);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoLiteralSecrets(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      assertNoLiteralSecrets(v, `${path}.${k}`);
    }
  }
}

describe("no secrets in provider profiles", () => {
  it("Claude profile is fully JSON-serializable and secret-free", () => {
    const json = JSON.stringify(claudeProfile);
    expect(json).toBeTruthy();
    assertNoLiteralSecrets(claudeProfile);
  });

  it("DeepSeek profile is fully JSON-serializable and secret-free", () => {
    const json = JSON.stringify(deepseekProfile);
    expect(json).toBeTruthy();
    assertNoLiteralSecrets(deepseekProfile);
  });

  it("Codex profile is fully JSON-serializable and secret-free", () => {
    const json = JSON.stringify(codexProfile);
    expect(json).toBeTruthy();
    assertNoLiteralSecrets(codexProfile);
  });

  it("GLM 5.2 Free profile is fully JSON-serializable and secret-free", () => {
    const json = JSON.stringify(glm52FreeProfile);
    expect(json).toBeTruthy();
    assertNoLiteralSecrets(glm52FreeProfile);
  });

  it("every auth strategy that carries a secret uses a SecretRef (envVar name only), not a literal", () => {
    for (const profile of [claudeProfile, deepseekProfile, glm52FreeProfile]) {
      const auth = profile.auth;
      if ("secret" in auth) {
        expect(Object.keys(auth.secret)).toEqual(["envVar"]);
        expect(typeof auth.secret.envVar).toBe("string");
      }
    }
  });

  it("redirected/proxy cliLaunch descriptors reference a SecretRef, never an inline key", () => {
    const launch = deepseekProfile.cliLaunch;
    expect(launch.kind).toBe("redirected");
    if (launch.kind === "redirected") {
      expect(Object.keys(launch.authTokenSecret)).toEqual(["envVar"]);
    }
    // The optional proxy route also references a SecretRef, never an inline key.
    const proxy = deepseekProfile.proxyCliLaunch;
    expect(proxy).toBeDefined();
    if (proxy) {
      expect(Object.keys(proxy.proxyUserKeySecret)).toEqual(["envVar"]);
    }
  });

  it("listProfiles() on the default registry never exposes a resolved secret", () => {
    const registry = createDefaultProviderRegistry();
    const json = JSON.stringify(registry.listProfiles());
    expect(json).not.toMatch(SECRET_SHAPED);
  });
});
