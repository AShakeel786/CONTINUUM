import { describe, expect, it } from "vitest";
import { findRecentNativeSessionId, findRecentSqliteConversationId } from "../native-session.js";
import type { NativeSqliteSessionStore } from "../../providers/types.js";
import { createProviderAdapter } from "../../providers/adapter.js";
import { antigravityProfile } from "../../providers/profiles/antigravity.js";

const sqliteStore: NativeSqliteSessionStore = {
  kind: "sqlite",
  dbPath: "~/.gemini/antigravity-cli/conversation_summaries.db",
  table: "conversation_summaries",
  idColumn: "conversation_id",
  mtimeColumn: "last_modified_time",
};

describe("antigravity sqlite session discovery", () => {
  it("returns the most-recent conversation id from the provider's SQLite index", async () => {
    // The injected query stands in for `SELECT id ... ORDER BY mtime DESC LIMIT 1`,
    // so the first row is already the most-recent.
    const rows = [{ id: "newest-conversation" }, { id: "older-conversation" }];
    const id = await findRecentSqliteConversationId(sqliteStore, async () => rows);
    expect(id).toBe("newest-conversation");
  });

  it("returns undefined when the index has no rows", async () => {
    const id = await findRecentSqliteConversationId(sqliteStore, async () => []);
    expect(id).toBeUndefined();
  });

  it("returns undefined (never throws) when the query fails", async () => {
    const id = await findRecentSqliteConversationId(sqliteStore, async () => {
      throw new Error("no such table / db locked");
    });
    expect(id).toBeUndefined();
  });

  it("findRecentNativeSessionId dispatches sqlite stores to the sqlite path", async () => {
    const id = await findRecentNativeSessionId(sqliteStore);
    // Real reader would hit the user's own DB; here we only assert it resolves
    // to a string or undefined without throwing (no sqlite file guaranteed).
    expect(id === undefined || typeof id === "string").toBe(true);
  });
});

describe("antigravity native launch plan", () => {
  // agy rejects positional prompts (`unexpected argument`) — the prompt must
  // arrive as a `--prompt-interactive` flag VALUE, never as a bare arg.
  const promptFlag = "--prompt-interactive";

  it("fresh launch = default `--model` + the prompt as a --prompt-interactive value (never positional)", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      taskPrompt: "ship it",
      contextSystem: "compact context",
    });
    expect(plan.executable).toBe("agy");
    expect(plan.args).toEqual(["--model", "gemini-3.7-flash-high", promptFlag, "compact context\n\nship it"]);
    expect(plan.env).toEqual({});
    // The prompt value is a flag VALUE: it is immediately preceded by the flag
    // and nothing follows it — exactly what a positional arg could not be.
    expect(plan.args[plan.args.length - 2]).toBe(promptFlag);
  });

  it("multiline handoff prompt is delivered intact as the flag value", () => {
    const handoff = [
      "<handoff-resume>",
      "This is an EXISTING task, already in progress.",
      "* Do not re-audit the project from scratch.",
      "## Remaining",
      "line one\nline two\nline three",
      "</handoff-resume>",
    ].join("\n");
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      taskPrompt: "continue the work",
      contextSystem: handoff,
    });
    const flagIdx = plan.args.indexOf(promptFlag);
    expect(flagIdx).toBeGreaterThan(0);
    const value = plan.args[flagIdx + 1]!;
    expect(value).toContain("<handoff-resume>");
    expect(value).toContain("Do not re-audit");
    expect(value).toContain("line one\nline two\nline three");
    expect(value).toContain("continue the work");
    expect(value).toMatch(/\n\ncontinue the work$/);
  });

  it("resume launch = `--model` then `--conversation <id>` then the prompt via --prompt-interactive", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      resumeNativeSessionId: "conv-123",
      taskPrompt: "continue",
    });
    expect(plan.args.slice(0, 4)).toEqual(["--model", "gemini-3.7-flash-high", "--conversation", "conv-123"]);
    expect(plan.args.slice(4)).toEqual([promptFlag, "continue"]);
  });

  it("blank optional task goal → no prompt flag at all, bare interactive launch", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      taskPrompt: "",
      contextSystem: "ignored when there is no task goal",
    });
    expect(plan.args).toEqual(["--model", "gemini-3.7-flash-high"]);
    expect(plan.args).not.toContain(promptFlag);
  });

  it("explicit model + bypass are preserved ahead of the prompt flag", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      taskPrompt: "ship it",
      modelAlias: "pro",
      permissionMode: "bypass",
    });
    expect(plan.args).toEqual([
      "--model",
      "gemini-3.1-pro-high",
      "--dangerously-skip-permissions",
      promptFlag,
      "ship it",
    ]);
  });
});
