import { describe, expect, it } from "vitest";
import {
  hasUnsupportedDeepSeekPattern,
  sanitizePatternForDeepSeek,
  sanitizeToolSchemaForDeepSeek,
  sanitizeToolsForProvider,
} from "../deepseek-schema-sanitizer.js";

// The exact pattern Claude Code 2.1.265+ attaches to the Artifact tool family
// (the `field` property of the artifact `str_replace` edit op), as seen on
// the wire in DeepSeek's HTTP 400:
//   Invalid schema for function 'Artifact': "<this pattern>" is not a "regex"
const ARTIFACT_PATTERN = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$";
// Same pattern with the raw `[` inside the class escaped — the portable,
// semantics-preserving spelling DeepSeek accepts (verified live, HTTP 200).
const ARTIFACT_PATTERN_SANITIZED = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./\\[\\]]{1,200}$";

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) freezeDeep(v);
  }
}

describe("sanitizePatternForDeepSeek", () => {
  it("escapes the raw [ inside the offending Artifact class", () => {
    const result = sanitizePatternForDeepSeek(ARTIFACT_PATTERN);
    expect(result.changed).toBe(true);
    expect(result.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
    expect(hasUnsupportedDeepSeekPattern(ARTIFACT_PATTERN)).toBe(true);
  });

  it("leaves supported regexes byte-for-byte unchanged", () => {
    const supported = [
      "^[a-z0-9_]+$",
      "^(?!\\.\\.?(?:\\/|$))[A-Za-z0-9_\\-.~:@+]{1,200}$",
      "^\\/[A-Za-z]:(?=[\\\\/]|$)",
      "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
      "^[ +\\-][^\\x00-\\x08\\x0A-\\x1F\\x7F-\\x9F\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]*\\r?$",
      "^[^\\p{Cc}\\p{Cf}]{1,200}$",
      "^[a-z\\[]]{1,200}$",
      "^(?!__.*__$)[a-z]{1,200}$",
    ];
    for (const pattern of supported) {
      const result = sanitizePatternForDeepSeek(pattern);
      expect(result.pattern).toBe(pattern);
      expect(result.changed).toBe(false);
      expect(hasUnsupportedDeepSeekPattern(pattern)).toBe(false);
    }
  });

  it("escapes raw [ at any position inside a class, including first member", () => {
    expect(sanitizePatternForDeepSeek("^[a-z[]]{1,200}$")).toEqual({
      pattern: "^[a-z\\[]]{1,200}$",
      changed: true,
    });
    expect(sanitizePatternForDeepSeek("^[[a-z]{1,200}$")).toEqual({
      pattern: "^[\\[a-z]{1,200}$",
      changed: true,
    });
    // Escaped \] stays a member; a class-close `]` is never rewritten.
    expect(sanitizePatternForDeepSeek("^[a\\]x]$")).toEqual({
      pattern: "^[a\\]x]$",
      changed: false,
    });
  });
});

describe("sanitizeToolSchemaForDeepSeek", () => {
  it("sanitizes nested properties and array items at any depth", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string", pattern: ARTIFACT_PATTERN },
        meta: {
          type: "object",
          properties: {
            field: { type: "string", pattern: ARTIFACT_PATTERN },
            tags: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string", pattern: ARTIFACT_PATTERN } } },
            },
          },
        },
      },
      required: ["title"],
    };
    const result = sanitizeToolSchemaForDeepSeek(schema);
    expect(result.changedPatterns).toHaveLength(3);
    const out = result.schema as typeof schema & { properties: Record<string, any> };
    expect(out.properties.title.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
    expect(out.properties.meta.properties.field.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
    expect(out.properties.meta.properties.tags.items.properties.id.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
    // Everything else is preserved: type, description, enums, structure.
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["title"]);
  });

  it("preserves enums, descriptions, required status and structure", () => {
    const schema = {
      type: "object",
      description: "kept",
      properties: {
        kind: { type: "string", enum: ["a", "b"], description: "kept" },
        count: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["kind"],
      additionalProperties: false,
    };
    const result = sanitizeToolSchemaForDeepSeek(schema);
    expect(result.changedPatterns).toHaveLength(0);
    expect(result.schema).toEqual(schema);
  });

  it("does not mutate the input schema object", () => {
    const schema = {
      type: "object",
      properties: { title: { type: "string", pattern: ARTIFACT_PATTERN } },
    };
    freezeDeep(schema);
    const before = JSON.stringify(schema);
    const result = sanitizeToolSchemaForDeepSeek(schema);
    expect(JSON.stringify(schema)).toBe(before);
    expect(result.schema).not.toBe(schema);
    expect(result.changedPatterns).toHaveLength(1);
  });
});

describe("sanitizeToolsForProvider", () => {
  const tools = [
    {
      name: "Artifact",
      description: "test",
      input_schema: {
        type: "object",
        properties: { field: { type: "string", pattern: ARTIFACT_PATTERN } },
      },
    },
  ];

  it("returns non-DeepSeek tool arrays untouched (same reference)", () => {
    for (const providerId of ["claude", "openai", "codex", "ox-alpha"]) {
      expect(sanitizeToolsForProvider(tools, providerId)).toBe(tools);
    }
  });

  it("sanitizes only the provider-bound DeepSeek copy", () => {
    const before = JSON.stringify(tools);
    const out = sanitizeToolsForProvider(tools, "deepseek");
    expect(JSON.stringify(tools)).toBe(before); // original untouched
    expect(out).not.toBe(tools);
    const schema = (out[0] as { input_schema: { properties: { field: { pattern: string } } } }).input_schema;
    expect(schema.properties.field.pattern).toBe(ARTIFACT_PATTERN_SANITIZED);
  });
});
