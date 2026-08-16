import { describe, expect, it } from "vitest";
import { parseCodexAuthStatus, codexAuthMetadata } from "../provider-auth/codex.js";
import { createDefaultProviderAuthMetadata, createDefaultCliAuthManager } from "../provider-auth/index.js";

describe("Codex auth metadata", () => {
  it("declares CLI-only auth (no API key) — honest, not stubbed", () => {
    expect(codexAuthMetadata.providerId).toBe("codex");
    expect(codexAuthMetadata.api.supported).toBe(false);
    const cli = codexAuthMetadata.cli;
    if (!cli.supported) throw new Error("expected codex CLI auth to be supported");
    expect(cli.executable).toBe("codex");
    expect(cli.statusArgs).toEqual(["login", "status"]);
    expect(cli.loginArgs).toEqual(["login"]);
    expect(cli.logoutArgs).toEqual(["logout"]);
  });

  it("is registered in the default metadata map and CLI auth manager", () => {
    const metadata = createDefaultProviderAuthMetadata();
    expect(metadata.get("codex")).toEqual(codexAuthMetadata);
    const manager = createDefaultCliAuthManager();
    expect(manager.has("codex")).toBe(true);
    expect(manager.has("deepseek")).toBe(false); // deepseek has no CLI auth
  });
});

describe("parseCodexAuthStatus", () => {
  it("maps the live 'Logged in using ChatGPT' output to authenticated", () => {
    expect(parseCodexAuthStatus("Logged in using ChatGPT")).toBe("authenticated");
  });

  it("maps 'Not logged in.' to not-authenticated (case-insensitive)", () => {
    expect(parseCodexAuthStatus("Not logged in.")).toBe("not-authenticated");
    expect(parseCodexAuthStatus("NOT LOGGED IN")).toBe("not-authenticated");
  });

  it("returns unknown for unparseable output — never guesses", () => {
    expect(parseCodexAuthStatus("")).toBe("unknown");
    expect(parseCodexAuthStatus("{ weird json }")).toBe("unknown");
  });
});
