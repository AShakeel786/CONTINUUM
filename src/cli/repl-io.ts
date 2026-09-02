/**
 * Terminal adapter for the interactive Direct-API session. Assistant text and
 * info go to stdout; the transient status line (`THINKING…`, `TOOL …`,
 * `GENERATING…`) and the telemetry footer go to stderr, so a piped stdout
 * stays clean. On a non-TTY the status line degrades to a single plain line
 * (no cursor tricks).
 */

import readline from "node:readline";
import type { InteractiveIo } from "../api-agent/interactive.js";

export function createReplIo(): InteractiveIo & { close(): void } {
  const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
  let statusActive = false;

  const clearStatus = (): void => {
    if (statusActive && (process.stderr as NodeJS.WriteStream).isTTY) {
      process.stderr.write("\r\x1b[K");
    } else if (statusActive) {
      process.stderr.write("\n");
    }
    statusActive = false;
  };

  return {
    async readLine(prompt: string): Promise<string | null> {
      clearStatus();
      return new Promise((resolve) => {
        let done = false;
        const onClose = (): void => { if (!done) { done = true; resolve(null); } };
        rl.once("close", onClose);
        rl.question(prompt, (answer) => {
          done = true;
          rl.removeListener("close", onClose);
          resolve(answer);
        });
      });
    },
    write(text: string): void {
      clearStatus();
      process.stdout.write(text);
    },
    status(line: string): void {
      if (!line) { clearStatus(); return; }
      if ((process.stderr as NodeJS.WriteStream).isTTY) {
        process.stderr.write(`\r\x1b[K${line}`);
        statusActive = true;
      } else {
        process.stderr.write(`${line}\n`);
      }
    },
    clearStatus,
    close(): void {
      clearStatus();
      rl.close();
    },
  };
}
