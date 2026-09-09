/**
 * DeepSeek-bound JSON-schema sanitization.
 *
 * DeepSeek's API validates tool `input_schema` values with a stricter regex
 * dialect than ECMA-262: a character class containing a raw (unescaped) `[`
 * is rejected with HTTP 400 (`... is not a "regex"`). Claude Code 2.1.265+
 * emits such patterns in the Artifact tool family, e.g. the `field` property
 * of the artifact `str_replace` edit op:
 *
 *   ^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$
 *
 * In ECMA-262 a literal `[` inside a class may be written bare, and `\[`
 * denotes the same single character — so escaping it is a provable
 * equivalence, not a semantic change, and `\[` is also the portable spelling
 * accepted by stricter engines (RE2, Rust regex, and DeepSeek's own
 * validator, verified live). Patterns without the unsupported construct are
 * preserved byte-for-byte; a pattern that cannot be represented this way is
 * left untouched rather than guessed at. The original schema object is never
 * mutated — only the provider-bound copy is changed.
 */

/** True when `pattern` contains a raw `[` inside a character class. */
export function hasUnsupportedDeepSeekPattern(pattern: string): boolean {
  return sanitizePatternForDeepSeek(pattern).changed;
}

/**
 * Rewrite a regex string into DeepSeek's accepted dialect: escape raw `[`
 * characters that appear inside a character class. Everything else —
 * lookaheads, `\p{...}` property escapes, negated classes, escaped slashes —
 * is preserved verbatim.
 */
export function sanitizePatternForDeepSeek(pattern: string): { pattern: string; changed: boolean } {
  let out = "";
  let changed = false;
  let inClass = false;
  let escaped = false;
  let classHasContent = false; // a leading `]` is a literal member (ECMA-262)
  for (const c of pattern) {
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === "]") {
        if (classHasContent) inClass = false;
        else classHasContent = true;
        out += c;
        continue;
      }
      classHasContent = true;
      if (c === "[") {
        out += "\\[";
        changed = true;
        continue;
      }
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      classHasContent = false;
    }
    out += c;
  }
  return { pattern: out, changed };
}

export interface SanitizedToolSchema {
  /** Deep clone of the input schema; identical to the input when unchanged. */
  schema: unknown;
  /** `pattern` values that were rewritten (original → sanitized). */
  changedPatterns: readonly { original: string; sanitized: string }[];
}

function cloneAndSanitize(node: unknown, changedPatterns: { original: string; sanitized: string }[]): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map((item) => cloneAndSanitize(item, changedPatterns));
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "pattern" && typeof value === "string") {
      const result = sanitizePatternForDeepSeek(value);
      if (result.changed) changedPatterns.push({ original: value, sanitized: result.pattern });
      out[key] = result.pattern;
      continue;
    }
    out[key] = cloneAndSanitize(value, changedPatterns);
  }
  return out;
}

/**
 * Return a provider-bound copy of a tool input schema, sanitized for DeepSeek
 * where required. Walks every nesting level (objects and arrays). The input
 * object is never mutated; when nothing changes the clone is still a new
 * object, so callers can always treat the result as provider-owned.
 */
export function sanitizeToolSchemaForDeepSeek(schema: unknown): SanitizedToolSchema {
  const changedPatterns: { original: string; sanitized: string }[] = [];
  const clone = cloneAndSanitize(schema, changedPatterns);
  return { schema: clone, changedPatterns };
}

/**
 * Provider-gated tool-schema sanitization. Only `deepseek` tool copies are
 * sanitized; every other provider's tools are returned untouched (same
 * reference, no copy, no mutation). Used by the DeepSeek proxy and available
 * to any future Anthropic→provider tool translation that needs it.
 */
export function sanitizeToolsForProvider(
  tools: readonly Record<string, unknown>[],
  providerId: string,
): readonly Record<string, unknown>[] {
  if (providerId !== "deepseek") return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || !("input_schema" in tool)) return tool;
    const result = sanitizeToolSchemaForDeepSeek(tool.input_schema);
    return { ...tool, input_schema: result.schema };
  });
}
