import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliModelsOutput, parseCodexModelsCache, discoverModelsFor } from "../model-discovery.js";
import { codexProfile } from "../profiles/codex.js";
import { antigravityProfile } from "../profiles/antigravity.js";
import { claudeProfile } from "../profiles/claude.js";

describe("parseCliModelsOutput (agy `models`: <id>\t<label>)", () => {
  it("parses tab-separated id/label lines", () => {
    const models = parseCliModelsOutput("gemini-3.7-flash-high\tGemini 3.7 Flash High\ngemini-3.1-pro-high\tGemini 3.1 Pro High\n");
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro High" },
    ]);
  });

  it("drops blank/progress/noise lines that lack a tab (e.g. agy's real `Fetching available models...`) — never mis-parses them as a model id", () => {
    const models = parseCliModelsOutput("Fetching available models...\n\njust-noise-without-tab\ngemini-3.7-flash-low\tGemini 3.7 Flash Low\n");
    expect(models).toEqual([{ id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash Low" }]);
  });

  it("tolerates extra tabs in the label (kept in the label)", () => {
    const models = parseCliModelsOutput("gemini-3.1-pro-high\tGemini 3.1\tPro\tHigh\n");
    expect(models).toEqual([{ id: "gemini-3.1-pro-high", label: "Gemini 3.1\tPro\tHigh" }]);
  });

  it("returns [] for empty output", () => {
    expect(parseCliModelsOutput("")).toEqual([]);
  });
});

describe("parseCodexModelsCache (~/.codex/models_cache.json)", () => {
  it("parses visible models and filters `visibility: hide` (auto-review etc.)", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Solution" },
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6 Terra" },
        { slug: "gpt-5.4-mini", visibility: "hide" },
        { slug: "gpt-5.4-mini-auto-review", visibility: "hide" },
      ],
    });
    expect(parseCodexModelsCache(raw)).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6 Solution" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ]);
  });

  it("falls back the label to the slug when display_name is absent", () => {
    const raw = JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] });
    expect(parseCodexModelsCache(raw)).toEqual([{ id: "gpt-5.6-sol", label: "gpt-5.6-sol" }]);
  });

  it("returns [] when the cache has no models array", () => {
    expect(parseCodexModelsCache(JSON.stringify({ version: 1 }))).toEqual([]);
  });
});

describe("discoverModelsFor dispatch", () => {
  it("cli-command runs the profile's declared executable+subcommand and parses tab output", async () => {
    const run = async (cmd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      expect(cmd).toBe("agy");
      expect(args).toEqual(["models"]);
      return { stdout: "gemini-3.7-flash-high\tGemini 3.7 Flash High\n", stderr: "" };
    };
    const models = await discoverModelsFor(antigravityProfile, { execFile: run });
    expect(models).toEqual([{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High" }]);
  });

  it("json-cache reads the declared cache file and parses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-cache-"));
    const cachePath = join(dir, "models_cache.json");
    writeFileSync(cachePath, JSON.stringify({ models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6 Solution" }] }));
    const profile = { ...codexProfile, modelDiscovery: { kind: "json-cache", path: cachePath } as const };
    const models = await discoverModelsFor(profile);
    expect(models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6 Solution" }]);
  });

  it("returns [] when the profile declares no discovery", async () => {
    expect(await discoverModelsFor(claudeProfile)).toEqual([]);
  });
});
