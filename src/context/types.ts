/**
 * The canonical, provider-independent context representation. Every
 * integration path (native Claude, DeepSeek-via-proxy, a future MCP tool
 * call) assembles into this shape once; provider adapters only *render* it
 * (`src/rendering/`), they never select what goes in it.
 *
 * Starting pattern: `MemoryCore/src/core/hooks/auto-recall.ts`'s stable/
 * dynamic split (`appendSystemContext` vs `prependContext`) — the most
 * mature of the three divergent context-assembly implementations the
 * Phase 1 audit found (see PHASE_4_CONTEXT_ARCHITECTURE.md §1 for why the
 * other two, Hermes v1's flat `prefetch()` and MemoryProxy's own
 * `src/injection/*` pipeline, were read but not copied directly).
 *
 * Improvement over a plain two-string split (`auto-recall.ts`'s actual
 * shape): each section is an ordered array of provenance-tagged
 * `ContextBlock`s, not one concatenated string. MemoryProxy's own
 * `src/injection/types.ts` (`ContextBlock`/`SemanticSlot`) already proved
 * this is the right level of structure for a system with multiple content
 * sources and a Token Manager that needs to trim individual pieces, not
 * regex-hack a blob.
 */

// ── Content classification ──────────────────────────────────────────────
//
// Matches the brief's target shape (stable: system/instructions, project
// context, stable memory/persona, tool/static context; dynamic: relevant
// recalled memory, current task, recent conversation, tool results), plus
// one addition grounded in source evidence: `scene-index` — auto-recall.ts
// injects L2 scene navigation as its own stable segment, distinct from L3
// persona (different provenance, different budget priority), and collapsing
// it into "persona" would lose that distinction.

export type StableContentClass =
  | "instructions"
  | "project-context"
  | "persona"
  | "scene-index"
  | "static-tools";

export type DynamicContentClass =
  | "recalled-memory"
  | "current-task"
  | "recent-conversation"
  | "tool-results";

export type ContentClass = StableContentClass | DynamicContentClass;

export function isStableClass(cls: ContentClass): cls is StableContentClass {
  return (
    cls === "instructions" ||
    cls === "project-context" ||
    cls === "persona" ||
    cls === "scene-index" ||
    cls === "static-tools"
  );
}

// ── Provenance ───────────────────────────────────────────────────────────

/**
 * Where a block came from, kept alongside the content itself. Required,
 * not optional — every block in this system must be traceable to a real
 * source; there is no "no provenance" default in the type.
 */
export interface ContextBlockProvenance {
  /** e.g. "memorycore-gateway:/v3/core/read", "memorycore-gateway:/v3/atomic/search", "caller-supplied". */
  readonly source: string;
  /** Source-side identifier (e.g. an L1 memory record id), when one exists. */
  readonly sourceId?: string;
  /** Relevance score from the source system, when one exists (e.g. L1 search score). */
  readonly score?: number;
  /** When this block was fetched/assembled, ISO 8601. */
  readonly fetchedAt: string;
}

// ── Blocks ───────────────────────────────────────────────────────────────

export interface ContextBlock {
  /**
   * Deterministic id, stable across re-assembly of the same underlying
   * content (used for ordering ties, dedup, and cache-prefix-stability
   * hashing in the cache layer — see src/cache/invalidation.ts).
   */
  readonly id: string;
  readonly class: ContentClass;
  readonly content: string;
  /**
   * Trim priority within the Token Manager (src/token/budget.ts): lower
   * numbers are dropped last. Not a global ordering key — ordering is
   * `class` first (src/context/ordering.ts), `priority` only decides what
   * gets trimmed first *within* a budget-constrained pass.
   */
  readonly priority: number;
  readonly provenance: ContextBlockProvenance;
}

export interface ContextSection {
  readonly blocks: readonly ContextBlock[];
}

// ── Envelope metadata ────────────────────────────────────────────────────

export interface ContextEnvelopeMetadata {
  readonly sessionKey: string;
  readonly query: string;
  /** Recall strategy actually used by the source (e.g. "hybrid", "fts"), when known. */
  readonly recallStrategy?: string;
  readonly assembledAt: string;
  /**
   * Free-form, secret-free extension metadata (e.g. team/agent identity for
   * multi-agent merge, matching MemoryProxy's "self + imported" pattern).
   * Never a place to put a credential — enforced by convention + the
   * no-secrets test suite, same as the provider layer.
   */
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
}

// ── The envelope ─────────────────────────────────────────────────────────

export interface ContextEnvelope {
  readonly stable: ContextSection;
  readonly dynamic: ContextSection;
  readonly metadata: ContextEnvelopeMetadata;
}
