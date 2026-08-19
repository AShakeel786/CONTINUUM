import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NativeSessionStore } from "../providers/types.js";
import type { TokenUsageEstimate } from "./types.js";

function root(path: string): string { return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path; }

async function find(dir: string, id: string, ext: string): Promise<string | undefined> {
  let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const hit = await find(path, id, ext); if (hit) return hit; }
    else if (entry.isFile() && entry.name === `${id}${ext}`) return path;
  }
  return undefined;
}

export async function nativeSessionFile(store: NativeSessionStore, nativeSessionId: string): Promise<string | undefined> {
  // SQLite-backed stores (Antigravity) carry no per-session file to inspect;
  // cost/usage tracking from a native session file is only defined for the
  // file-backed Claude/DeepSeek stores.
  if (store.kind !== "files") return undefined;
  return find(root(store.rootDir), nativeSessionId, store.extension);
}

export async function readClaudeUsage(file: string): Promise<TokenUsageEstimate> {
  const total = { inputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0, contextTokens: 0, turns: 0 };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const record = JSON.parse(line) as { message?: { usage?: Record<string, unknown> } };
      const u = record.message?.usage;
      if (!u) continue;
      const input = Number(u.input_tokens ?? 0);
      const hit = Number(u.cache_read_input_tokens ?? 0);
      const miss = Number(u.cache_creation_input_tokens ?? 0) + input;
      const output = Number(u.output_tokens ?? 0);
      total.inputTokens += input + hit + Number(u.cache_creation_input_tokens ?? 0);
      total.cacheHitTokens += hit;
      total.cacheMissTokens += miss;
      total.outputTokens += output;
      total.contextTokens = Math.max(total.contextTokens, input + hit + Number(u.cache_creation_input_tokens ?? 0));
      total.turns += 1;
    } catch { /* partial/in-progress JSONL line */ }
  }
  return total;
}

export async function readClaudeTurns(file: string): Promise<readonly { at?: string; usage: TokenUsageEstimate }[]> {
  const result: { at?: string; usage: TokenUsageEstimate }[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const record = JSON.parse(line) as { timestamp?: string; message?: { usage?: Record<string, unknown> } };
      const u = record.message?.usage; if (!u) continue;
      const input = Number(u.input_tokens ?? 0), hit = Number(u.cache_read_input_tokens ?? 0), creation = Number(u.cache_creation_input_tokens ?? 0), output = Number(u.output_tokens ?? 0);
      result.push({ ...(record.timestamp ? { at: record.timestamp } : {}), usage: { inputTokens: input + hit + creation, cacheHitTokens: hit, cacheMissTokens: input + creation, outputTokens: output, contextTokens: input + hit + creation, turns: 1 } });
    } catch { /* partial line */ }
  }
  return result;
}
