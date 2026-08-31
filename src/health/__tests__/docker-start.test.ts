/**
 * Docker Desktop engine-prerequisite probe (health/repair.ts) — the fast-fail
 * for the exact Windows root cause behind "Docker Desktop starts but the
 * daemon never comes up": the Linux engine runs in WSL2, which needs CPU
 * virtualization. `wsl --status` names the missing prerequisite (UTF-16LE, so
 * NUL bytes must be stripped before matching). Non-Windows and ambiguous
 * results must stay ok — a healthy machine never gets a false failure.
 */
import { describe, expect, it } from "vitest";
import { defaultEnginePrerequisiteProbe } from "../repair.js";
import type { HealthRuntime } from "../types.js";

function runtimeReturning(stdout: string, stderr = ""): HealthRuntime {
  return {
    now: () => 0,
    run: async () => ({ code: 0, stdout, stderr }),
    start: async () => ({ ok: true }),
    fetch: async () => ({ ok: false, status: 0 }),
    sleep: async () => {},
  };
}

describe("defaultEnginePrerequisiteProbe", () => {
  it("is a no-op (ok) on non-Windows platforms", async () => {
    const r = runtimeReturning("virtualization is not enabled");
    expect(await defaultEnginePrerequisiteProbe(r, "darwin")).toEqual({ ok: true, detail: "" });
    expect(await defaultEnginePrerequisiteProbe(r, "linux")).toEqual({ ok: true, detail: "" });
  });

  it("reports the virtualization prerequisite when wsl --status names it (stripping UTF-16 NULs)", async () => {
    const r = runtimeReturning("w\0s\0l\0 ... virtualization is not enabled on this machine ...\0");
    const res = await defaultEnginePrerequisiteProbe(r, "win32");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/virtualization/i);
    expect(res.detail).toMatch(/wsl2 cannot start/i);
  });

  it("reports the WSL2 failure phrasing too", async () => {
    const r = runtimeReturning("WSL2 is unable to start since virtualization is not enabled");
    const res = await defaultEnginePrerequisiteProbe(r, "win32");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/wsl2 cannot start/i);
  });

  it("reports ok when the prerequisite appears satisfied", async () => {
    const r = runtimeReturning("Default Version: 2\nVirtualization: enabled");
    expect(await defaultEnginePrerequisiteProbe(r, "win32")).toEqual({ ok: true, detail: "" });
  });
});
