/**
 * Auth/credential architecture — see docs/PHASE_6_ONBOARDING_ARCHITECTURE.md
 * for the full design rationale. Summary of the split:
 *
 *   CredentialBackend  -- one storage mechanism (OS-native or fallback);
 *                          get/set/delete raw secret bytes by key. No
 *                          provider knowledge at all.
 *   CredentialManager  -- the provider-facing API; builds `credential://`
 *                          references, delegates to whichever backend was
 *                          selected.
 *   ProviderAuthMetadata -- PURE DATA (mirrors Phase 3's ProviderProfile):
 *                          which auth methods a provider supports, and the
 *                          static facts needed to drive them (env var name,
 *                          CLI executable, login/status args). No functions.
 *   CliAuthAdapter     -- the BEHAVIOR half for CLI auth (mirrors Phase 3's
 *                          ProviderAdapter holding a profile): generic
 *                          detect/status/login/logout, driven by the data
 *                          above, plus an optional provider-specific status
 *                          parser when exit-code-only isn't precise enough.
 *   CliAuthManager     -- registry + orchestration over CliAuthAdapters,
 *                          keyed by providerId, same shape as Phase 3's
 *                          ProviderRegistry.
 *   ProviderSetup      -- per-provider "let's get you authenticated" flow,
 *                          choosing between API/CLI and driving the pieces
 *                          above.
 *   AuthVerifier       -- post-setup validation, for both auth kinds.
 *   SetupWizard        -- top-level `continuum setup` orchestration across
 *                          every registered provider.
 */

export type CredentialBackendSecurityLevel = "os-native" | "encrypted-fallback";

/**
 * One storage mechanism. Implementations never know what a "provider" or
 * "API key" is — just opaque key/value pairs, where the key is always a
 * `CredentialManager`-constructed namespaced string
 * (`continuum:<providerId>:<name>`) and the value is the raw secret text.
 */
export interface CredentialBackend {
  readonly id: string;
  readonly securityLevel: CredentialBackendSecurityLevel;
  /** Human-readable description of what this backend actually protects against — surfaced by `doctor` and setup prompts, never hidden. */
  readonly description: string;
  isAvailable(): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
  /** Key names only (e.g. for `doctor`/`providers` listings) — implementations must never return values here. */
  list(): Promise<readonly string[]>;
}

// ── Provider auth metadata (data) ───────────────────────────────────────

export interface ApiAuthCapability {
  readonly supported: true;
  /** The exact env var name Phase 3's provider profile already expects (`profile.auth.secret.envVar`) — CredentialManager populates this var at activation time, it never invents a new naming scheme. */
  readonly envVar: string;
}
export interface ApiAuthUnsupported {
  readonly supported: false;
}
export type ApiAuthDescriptor = ApiAuthCapability | ApiAuthUnsupported;

export interface CliAuthCapability {
  readonly supported: true;
  readonly executable: string;
  readonly versionArgs: readonly string[];
  readonly statusArgs?: readonly string[];
  readonly loginArgs: readonly string[];
  readonly logoutArgs?: readonly string[];
}
export interface CliAuthUnsupported {
  readonly supported: false;
}
export type CliAuthDescriptor = CliAuthCapability | CliAuthUnsupported;

export interface ProviderAuthMetadata {
  readonly providerId: string;
  readonly api: ApiAuthDescriptor;
  readonly cli: CliAuthDescriptor;
}

// ── CLI auth behavior ────────────────────────────────────────────────────

export type CliInstalledStatus = "installed" | "not-installed";
export type CliAuthStatus = "authenticated" | "not-authenticated" | "unknown";

export interface CliLoginResult {
  readonly completed: boolean;
  readonly exitCode: number | null;
}

/**
 * The behavior half of CLI auth for one provider — generic
 * detect/login/logout mechanics driven by `CliAuthCapability` data, plus an
 * optional provider-specific `parseStatus` for when exit-code-only
 * detection isn't precise (e.g. a tool that always exits 0 and encodes
 * status in its JSON output instead).
 */
export interface CliAuthAdapter {
  readonly providerId: string;
  readonly capability: CliAuthCapability;
  detectInstalled(): Promise<CliInstalledStatus>;
  detectAuthenticated(): Promise<CliAuthStatus>;
  /** Spawns the official interactive login flow, inheriting stdio so the real OAuth/browser flow runs untouched. CONTINUUM never sees or stores the resulting token. */
  login(): Promise<CliLoginResult>;
  logout(): Promise<CliLoginResult | undefined>;
}
