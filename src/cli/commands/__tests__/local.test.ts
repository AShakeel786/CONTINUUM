import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalCommand } from "../local.js";
import type { CliIo } from "../../index.js";

function collect(): { io: CliIo; text: () => string } {
  const lines: string[] = [];
  return { io: { out: (s: string) => { lines.push(s); } }, text: () => lines.join("") };
}

describe("continuum local", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cont-local-cmd-"));
    prevHome = process.env.CONTINUUM_HOME;
    process.env.CONTINUUM_HOME = home;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevHome === undefined) delete process.env.CONTINUUM_HOME;
    else process.env.CONTINUUM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("prints usage for a bare / unknown subcommand", async () => {
    const a = collect();
    expect(await runLocalCommand([], a.io)).toBe(0);
    expect(a.text()).toContain("Usage: continuum local");
    const b = collect();
    expect(await runLocalCommand(["frobnicate"], b.io)).toBe(2);
  });

  it("status reports the managed Ornith endpoint as stopped when nothing is listening", async () => {
    vi.stubGlobal("fetch", async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); });
    const c = collect();
    const code = await runLocalCommand(["status"], c.io);
    expect(code).toBe(1);
    const out = c.text();
    expect(out).toContain("local-ornith15");
    expect(out).toContain("[stopped]");
    expect(out).toContain("http://127.0.0.1:8080/v1/models");
  });

  it("status recognises a healthy foreign endpoint (not CONTINUUM-owned)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ object: "list", data: [] }) }));
    const c = collect();
    const code = await runLocalCommand(["status", "local-ornith15"], c.io);
    expect(code).toBe(0);
    expect(c.text()).toContain("[running-foreign]");
  });

  it("stop leaves an unowned occupant untouched", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }));
    const c = collect();
    const code = await runLocalCommand(["stop"], c.io);
    expect(code).toBe(0);
    expect(c.text().toLowerCase()).toContain("left untouched");
  });

  it("resolves the retired local-qwen38 alias to the managed provider", async () => {
    vi.stubGlobal("fetch", async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); });
    const c = collect();
    const code = await runLocalCommand(["status", "local-qwen38"], c.io);
    expect(code).toBe(1);
    expect(c.text()).toContain("local-ornith15");
  });
});
