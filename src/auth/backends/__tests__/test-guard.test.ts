/**
 * Credential-backend boundary regression: proves a native OS credential
 * backend can NEVER be mutated (`set`/`delete`) from a test process — the
 * exact mechanism behind a real incident where `setup-wizard.test.ts`
 * silently overwrote a real macOS Keychain DeepSeek API key with a test's
 * own scripted placeholder value, because `SetupWizard` self-selected the
 * real native backend and the test never injected an isolated fake one.
 *
 * These tests run for real against the actual backend classes — no
 * mocking of `process.env.VITEST` (Vitest sets it for every test process,
 * per Vitest's own documented contract), so a passing suite here is proof
 * the guard is live, not simulated.
 */
import { describe, expect, it } from "vitest";
import { MacosKeychainCredentialBackend } from "../macos-keychain.js";
import { WindowsDpapiCredentialBackend } from "../windows-dpapi.js";
import { LinuxSecretServiceCredentialBackend } from "../linux-secret-service.js";
import { RealCredentialBackendWriteBlockedError, assertNotUnderTest } from "../test-guard.js";

describe("native credential backends — test-guard boundary", () => {
  it("process.env.VITEST is set (sanity check the guard's own precondition)", () => {
    expect(process.env.VITEST).toBeTruthy();
  });

  it("assertNotUnderTest throws under the test runner", () => {
    expect(() => assertNotUnderTest("some-backend", "set")).toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("MacosKeychainCredentialBackend.set() refuses to run under the test runner — never touches the real macOS Keychain", async () => {
    const backend = new MacosKeychainCredentialBackend();
    await expect(backend.set("continuum:test-guard-canary", "value")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("MacosKeychainCredentialBackend.delete() refuses to run under the test runner", async () => {
    const backend = new MacosKeychainCredentialBackend();
    await expect(backend.delete("continuum:test-guard-canary")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("WindowsDpapiCredentialBackend.set() refuses to run under the test runner", async () => {
    const backend = new WindowsDpapiCredentialBackend("/tmp/continuum-test-guard-scratch");
    await expect(backend.set("continuum:test-guard-canary", "value")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("WindowsDpapiCredentialBackend.delete() refuses to run under the test runner", async () => {
    const backend = new WindowsDpapiCredentialBackend("/tmp/continuum-test-guard-scratch");
    await expect(backend.delete("continuum:test-guard-canary")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("LinuxSecretServiceCredentialBackend.set() refuses to run under the test runner", async () => {
    const backend = new LinuxSecretServiceCredentialBackend();
    await expect(backend.set("continuum:test-guard-canary", "value")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("LinuxSecretServiceCredentialBackend.delete() refuses to run under the test runner", async () => {
    const backend = new LinuxSecretServiceCredentialBackend();
    await expect(backend.delete("continuum:test-guard-canary")).rejects.toThrowError(RealCredentialBackendWriteBlockedError);
  });

  it("reads are unaffected — the guard blocks mutation only, never observation", async () => {
    const backend = new MacosKeychainCredentialBackend();
    await expect(backend.get("continuum:test-guard-canary-does-not-exist")).resolves.toBeUndefined();
    await expect(backend.list()).resolves.toEqual([]);
  });
});
