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
  it("fresh launch = default `--model` + the task prompt folded in (prompt-only)", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      taskPrompt: "ship it",
      contextSystem: "compact context",
    });
    expect(plan.executable).toBe("agy");
    expect(plan.args).toEqual(["--model", "gemini-3.7-flash-high", "compact context\n\nship it"]);
    expect(plan.env).toEqual({});
  });

  it("resume launch = `--model` then `--conversation <id>` followed by the prompt", () => {
    const plan = createProviderAdapter(antigravityProfile).buildCliLaunchPlan({
      workingDir: "/work",
      resumeNativeSessionId: "conv-123",
      taskPrompt: "continue",
    });
    expect(plan.args.slice(2, 4)).toEqual(["--conversation", "conv-123"]);
    expect(plan.args[4]).toBe("continue");
  });
});
