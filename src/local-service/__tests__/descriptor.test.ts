import { describe, expect, it } from "vitest";
import { resolveLocalServiceDescriptor } from "../descriptor.js";
import { localOrnith15Manifest } from "../../providers/presets.js";
import { manifestToProfile } from "../../providers/manifest.js";
import type { ProviderProfile } from "../../providers/types.js";

describe("resolveLocalServiceDescriptor", () => {
  it("resolves the bundled Ornith provider to the exact spawn command and endpoint", () => {
    const profile = manifestToProfile(localOrnith15Manifest);
    const d = resolveLocalServiceDescriptor(profile)!;
    expect(d).toEqual({
      providerId: "local-ornith15",
      command: "/Users/home/.venvs/ornith15/bin/python",
      args: [
        "-m",
        "mlx_lm",
        "server",
        "--model",
        "/Users/home/Models/Coding/Ornith-1.5-35B-A3B-REAP192-mxfp4-MLX",
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
      ],
      host: "127.0.0.1",
      port: 8080,
      healthPath: "/v1/models",
      startupTimeoutSec: 300,
      model: "/Users/home/Models/Coding/Ornith-1.5-35B-A3B-REAP192-mxfp4-MLX",
    });
  });

  it("derives host/port/health path from baseUrl when the block omits them", () => {
    const profile: ProviderProfile = {
      ...manifestToProfile(localOrnith15Manifest),
      baseUrl: "http://127.0.0.1:9999/v1",
      localService: {
        command: "server",
        args: ["--listen", "${host}:${port}", "--model", "${model}"],
        model: "m-1",
      },
      models: { default: "unused", aliases: {} },
    };
    const d = resolveLocalServiceDescriptor(profile)!;
    expect(d.host).toBe("127.0.0.1");
    expect(d.port).toBe(9999);
    expect(d.healthPath).toBe("/v1/models");
    expect(d.args).toEqual(["--listen", "127.0.0.1:9999", "--model", "m-1"]);
    expect(d.startupTimeoutSec).toBe(120);
  });

  it("returns undefined for a provider with no localService block", () => {
    const profile = manifestToProfile(localOrnith15Manifest);
    expect(resolveLocalServiceDescriptor({ ...profile, localService: undefined })).toBeUndefined();
  });
});
