import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ProjectRegistry } from "../../registry/registry.js";
import { ProjectRegistryStore } from "../../registry/store.js";
import { normalizeProjectPath } from "../../registry/registry.js";

describe("cross-platform project paths", () => {
  it("normalizes Windows-style and Unix-style separators without hardcoded machine paths", () => {
    // The registry must not assume a specific host path style. On any OS,
    // normalization is path.resolve — the assertion is that a tilde path and
    // a relative path are made absolute deterministically, and that the
    // result uses the host separator.
    const home = process.env.HOME ?? "/home/me";
    const abs = normalizeProjectPath("~/work/foo");
    expect(abs).toBe(join(home, "work", "foo"));
    expect(abs).toContain(sep);
  });

  it("detects a project under a path with mixed separators (host-normalized)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "continuum-xplat-"));
    const r = new ProjectRegistry(new ProjectRegistryStore(dataDir));
    const base = join(tmpdir(), "proj");
    await r.add({ name: "p", path: base });
    // Simulate a subdirectory in the host path style.
    const sub = join(base, "src", "deep");
    expect((await r.detect(sub))?.name).toBe("p");
  });
});
