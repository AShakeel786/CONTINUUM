import { describe, expect, it } from "vitest";
import { createScriptedPrompt } from "../prompt.js";

describe("createScriptedPrompt", () => {
  it("consumes answers/secrets/confirms in order and records asked secrets", async () => {
    const p = createScriptedPrompt({
      answers: ["hello"],
      secrets: ["sk-test-1", "sk-test-2"],
      confirms: [true, false],
    });
    expect(await p.ask("name?")).toBe("hello");
    expect(await p.askSecret("k1?")).toBe("sk-test-1");
    expect(await p.askSecret("k2?")).toBe("sk-test-2");
    expect(await p.confirm("a?", false)).toBe(true);
    expect(await p.confirm("b?", false)).toBe(false);
    expect(p.askedSecrets).toEqual(["sk-test-1", "sk-test-2"]);
  });

  it("falls back to defaults when the script is exhausted", async () => {
    const p = createScriptedPrompt({});
    expect(await p.ask("name?", "anon")).toBe("anon");
    expect(await p.askSecret("k?")).toBe("");
    expect(await p.confirm("a?", true)).toBe(true);
  });

  it("records the exact prompt text it was asked (for no-leak assertions)", async () => {
    const p = createScriptedPrompt({ secrets: ["sk-secret"] });
    await p.askSecret("Enter key");
    // The secret value must never appear in the logged prompt text.
    expect(p.log).toEqual(["Enter key"]);
    expect(p.log.join(" ")).not.toContain("sk-secret");
  });
});
