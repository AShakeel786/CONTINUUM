/**
 * Deterministic JSON serialization — recursively sorts object keys so the
 * same logical state always produces byte-identical output. Needed for two
 * things in this module: a stable checksum (corruption detection must
 * compare against what was actually written, not be order-sensitive), and
 * predictable diffs/tests.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
