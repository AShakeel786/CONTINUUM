import { describe, expect, it, vi } from "vitest";
import { hasHelpFlag, main } from "../index.js";

async function runHelp(command: string): Promise<string> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const code = await main(["node", "continuum", command, "--help"]);
    expect(code).toBe(0);
    return write.mock.calls.map((c) => String(c[0])).join("");
  } finally {
    write.mockRestore();
  }
}

describe("CLI --help is side-effect free", () => {
  it("detects standalone --help/-h but not a value token", () => {
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["-h"])).toBe(true);
    expect(hasHelpFlag(["launch", "--help"])).toBe(true);
    expect(hasHelpFlag([])).toBe(false);
    expect(hasHelpFlag(["launch"])).toBe(false);
    // "--help" as the VALUE of a value-flag is not a help request.
    expect(hasHelpFlag(["--task", "--help"])).toBe(false);
    expect(hasHelpFlag(["--provider", "claude", "--help"])).toBe(true);
  });

  it("launch --help prints usage and never builds a launcher", async () => {
    const text = await runHelp("launch");
    expect(text).toContain("Usage: continuum launch");
  });

  it("project --help prints usage instead of 'Unknown subcommand'", async () => {
    const text = await runHelp("project");
    expect(text).toContain("Usage: continuum project");
    expect(text).not.toContain("Unknown subcommand");
  });

  it("sessions --help prints usage instead of listing sessions", async () => {
    const text = await runHelp("sessions");
    expect(text).toContain("Usage: continuum sessions");
    // Must not list sessions (side-effect free).
    expect(text).not.toMatch(/- [0-9a-f]{8}-/);
  });

  it("handoff --help prints usage instead of erroring", async () => {
    const text = await runHelp("handoff");
    expect(text).toContain("Usage: continuum handoff");
  });

  it("resume --help prints usage", async () => {
    const text = await runHelp("resume");
    expect(text).toContain("Usage: continuum resume");
  });

  it("doctor --help prints usage", async () => {
    const text = await runHelp("doctor");
    expect(text).toContain("Usage: continuum doctor");
  });

  it("setup --help prints usage (including the memory path)", async () => {
    const text = await runHelp("setup");
    expect(text).toContain("Usage: continuum setup");
    expect(text).toContain("--memory");
  });
});
