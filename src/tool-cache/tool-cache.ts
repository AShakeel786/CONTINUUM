/**
 * Deterministic Tool Result Cache — caches read-only, deterministic MCP tool
 * results keyed by (tool name, canonical args, scope fingerprint) so an agent
 * does not re-run and re-feed identical results. Fail-safe: any uncertainty in
 * the scope fingerprint → miss (never a stale hit). Provider-independent.
 *
 * Scope:
 *   - "global"  → keyed on args only (deterministic forever, e.g. raw retrieval).
 *   - "project" → keyed on repo HEAD/dirty fingerprint.
 *   - "session" → keyed on the session's revision (changes on any session write).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCacheScope } from "../mcp/tools.js";

export interface ToolScopeProvider {
  /** Repo HEAD/dirty fingerprint; undefined = can't determine → miss. */
  projectFingerprint?(): Promise<string | undefined>;
  /** Session revision fingerprint; undefined = can't determine → miss. */
  sessionFingerprint?(sessionId: string): Promise<string | undefined>;
}

export interface CacheTelemetry {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
  tokensAvoided: number;
}

export interface ToolResultCacheLimits {
  readonly maxEntries: number;
  readonly ttlMs: number;
}

interface CacheEntry {
  readonly text: string;
  readonly tokensSaved: number;
  readonly expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes

export class ToolResultCache {
  private readonly map = new Map<string, CacheEntry>();
  private order: string[] = [];
  private readonly limits: ToolResultCacheLimits;
  readonly telemetry: CacheTelemetry = { hits: 0, misses: 0, evictions: 0, invalidations: 0, tokensAvoided: 0 };

  constructor(limits: Partial<ToolResultCacheLimits> = {}, private readonly diskDir?: string) {
    this.limits = { maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES, ttlMs: limits.ttlMs ?? DEFAULT_TTL_MS };
    if (diskDir) this.loadFromDisk();
  }

  get(key: string, now: number = Date.now()): string | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      this.delete(key);
      return undefined;
    }
    // refresh LRU
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    return e.text;
  }

  set(key: string, text: string, tokensSaved: number, now: number = Date.now()): void {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, { text, tokensSaved, expiresAt: now + this.limits.ttlMs });
    this.order.push(key);
    this.persist(key, text, tokensSaved, now);
    this.prune(now);
  }

  private persist(key: string, text: string, tokensSaved: number, now: number): void {
    if (!this.diskDir) return;
    try {
      mkdirSync(this.diskDir, { recursive: true });
      writeFileSync(join(this.diskDir, `${key}.json`), JSON.stringify({ text, tokensSaved, expiresAt: now + this.limits.ttlMs }), "utf8");
    } catch {
      // disk write failure → in-memory only
    }
  }

  private loadFromDisk(): void {
    try {
      const now = Date.now();
      for (const f of readdirSync(this.diskDir!)) {
        if (!f.endsWith(".json")) continue;
        try {
          const e = JSON.parse(readFileSync(join(this.diskDir!, f), "utf8")) as CacheEntry;
          if (e.expiresAt <= now) { rmSync(join(this.diskDir!, f), { force: true }); continue; }
          const key = f.slice(0, -5);
          this.map.set(key, e);
          this.order.push(key);
        } catch {
          // corrupt entry → skip
        }
      }
      this.prune(now);
    } catch {
      // unreadable dir → in-memory only
    }
  }

  /** Number of tokens this cache entry would have avoided (for telemetry). */
  tokensSavedForKey(key: string): number {
    return this.map.get(key)?.tokensSaved ?? 0;
  }

  delete(key: string): void {
    if (this.map.delete(key)) {
      this.order = this.order.filter((k) => k !== key);
      if (this.diskDir) rmSync(join(this.diskDir, `${key}.json`), { force: true });
    }
  }

  invalidateScope(scopePrefix: string): number {
    let n = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(scopePrefix)) {
        this.delete(key);
        n += 1;
      }
    }
    this.telemetry.invalidations += n;
    return n;
  }

  private prune(now: number): void {
    // TTL expiry
    for (const [k, e] of this.map) {
      if (e.expiresAt <= now) this.delete(k);
    }
    // LRU eviction
    while (this.map.size > this.limits.maxEntries) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      if (this.map.delete(oldest)) this.telemetry.evictions += 1;
    }
  }
}

/** Canonical, order-independent JSON of args (secret-free — args carry no credentials here). */
export function canonicalArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = args[k];
  try {
    return JSON.stringify(o);
  } catch {
    return String(args);
  }
}

/** Compute a deterministic cache key for a tool call. `scopeFingerprint` may be undefined → caller must MISS. */
export function computeCacheKey(toolName: string, argsJson: string, scope: ToolCacheScope, scopeFingerprint: string | undefined): string | undefined {
  if (scopeFingerprint === undefined) return undefined;
  const base = `${toolName}\n${canonicalArgs(safeParseArgs(argsJson))}\n${scope}\n${scopeFingerprint}`;
  return createHash("sha1").update(base).digest("hex").slice(0, 32);
}

function safeParseArgs(argsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsJson);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : { _: v };
  } catch {
    return { _: argsJson };
  }
}
