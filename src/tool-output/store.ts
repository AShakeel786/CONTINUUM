/**
 * Raw tool-output retention. Every optimized result stores its complete
 * original here (out-of-band), addressed by a `tool-output://<id>` reference,
 * so an agent can retrieve the byte-for-byte original on demand. Bounded:
 * a small in-memory LRU + a disk dir under `~/.continuum/tool-output/` that is
 * pruned to a max-entry/max-byte budget on each write. Never written into the
 * project tree, so it cannot become a committed artifact.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveDataDir } from "../config/paths.js";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32 MB total on disk

export interface RawStoreLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface RawOutputStore {
  put(text: string): string;
  get(id: string): string | undefined;
  readonly size: number;
}

export class FileRawOutputStore implements RawOutputStore {
  private readonly dir: string;
  private readonly limits: RawStoreLimits;
  private readonly mem = new Map<string, string>();
  private order: string[] = []; // LRU order (oldest first)

  constructor(dataDir: string = resolveDataDir(), limits: RawStoreLimits = { maxEntries: DEFAULT_MAX_ENTRIES, maxBytes: DEFAULT_MAX_BYTES }) {
    this.dir = join(dataDir, "tool-output");
    this.limits = limits;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // unreadable dir → in-memory only
    }
  }

  get size(): number {
    return this.mem.size;
  }

  put(text: string): string {
    const id = createHash("sha1").update(text).update(randomUUID()).digest("hex").slice(0, 24);
    this.mem.set(id, text);
    this.order.push(id);
    try {
      writeFileSync(join(this.dir, `${id}.txt`), text, "utf8");
    } catch {
      // disk failure → memory-only retention still works
    }
    this.prune();
    return id;
  }

  get(id: string): string | undefined {
    const memHit = this.mem.get(id);
    if (memHit !== undefined) {
      // refresh LRU
      this.order = this.order.filter((x) => x !== id);
      this.order.push(id);
      return memHit;
    }
    try {
      const text = readFileSync(join(this.dir, `${id}.txt`), "utf8");
      this.mem.set(id, text);
      this.order.push(id);
      this.prune();
      return text;
    } catch {
      return undefined;
    }
  }

  private prune(): void {
    // enforce entry cap (memory)
    while (this.mem.size > this.limits.maxEntries) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      this.mem.delete(oldest);
      rmSync(join(this.dir, `${oldest}.txt`), { force: true });
    }
    // enforce total-byte cap (disk)
    try {
      const files = readdirSync(this.dir)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => ({ f, m: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => a.m - b.m);
      let total = files.reduce((s, x) => s + statSync(join(this.dir, x.f)).size, 0);
      for (const { f } of files) {
        if (total <= this.limits.maxBytes) break;
        const p = join(this.dir, f);
        total -= statSync(p).size;
        rmSync(p, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
}

export const defaultRawStore: RawOutputStore = new FileRawOutputStore();
