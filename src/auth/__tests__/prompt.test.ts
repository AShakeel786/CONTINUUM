import { PassThrough } from "node:stream";
import readline from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrompt, createScriptedPrompt } from "../prompt.js";

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
    p.close();
  });
});

describe("createPrompt — shared readline lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A fake terminal. `input` is a stream we feed lines into; `output` is a
   * string sink. Every helper types its line AFTER the prompt is posed — the
   * live-read path (a human reading the prompt, then typing) that regressed.
   */
  function fakeTerminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const tick = () => new Promise((r) => setImmediate(r));
    /** Pose `run()` (an ask/confirm/askSecret call), then type `line` at it. */
    async function answer<T>(run: () => Promise<T>, line: string): Promise<T> {
      const pending = run();
      await tick();
      input.write(`${line}\n`);
      return pending;
    }
    return { input, output, tick, answer };
  }

  it("reuses ONE readline interface across many prompts (no per-question create/close churn)", async () => {
    const { input, output, answer } = fakeTerminal();
    const createSpy = vi.spyOn(readline, "createInterface");
    const p = createPrompt({ input, output });

    expect(await answer(() => p.ask("one?"), "alpha")).toBe("alpha");
    expect(await answer(() => p.ask("two?"), "bravo")).toBe("bravo");
    expect(await answer(() => p.ask("three?"), "charlie")).toBe("charlie");

    // The old implementation called createInterface (and .close()) once per
    // prompt; that churn was the regression. One interface for the whole
    // sequence is the fix.
    expect(createSpy).toHaveBeenCalledTimes(1);
    p.close();
  });

  it("resolves a prompt whose input arrives after the question is posed (the live read that regressed)", async () => {
    const { input, output, tick } = fakeTerminal();
    const p = createPrompt({ input, output });

    const pending = p.ask("Task goal (optional)", "");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false); // genuinely waiting, nothing pre-buffered

    input.write("ship it\n");
    expect(await pending).toBe("ship it");
    p.close();
  });

  it("handles the menu shape: several selections then a late task-goal line then a clean handoff", async () => {
    const { output, input, answer, tick } = fakeTerminal();
    const createSpy = vi.spyOn(readline, "createInterface");
    const p = createPrompt({ input, output });

    // workspace → agent style selections
    expect(await answer(() => p.ask("Select"), "1")).toBe("1");
    expect(await answer(() => p.ask("Select"), "4")).toBe("4");
    expect(await answer(() => p.ask("Select"), "1")).toBe("1");

    // the task-goal prompt: nothing buffered, typed after a beat
    const goal = p.ask("Task goal (optional)", "");
    await tick();
    input.write("audit regression\n");
    expect(await goal).toBe("audit regression");

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Handoff to launch: close() must be safe and idempotent.
    expect(() => p.close()).not.toThrow();
    expect(() => p.close()).not.toThrow();
  });

  it("close() releases the interface; a later prompt transparently reopens one", async () => {
    const { input, output, answer } = fakeTerminal();
    const createSpy = vi.spyOn(readline, "createInterface");
    const p = createPrompt({ input, output });

    expect(await answer(() => p.ask("q1?"), "first")).toBe("first");
    p.close();
    expect(createSpy).toHaveBeenCalledTimes(1);

    expect(await answer(() => p.ask("q2?"), "second")).toBe("second");
    expect(createSpy).toHaveBeenCalledTimes(2);
    p.close();
  });

  it("confirm() reuses the shared interface and maps yes/no/blank-default", async () => {
    const { input, output, answer } = fakeTerminal();
    const createSpy = vi.spyOn(readline, "createInterface");
    const p = createPrompt({ input, output });

    expect(await answer(() => p.confirm("go?", false), "y")).toBe(true);
    expect(await answer(() => p.confirm("go?", true), "")).toBe(true); // blank → default
    expect(await answer(() => p.confirm("go?", true), "n")).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
    p.close();
  });

  it("askSecret restores the echo hook and keeps the shared interface open for the next prompt", async () => {
    const { input, output, answer } = fakeTerminal();
    const createSpy = vi.spyOn(readline, "createInterface");
    const p = createPrompt({ input, output });

    await answer(() => p.ask("q1?"), "first");
    const rl = createSpy.mock.results[0]!.value as { _writeToOutput?: unknown };
    const beforeHook = rl._writeToOutput;

    expect(await answer(() => p.askSecret("key?"), "sk-live")).toBe("sk-live");
    expect(rl._writeToOutput).toBe(beforeHook); // restored, not left overridden

    expect(await answer(() => p.ask("q3?"), "after")).toBe("after");
    expect(createSpy).toHaveBeenCalledTimes(1); // never recreated
    p.close();
  });
});
