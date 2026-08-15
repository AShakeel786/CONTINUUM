/**
 * Precise per-block cache-invalidation diffing.
 *
 * Phase 4's `PrefixStabilityTracker` (invalidation.ts) could only say
 * "the stable prefix changed since last turn" — it retained a hash, not
 * the previous envelope, so it couldn't name *which* block changed
 * (documented limitation, invalidation.ts's `describeChange`). Phase 5's
 * session store now durably persists a `ContextEnvelope` snapshot
 * (`TaskSession.contextEnvelope`) across turns *and* restarts, which is
 * exactly the missing ingredient — this module only exists because that
 * storage now makes it possible, per the Phase 5 brief's "implement this
 * only if it fits naturally into session storage."
 *
 * Deliberately narrow: this is a diff of one stable section against
 * another, nothing more — no trend tracking, no aggregate stats, no
 * general analytics, per "do not expand into general analytics."
 */

import { createHash } from "node:crypto";
import type { ContextBlock } from "../context/types.js";

export type BlockChangeType = "added" | "removed" | "modified" | "unchanged";

export interface BlockChangeDiff {
  readonly blockId: string;
  readonly class: string;
  readonly changeType: BlockChangeType;
  readonly previousHash?: string;
  readonly currentHash?: string;
}

function hashBlockContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Diffs two lists of stable blocks by id. A block present in both with
 * identical content hashes as "unchanged"; different content hashes as
 * "modified"; present only in `current` as "added"; present only in
 * `previous` as "removed".
 */
export function diffStableBlocks(
  previous: readonly ContextBlock[],
  current: readonly ContextBlock[],
): readonly BlockChangeDiff[] {
  const previousById = new Map(previous.map((b) => [b.id, b]));
  const currentById = new Map(current.map((b) => [b.id, b]));
  const diffs: BlockChangeDiff[] = [];

  for (const [id, block] of currentById) {
    const prior = previousById.get(id);
    const currentHash = hashBlockContent(block.content);
    if (!prior) {
      diffs.push({ blockId: id, class: block.class, changeType: "added", currentHash });
      continue;
    }
    const previousHash = hashBlockContent(prior.content);
    diffs.push({
      blockId: id,
      class: block.class,
      changeType: previousHash === currentHash ? "unchanged" : "modified",
      previousHash,
      currentHash,
    });
  }

  for (const [id, block] of previousById) {
    if (!currentById.has(id)) {
      diffs.push({ blockId: id, class: block.class, changeType: "removed", previousHash: hashBlockContent(block.content) });
    }
  }

  return diffs;
}

/** Human-readable summary of a diff, e.g. "1 modified (persona), 1 added (scene-index)". Only mentions changed blocks — "unchanged" is the majority case and would just be noise. */
export function summarizeBlockDiff(diffs: readonly BlockChangeDiff[]): string {
  const changed = diffs.filter((d) => d.changeType !== "unchanged");
  if (changed.length === 0) return "no changes";
  return changed.map((d) => `${d.changeType} (${d.class}:${d.blockId})`).join(", ");
}
