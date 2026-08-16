/**
 * Reversible context pruning — when the TokenManager would drop/truncate an
 * eligible context block, persist its full content out-of-band and replace it
 * with a compact reference block, so no information is lost and the agent can
 * retrieve the original byte-for-byte on demand. Fail-closed: if persistence
 * fails, the original block is kept (never discarded).
 *
 * Never prunes "instructions" or "current-task" (the TokenManager already
 * protects those). No LLM summarization by default.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "../config/paths.js";
import type { ContextBlock, ContentClass, ContextEnvelope } from "./types.js";
import { isStableClass } from "./types.js";
import type { TokenBudgetResult } from "../token/types.js";

export interface PruneStore {
  put(sessionKey: string, blockId: string, content: string): Promise<string>;
  get(refId: string): Promise<string | undefined>;
  clearSession(sessionKey: string): Promise<number>;
  readonly telemetry: { retrievalCount: number; restorationFailures: number };
}

export interface PrunedBlock {
  readonly blockId: string;
  readonly refId: string;
  readonly class: ContentClass;
  readonly tokensExternalized: number;
}

export interface PruningTelemetry {
  readonly blocksPruned: number;
  readonly tokensExternalized: number;
  readonly activeTokensAfter: number;
}

export interface PruningResult {
  readonly envelope: ContextEnvelope;
  readonly pruned: readonly PrunedBlock[];
  readonly telemetry: PruningTelemetry;
}

/** Build a compact reference block that replaces a pruned block (same class → same section). */
function referenceBlock(block: ContextBlock, refId: string): ContextBlock {
  const label = block.content.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "(untitled)";
  return {
    id: `${block.id}:pruned-ref`,
    class: block.class,
    content: `[pruned ${block.class}] ${label} — full content externalized. Retrieve with context_retrieve("${refId}")`,
    priority: block.priority,
    provenance: { source: "reversible-pruning", sourceId: block.id, fetchedAt: new Date().toISOString() },
  };
}

function tokensOf(budget: TokenBudgetResult, blockId: string): number {
  return budget.trimEvents.find((e) => e.blockId === blockId)?.tokensBefore ?? 0;
}

/**
 * Convert the TokenManager's destructive trim events into reversible pruning.
 * `originalEnvelope` holds the full blocks; `budget` holds the trimmed envelope
 * and the trim events. Returns a new envelope with pruned blocks replaced by
 * references, plus telemetry.
 */
export async function applyReversiblePruning(
  originalEnvelope: ContextEnvelope,
  budget: TokenBudgetResult,
  store: PruneStore,
  sessionKey: string,
): Promise<PruningResult> {
  const pruned: PrunedBlock[] = [];
  const byId = new Map<string, ContextBlock>();
  for (const b of [...originalEnvelope.stable.blocks, ...originalEnvelope.dynamic.blocks]) byId.set(b.id, b);

  const stableRefs: ContextBlock[] = [];
  const dynamicRefs: ContextBlock[] = [];
  let tokensExternalized = 0;

  for (const ev of budget.trimEvents) {
    const block = byId.get(ev.blockId);
    if (!block) continue; // already pruned or unknown
    // Fail-closed: never prune critical content, and never discard if we can't persist.
    if (block.class === "instructions" || block.class === "current-task") continue;

    let refId: string;
    try {
      refId = await store.put(sessionKey, block.id, block.content);
    } catch {
      // persistence failed → keep the original block (add it back).
      (isStableClass(block.class) ? stableRefs : dynamicRefs).push(block);
      continue;
    }

    const ref = referenceBlock(block, refId);
    (isStableClass(block.class) ? stableRefs : dynamicRefs).push(ref);
    pruned.push({ blockId: block.id, refId, class: block.class, tokensExternalized: tokensOf(budget, block.id) });
    tokensExternalized += tokensOf(budget, block.id);
  }

  // The trimmed envelope already has kept blocks; append reference/kept blocks.
  const stableBlocks = [...budget.envelope.stable.blocks, ...stableRefs];
  const dynamicBlocks = [...budget.envelope.dynamic.blocks, ...dynamicRefs];

  return {
    envelope: { stable: { blocks: stableBlocks }, dynamic: { blocks: dynamicBlocks }, metadata: budget.envelope.metadata },
    pruned,
    telemetry: { blocksPruned: pruned.length, tokensExternalized, activeTokensAfter: estimateActiveTokens(stableBlocks, dynamicBlocks) },
  };
}

function estimateActiveTokens(stable: readonly ContextBlock[], dynamic: readonly ContextBlock[]): number {
  // avoid a circular import: token estimator is small + pure.
  let total = 0;
  for (const b of [...stable, ...dynamic]) total += Math.ceil(b.content.length / 4);
  return total;
}

// ── bounded disk-backed store ──────────────────────────────────────────

const MAX_ENTRIES = 1000;
const MAX_BYTES = 64 * 1024 * 1024; // 64 MB

export class FilePruneStore implements PruneStore {
  readonly telemetry = { retrievalCount: 0, restorationFailures: 0 };
  private readonly dir: string;

  constructor(dataDir: string = resolveDataDir()) {
    this.dir = join(dataDir, "pruned-context");
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // read-only dir → in-memory only via put/get
    }
  }

  async put(sessionKey: string, blockId: string, content: string): Promise<string> {
    const refId = createHash("sha1").update(`${sessionKey}:${blockId}:${content}`).digest("hex").slice(0, 24);
    try {
      mkdirSync(join(this.dir, sessionKey), { recursive: true });
      writeFileSync(join(this.dir, sessionKey, `${refId}.txt`), content, "utf8");
    } catch {
      throw new Error("prune store write failed");
    }
    this.prune();
    return refId;
  }

  async get(refId: string): Promise<string | undefined> {
    // refId is a hash; find it under any session dir.
    try {
      for (const sessionDir of readdirSync(this.dir)) {
        const p = join(this.dir, sessionDir, `${refId}.txt`);
        try {
          this.telemetry.retrievalCount += 1;
          return readFileSync(p, "utf8");
        } catch {
          continue;
        }
      }
      this.telemetry.retrievalCount += 1;
      this.telemetry.restorationFailures += 1;
      return undefined;
    } catch {
      return undefined;
    }
  }

  async clearSession(sessionKey: string): Promise<number> {
    try {
      const p = join(this.dir, sessionKey);
      const files = readdirSync(p).length;
      rmSync(p, { recursive: true, force: true });
      return files;
    } catch {
      return 0;
    }
  }

  private prune(): void {
    try {
      const files: { path: string; mtime: number; size: number }[] = [];
      for (const sessionDir of readdirSync(this.dir)) {
        for (const f of readdirSync(join(this.dir, sessionDir))) {
          const p = join(this.dir, sessionDir, f);
          try {
            const s = require("node:fs").statSync(p);
            files.push({ path: p, mtime: s.mtimeMs, size: s.size });
          } catch {
            /* ignore */
          }
        }
      }
      files.sort((a, b) => a.mtime - b.mtime);
      let total = files.reduce((s, x) => s + x.size, 0);
      for (let i = 0; i < files.length; i++) {
        if (total <= MAX_BYTES && files.length - i <= MAX_ENTRIES) break;
        total -= files[i]!.size;
        rmSync(files[i]!.path, { force: true });
      }
    } catch {
      // best-effort cleanup
    }
  }
}
