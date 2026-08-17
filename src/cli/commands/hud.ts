/**
 * CONTINUUM session HUD — one compact status line summarizing session state
 * ("CONTINUUM | workspace | provider | ctx used/max | handoff state | bypass ON").
 *
 * Printed at every point CONTINUUM itself controls the terminal (launch,
 * resume, handoff, the interactive front door) — the same `out()` sink the
 * "Session: …" / "Resuming …" lines already use. CONTINUUM never redraws
 * this line mid-session: once a native provider CLI is spawned with
 * inherited stdio (src/launcher/spawn.ts), that subprocess owns the
 * terminal and CONTINUUM has no rendering surface left. "Live" here means
 * "current as of the moment CONTINUUM last had the terminal", not a
 * continuously repainting bar — building the latter would mean wrapping the
 * native CLI's PTY, a much heavier change this v1 deliberately avoids.
 *
 * Every field is read from state a system already tracks — no counter,
 * poller, or duplicate ledger is introduced by this module:
 *   - workspace       → LaunchPreparation.project / session.mode (launcher.ts)
 *   - provider        → ProviderRegistry's own profile.displayName
 *   - context used/max → the Token Manager's own budget result
 *     (src/token/budget.ts), threaded through LaunchPreparation instead of
 *     re-estimated here
 *   - handoff state   → TaskSession.status + Launcher.listAuthenticatedProviders()
 *   - memory state    → LaunchPreparation.memoryCoreAvailable
 *   - permission mode → LaunchPlan.bypassPermissions
 *
 * There is deliberately no cost field: no part of this codebase tracks
 * $/token rates or accumulates actual spend (the "pricing" system only
 * knows peak/off-peak time windows, see src/pricing/types.ts). Inventing a
 * number here would violate "never show fake/unknown data" — see the audit
 * note in the HUD test file and the task's final report for the limitation.
 */

import { homedir } from "node:os";
import type { LaunchPreparation } from "../../launcher/types.js";
import type { Launcher } from "../../launcher/launcher.js";
import type { ProviderRegistry } from "../../providers/registry.js";

export type HandoffHudState = "ready" | "pending" | "off";

export interface HudData {
  readonly workspace: string;
  readonly providerLabel: string;
  /** Both set or both absent — the Token Manager's post-budget count and the provider's context-window ceiling. */
  readonly contextUsed?: number;
  readonly contextMax?: number;
  readonly handoff: HandoffHudState;
  /** True only when memory (MemoryCore) is unavailable — an on/default memory state is not shown (nothing notable to report). */
  readonly memoryOff: boolean;
  readonly bypass: boolean;
}

function formatWorkspace(prep: LaunchPreparation): string {
  const mode = prep.session?.mode ?? "project";
  if (mode === "general") return "General";
  if (mode === "current-directory") {
    const path = prep.project.path;
    const home = homedir();
    if (path === home) return "~";
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }
  return prep.project.name;
}

/**
 * Handoff readiness: "pending" when the session is already mid-handoff,
 * "ready" when at least one other authenticated agent could take over
 * (the same check `continuum handoff` itself uses), else "off". Never
 * throws — a listAuthenticatedProviders failure degrades to "off" rather
 * than blocking the HUD line.
 */
async function resolveHandoffState(prep: LaunchPreparation, launcher: Launcher): Promise<HandoffHudState> {
  if (prep.session?.status === "handoff-pending") return "pending";
  try {
    const authenticated = await launcher.listAuthenticatedProviders();
    const others = authenticated.filter((p) => p.providerId !== prep.providerRef.providerId);
    return others.length > 0 ? "ready" : "off";
  } catch {
    return "off";
  }
}

export async function buildHudData(
  prep: LaunchPreparation,
  deps: { readonly launcher: Launcher; readonly providers: ProviderRegistry },
): Promise<HudData> {
  const providerLabel = deps.providers.has(prep.providerRef.providerId)
    ? deps.providers.get(prep.providerRef.providerId).profile.displayName
    : prep.providerRef.providerId;

  return {
    workspace: formatWorkspace(prep),
    providerLabel,
    contextUsed: prep.contextTokensUsed,
    contextMax: prep.contextWindowTokens,
    handoff: await resolveHandoffState(prep, deps.launcher),
    memoryOff: !prep.memoryCoreAvailable,
    bypass: prep.plan.bypassPermissions,
  };
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

function formatContext(used: number, max: number, style: "full" | "percent"): string {
  if (style === "percent") {
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    return `ctx ${pct}%`;
  }
  return `ctx ${formatTokenCount(used)}/${formatTokenCount(max)}`;
}

const SEP = " | ";

/** Lower weight = dropped first when the line doesn't fit; 0/1 (brand + workspace) are never dropped. */
interface Segment {
  readonly text: string;
  readonly weight: number;
}

function buildSegments(d: HudData): Segment[] {
  const segs: Segment[] = [
    { text: "CONTINUUM", weight: 0 },
    { text: d.workspace, weight: 1 },
  ];
  // Permission mode is safety-relevant — kept high priority, and (matching
  // the "especially bypass ON" requirement) only ever shown when true; a
  // safe/default session says nothing here.
  if (d.bypass) segs.push({ text: "bypass ON", weight: 2 });
  segs.push({ text: d.providerLabel, weight: 3 });
  if (d.contextUsed !== undefined && d.contextMax !== undefined) {
    segs.push({ text: formatContext(d.contextUsed, d.contextMax, "full"), weight: 4 });
  }
  segs.push({ text: `handoff ${d.handoff}`, weight: 5 });
  if (d.memoryOff) segs.push({ text: "memory off", weight: 6 });
  return segs;
}

/**
 * Render the HUD line for the given terminal width. Progressive
 * degradation instead of wrapping: first compact "ctx used/max" to a
 * percentage, then drop segments lowest-priority-first (memory, handoff,
 * context, provider — brand/workspace/bypass-ON always survive), then as a
 * last resort hard-truncate with an ellipsis.
 */
export function formatHud(d: HudData, columns: number): string {
  const full = buildSegments(d);
  const join = (segs: readonly Segment[]) => segs.map((s) => s.text).join(SEP);

  let line = join(full);
  if (line.length <= columns) return line;

  if (d.contextUsed !== undefined && d.contextMax !== undefined) {
    const compact = full.map((s) => (s.weight === 4 ? { ...s, text: formatContext(d.contextUsed!, d.contextMax!, "percent") } : s));
    line = join(compact);
    if (line.length <= columns) return line;
    full.splice(0, full.length, ...compact);
  }

  let segs = full;
  const dropOrder = [...segs].sort((a, b) => b.weight - a.weight);
  for (const drop of dropOrder) {
    if (drop.weight <= 2) break; // never drop brand/workspace/bypass-ON
    segs = segs.filter((s) => s !== drop);
    line = join(segs);
    if (line.length <= columns) return line;
  }

  if (columns <= 1) return line.slice(0, Math.max(0, columns));
  return `${line.slice(0, columns - 1)}…`;
}

/** Convenience: build + render + print the HUD line via the same `out()` sink launch/resume/handoff already use. Never throws — a HUD failure must never block a launch. */
export async function printHud(
  out: (s: string) => void,
  prep: LaunchPreparation,
  deps: { readonly launcher: Launcher; readonly providers: ProviderRegistry },
  columns: number,
): Promise<void> {
  try {
    const data = await buildHudData(prep, deps);
    out(`${formatHud(data, columns)}\n`);
  } catch {
    // Status line is best-effort only.
  }
}
