import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupWizard } from "../setup-wizard.js";
import { ConfigStore } from "../../config/store.js";
import { CliAuthManager } from "../cli-auth-manager.js";
import { createCliAuthAdapter } from "../cli-auth-adapter.js";
import { createScriptedPrompt } from "../prompt.js";
import { createDefaultProviderAuthMetadata } from "../provider-auth/index.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "continuum-wizard-"));
}

describe("SetupWizard.initialize", () => {
  it("creates the data dir, selects a backend, records its id, and is idempotent", async () => {
    const dir = tmpDataDir();
    const wizard = new SetupWizard({
      prompt: createScriptedPrompt({}),
      cliAuthManager: new CliAuthManager(),
      providerMetadata: new Map(),
      dataDir: dir,
      passphraseProvider: async () => "test-passphrase",
    });
    const store = new ConfigStore(dir);
    const s1 = await wizard.initialize(store, dir);
    // A backend was selected (native or fallback — platform-dependent) and
    // its id recorded in config.
    const persisted = await store.load();
    expect(persisted.credentialBackendId).toBe(s1.backend.id);

    // Idempotent: a second initialize honors the recorded backend.
    const s2 = await wizard.initialize(new ConfigStore(dir), dir);
    expect(s2.backend.id).toBe(s1.backend.id);
  });
});

describe("SetupWizard.run (non-interactive)", () => {
  it("skips all providers when non-interactive and persists empty config", async () => {
    const dir = tmpDataDir();
    const wizard = new SetupWizard({
      prompt: createScriptedPrompt({}),
      cliAuthManager: new CliAuthManager(),
      providerMetadata: createDefaultProviderAuthMetadata(),
      dataDir: dir,
      passphraseProvider: async () => "test-passphrase",
      nonInteractive: true,
    });
    const store = new ConfigStore(dir);
    const state = await wizard.initialize(store, dir);
    const config = await wizard.run(store, state);
    expect(config.providers).toEqual([]);
  });
});

describe("SetupWizard.run (interactive with confirms)", () => {
  it("sets up a declined-then-accepted sequence, storing only references", async () => {
    const dir = tmpDataDir();
    const cli = new CliAuthManager();
    cli.register(createCliAuthAdapter("claude", {
      supported: true,
      executable: "claude",
      versionArgs: ["--version"],
      loginArgs: ["auth", "login"],
      statusArgs: ["auth", "status"],
      logoutArgs: ["auth", "logout"],
    } as never));

    // deepseek -> confirm(true), enter key; claude -> confirm(false), skip.
    // Provider iteration order is claude then deepseek (registration order).
    const wizard = new SetupWizard({
      prompt: createScriptedPrompt({ confirms: [false, true], secrets: ["sk-deepseek-1"] }),
      cliAuthManager: cli,
      providerMetadata: createDefaultProviderAuthMetadata(),
      dataDir: dir,
      output: () => {},
    });
    const store = new ConfigStore(dir);
    const state = await wizard.initialize(store, dir);
    const config = await wizard.run(store, state);

    const deepseek = config.providers.find((p) => p.providerId === "deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek!.method).toBe("api");
    expect(deepseek!.credentialKey).toBe("credential://deepseek/api-key");
    // The secret value must not land in config.
    expect(JSON.stringify(config)).not.toContain("sk-deepseek-1");
  });
});
