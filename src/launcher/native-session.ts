/**
 * Native-session id discovery — the "capture" half of the native-session
 * bridge. Read-only, best-effort, and provider-independent: it only reads the
 * `NativeSessionStore` data a profile declares; it never switches on provider
 * id and never fabricates an id.
 *
 * The one deliberate heuristic is "the session file most recently created at
 * or after `sinceMs`" — after a launch, the CLI's own session store gains a
 * new file, and this returns its id. Any error, an empty store, or an id that
 * predates the launch yields `undefined`, which the launcher treats as "no
 * known native session" → safe fallback to the resume brief. It is better to
 * fall back than to resume the wrong conversation.
 */

import { promises as fsPromises } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { NativeSessionStore } from "../providers/types.js";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir → skip
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function idFromBasename(name: string, idFrom: NativeSessionStore["idFrom"]): string | undefined {
  const stem = basename(name, extname(name));
  if (idFrom === "basename") return stem;
  // last-uuid: Codex names sessions `rollout-<ts>-<uuid>`; extract the trailing UUID.
  const m = stem.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
  return m?.[1];
}

/**
 * Find the most-recent native session id in `store`, restricted to files
 * modified at/after `sinceMs`. Returns undefined when nothing qualifies.
 */
export async function findRecentNativeSessionId(
  store: NativeSessionStore,
  sinceMs = 0,
): Promise<string | undefined> {
  const root = expandHome(store.rootDir);
  const files: string[] = [];
  await walkFiles(root, files);

  let best: { mtimeMs: number; id: string } | undefined;
  for (const file of files) {
    if (extname(file) !== store.extension) continue;
    let stat;
    try {
      stat = await fsPromises.stat(file);
    } catch {
      continue;
    }
    const mtimeMs = stat.mtimeMs;
    if (mtimeMs < sinceMs) continue;
    const id = idFromBasename(file, store.idFrom);
    if (!id) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, id };
  }
  return best?.id;
}
