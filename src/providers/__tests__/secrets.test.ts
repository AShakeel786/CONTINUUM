import { describe, expect, it } from "vitest";
import { isSecretResolvable, resolveSecret, secretRef } from "../secrets.js";
import { MissingSecretError } from "../errors.js";

describe("secrets — resolution and isolation", () => {
  it("resolves a secret from an injected env map, never touching real process.env", () => {
    const fakeEnv = { MY_TEST_KEY: "sk-injected-value-not-real" };
    const value = resolveSecret("test-provider", secretRef("MY_TEST_KEY"), fakeEnv);
    expect(value).toBe("sk-injected-value-not-real");
    expect(process.env.MY_TEST_KEY).toBeUndefined();
  });

  it("throws MissingSecretError (safe to log — no value) when the var is absent", () => {
    const fakeEnv = {};
    expect(() => resolveSecret("test-provider", secretRef("ABSENT_KEY"), fakeEnv)).toThrowError(
      MissingSecretError,
    );
    try {
      resolveSecret("test-provider", secretRef("ABSENT_KEY"), fakeEnv);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSecretError);
      const e = err as MissingSecretError;
      expect(e.envVar).toBe("ABSENT_KEY");
      expect(e.providerId).toBe("test-provider");
      // The error message must never contain a resolved value — there is none to leak here,
      // and this asserts the message only ever names the var, not a value.
      expect(e.message).toContain("ABSENT_KEY");
      expect(e.message).not.toMatch(/sk-[a-zA-Z0-9]/);
    }
  });

  it("throws MissingSecretError when the var is present but empty/whitespace", () => {
    const fakeEnv = { BLANK_KEY: "   " };
    expect(() => resolveSecret("test-provider", secretRef("BLANK_KEY"), fakeEnv)).toThrowError(
      MissingSecretError,
    );
  });

  it("isSecretResolvable reports resolvability without ever returning the value", () => {
    expect(isSecretResolvable(secretRef("PRESENT"), { PRESENT: "x" })).toBe(true);
    expect(isSecretResolvable(secretRef("ABSENT"), {})).toBe(false);
  });

  it("two SecretRefs to different env vars are fully isolated from each other", () => {
    const env = { KEY_A: "value-a", KEY_B: "value-b" };
    expect(resolveSecret("p", secretRef("KEY_A"), env)).toBe("value-a");
    expect(resolveSecret("p", secretRef("KEY_B"), env)).toBe("value-b");
    // Resolving KEY_A never accidentally picks up KEY_B's value or vice versa.
    expect(resolveSecret("p", secretRef("KEY_A"), env)).not.toBe("value-b");
  });
});
