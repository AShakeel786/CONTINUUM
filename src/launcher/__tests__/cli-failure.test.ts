import { describe, expect, it } from "vitest";
import { classifyCliFailure } from "../cli-failure.js";

describe("classifyCliFailure", () => {
  it("classifies rate-limit errors (429 / rate limit / too many requests)", () => {
    for (const stderr of [
      "API Error: Request rejected (429) · Provider returned error",
      "openrouter.ai:443 rate-limited the request",
      "HTTP 429 Too Many Requests",
      "quota exceeded for model",
    ]) {
      const c = classifyCliFailure(1, stderr);
      expect(c.kind).toBe("rate-limit");
      expect(c.fallbackEligible).toBe(true);
    }
  });

  it("classifies upstream-provider failures", () => {
    for (const stderr of [
      "API Error: Provider returned error",
      "model is temporarily saturated upstream",
      "provider overloaded, try again",
      "API Error: 502 Bad Gateway",
      "upstream connect error",
    ]) {
      expect(classifyCliFailure(1, stderr).kind).toBe("upstream-provider");
    }
  });

  it("classifies network/service failures", () => {
    for (const stderr of [
      "fetch failed: ECONNRESET",
      "Error: connect ETIMEDOUT 1.2.3.4:443",
      "socket hang up",
      "network request failed",
    ]) {
      expect(classifyCliFailure(1, stderr).fallbackEligible).toBe(true);
    }
  });

  it("classifies auth failures as eligible (matching API-agent semantics)", () => {
    const c = classifyCliFailure(1, "Error: invalid api key provided");
    expect(c.kind).toBe("auth");
    expect(c.fallbackEligible).toBe(true);
  });

  it("never falls back on user interrupts and signal exits", () => {
    for (const [code, stderr] of [[130, ""], [143, "API Error (429)"], [null, "anything"]] as const) {
      const c = classifyCliFailure(code, stderr);
      expect(c.kind).toBe("local");
      expect(c.fallbackEligible).toBe(false);
    }
    expect(classifyCliFailure(1, "Interrupted by user").fallbackEligible).toBe(false);
  });

  it("never falls back on ordinary task/local failures", () => {
    for (const stderr of [
      "✗ Tests failed: 3 failing, 12 passing",
      "bash: nosuchcommand: command not found",
      "Error: ENOENT: no such file or directory, open '/work/src/app.ts'",
      "Permission denied: /etc/hosts",
      // git's ordinary use of the word "upstream" must not look provider-side
      "fatal: unable to push to upstream branch of 'origin'",
      "",
    ]) {
      const c = classifyCliFailure(1, stderr);
      expect(c.kind).toBe("local");
      expect(c.fallbackEligible).toBe(false);
    }
  });

  it("requires positive evidence — unmatched nonzero exits are local", () => {
    expect(classifyCliFailure(1, "something completely unrelated happened").fallbackEligible).toBe(false);
    expect(classifyCliFailure(1, undefined).fallbackEligible).toBe(false);
  });

  it("does not false-positive on numbers in ordinary output", () => {
    expect(classifyCliFailure(1, "report generated with 429 lines and 500 tables").kind).toBe("local");
  });
});
