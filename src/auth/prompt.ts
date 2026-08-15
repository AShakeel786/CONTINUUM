/**
 * Interactive prompt abstraction for onboarding.
 *
 * Everything that reads user input goes through a `Prompt`, so every flow
 * (setup, auth, doctor) is testable with an injected scripted/fake prompt
 * and no real terminal. The two concrete capabilities:
 *
 *   - `askSecret` — a masked, single-line secret entry. When stdin is a
 *     real TTY it disables echo so a pasted API key is never displayed or
 *     echoed to the scrollback; when stdin is NOT a TTY (piped/tests) it
 *     degrades to a plain read (no masking possible, and there is no human
 *     watching a terminal there anyway).
 *   - `ask` / `confirm` — non-secret free-text and yes/no prompts.
 *
 * The raw-mode echo toggle uses only the POSIX `termios` machinery exposed
 * by Node's built-in `readline` (`_writeToOutput` guard) — no new
 * dependencies, no native modules.
 */

import readline from "node:readline";

export interface Prompt {
  /** Non-secret free-text question. Empty input returns as `defaultText` (or ""). */
  ask(question: string, defaultText?: string): Promise<string>;
  /** Single-line masked secret entry. The value is never echoed. */
  askSecret(question: string): Promise<string>;
  /** Yes/no with a default; returns a boolean. */
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

export type PromptOutput = (text: string) => void;

export interface CreatePromptOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/** A throw-safe no-op terminal callback, so setup flows can run without touching a real TTY. */
export function noopOutput(): PromptOutput {
  return () => {};
}

const defaults = {
  input: () => process.stdin,
  output: () => process.stdout,
};

/**
 * A real terminal prompt. The masking mechanism: disable echo while reading
 * a secret line, restoring it after. When stdin is not a TTY, echo control
 * is meaningless and the read proceeds unmasked.
 */
export function createPrompt(options: CreatePromptOptions = {}): Prompt {
  const input = options.input ?? defaults.input();
  const output = options.output ?? defaults.output();

  function makeRl(): readline.Interface {
    return readline.createInterface({ input, output, terminal: true });
  }

  async function ask(question: string, defaultText = ""): Promise<string> {
    const rl = makeRl();
    try {
      const answer = await new Promise<string>((resolve) => {
        const suffix = defaultText ? ` [${defaultText}]` : "";
        rl.question(`${question}${suffix} `, resolve);
      });
      return (answer ?? "").trim() || defaultText;
    } finally {
      rl.close();
    }
  }

  async function askSecret(question: string): Promise<string> {
    const rl = makeRl();
    const isTTY = (input as { isTTY?: boolean }).isTTY === true;
    // Node's readline `Interface` has an undocumented `_writeToOutput`
    // hook that receives every raw keystroke as it's echoed. Overriding it
    // suppresses secret echo while still accepting the line. It's not in the
    // public type, so it's accessed through a narrow structural cast.
    const rlWithHook = rl as unknown as { _writeToOutput?: (chunk: string) => void };
    try {
      const originalWrite = rlWithHook._writeToOutput;
      if (isTTY && typeof originalWrite === "function") {
        rlWithHook._writeToOutput = (chunk: string) => {
          // Suppress everything except the line terminator, so the cursor
          // stays stable but the secret never appears in scrollback.
          if (chunk === "\n" || chunk === "\r\n" || chunk === "\r") {
            originalWrite.call(rlWithHook, chunk);
          }
        };
      }
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${question} `, resolve);
      });
      return (answer ?? "").replace(/\r?\n$/, "");
    } finally {
      rl.close();
    }
  }

  async function confirm(question: string, defaultValue = false): Promise<boolean> {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = await ask(`${question} ${hint}`, defaultValue ? "y" : "n");
    const normalized = answer.toLowerCase();
    if (normalized === "y" || normalized === "yes") return true;
    if (normalized === "n" || normalized === "no") return false;
    return defaultValue;
  }

  return { ask, askSecret, confirm };
}

/**
 * A scripted prompt for tests: answers are consumed in order per method.
 * Keeps an in-memory record of every secret value it was *asked* to surface
 * (for no-leak assertions) but returns scripted values.
 */
export function createScriptedPrompt(script: {
  readonly answers?: readonly string[];
  readonly secrets?: readonly string[];
  readonly confirms?: readonly boolean[];
}): Prompt & { readonly askedSecrets: readonly string[]; readonly log: readonly string[] } {
  const answers = [...(script.answers ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const askedSecrets: string[] = [];
  const log: string[] = [];

  return {
    async ask(question: string, defaultText = ""): Promise<string> {
      log.push(question);
      return answers.length > 0 ? answers.shift()! : defaultText;
    },
    async askSecret(question: string): Promise<string> {
      const v = secrets.length > 0 ? secrets.shift()! : "";
      askedSecrets.push(v);
      log.push(question);
      return v;
    },
    async confirm(question: string, defaultValue = false): Promise<boolean> {
      log.push(question);
      return confirms.length > 0 ? confirms.shift()! : defaultValue;
    },
    get askedSecrets(): readonly string[] {
      return askedSecrets;
    },
    get log(): readonly string[] {
      return log;
    },
  };
}
