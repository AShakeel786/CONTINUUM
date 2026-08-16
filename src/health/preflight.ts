/**
 * Launcher preflight — warn, never block.
 *
 * Maps a runtime health report into warning lines shown before a launch.
 * The launcher itself already degrades gracefully when MemoryCore is
 * unreachable (see Launcher.prepareLaunch's memoryCoreNote); this module
 * only makes the *why* visible up front instead of after the fact.
 */
import type { HealthReport } from "./types.js";

export function buildPreflightWarnings(report: HealthReport): readonly string[] {
  const lines: string[] = [];
  const byName = new Map(report.checks.map((c) => [c.name, c]));

  const docker = byName.get("docker");
  if (docker && docker.status === "down") {
    lines.push("Docker daemon unavailable — Tencent stack offline; memory features will degrade. Run `continuum doctor --repair` to recover.");
  }

  const core = byName.get("gateway:memory-core");
  if (core && core.status === "down") {
    lines.push("MemoryCore gateway unreachable — launching with local session context only (no Tencent memory).");
  }
  if (core && core.status === "skipped") {
    lines.push("MemoryCore not configured (CONTINUUM_MEMORY_CORE_URL unset) — launching with local session context only.");
  }

  const proxy = byName.get("gateway:proxy");
  if (proxy && proxy.status === "down") {
    lines.push("MemoryProxy unreachable — provider traffic may not be routed through the Tencent stack.");
  }

  // Functional auth path: a "healthy" proxy whose auth backend (MemoryCore) is
  // down will still surface 401/Please run /login in the provider CLI. Surface
  // the real cause before launch rather than after the first failed request.
  const proxyAuth = byName.get("proxy:auth");
  if (proxyAuth && proxyAuth.status === "down") {
    lines.push("Proxy auth backend (MemoryCore) unavailable — the provider CLI will surface 401/Please run /login. Run `continuum doctor --repair` to recover MemoryCore.");
  }

  const coreAuth = byName.get("gateway:memory-core-auth");
  if (coreAuth && coreAuth.status === "down") {
    lines.push("MemoryCore auth/verify unreachable — proxy key verification will fail. Run `continuum doctor --repair` to restart MemoryCore.");
  }

  const processes = byName.get("processes");
  if (processes && processes.status === "degraded") {
    lines.push(`${processes.detail} — run \`continuum doctor --repair\` to reap them.`);
  }

  return lines;
}
