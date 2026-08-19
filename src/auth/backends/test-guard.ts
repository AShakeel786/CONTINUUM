/**
 * Native credential backends (macOS Keychain, Windows DPAPI, Linux Secret
 * Service) write into REAL, machine-wide, OS-level credential storage,
 * scoped only by a fixed service name (e.g. `"continuum"`) — never by a
 * test's own temp directory. A test that constructs a `SetupWizard` (or
 * anything else that calls `selectCredentialBackend`) without injecting an
 * isolated fake backend will silently reach the SAME real storage a live
 * `continuum auth <provider>` run uses.
 *
 * Proven incident: `setup-wizard.test.ts`'s "interactive with confirms"
 * test never injected a fake backend, so every full test-suite run silently
 * overwrote the real macOS Keychain's `deepseek` API key with the test's
 * own scripted placeholder value (`sk-deepseek-1`).
 *
 * This guard closes that whole class of mistake at its root: any mutating
 * call (`set`/`delete`) reaching a native backend while running under
 * Vitest (which always sets `process.env.VITEST`, per Vitest's own
 * documented contract) throws immediately instead of touching real OS
 * credential storage — loud and immediate, not silent corruption days
 * later. Reads (`get`/`list`/`isAvailable`) are unaffected; the risk is
 * mutation, not observation.
 */
export class RealCredentialBackendWriteBlockedError extends Error {
  readonly backendId: string;
  readonly method: "set" | "delete";
  constructor(backendId: string, method: "set" | "delete") {
    super(
      `Refused a real ${method}() call on the "${backendId}" credential backend while running under the test ` +
        `runner (process.env.VITEST is set). A test is missing an injected fake/isolated CredentialBackend — ` +
        `a native backend must never be reachable from a test, since it writes real, machine-wide OS credential ` +
        `storage rather than anything test-isolated.`,
    );
    this.name = "RealCredentialBackendWriteBlockedError";
    this.backendId = backendId;
    this.method = method;
  }
}

/** Throws when a native backend's mutating method is reached while running under Vitest. No-op otherwise. */
export function assertNotUnderTest(backendId: string, method: "set" | "delete"): void {
  if (process.env.VITEST) {
    throw new RealCredentialBackendWriteBlockedError(backendId, method);
  }
}
