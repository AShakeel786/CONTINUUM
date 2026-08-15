/**
 * DeepSeek auth metadata — API-only. Consistent with Phase 3's finding:
 * there is no dedicated DeepSeek CLI in this system (its `cliLaunch` is
 * `proxy-routed` through the Tencent MemoryProxy, not a CLI DeepSeek itself
 * ships) — so `cli.supported` is honestly `false`, not stubbed out.
 */

import type { ProviderAuthMetadata } from "../types.js";

export const deepseekAuthMetadata: ProviderAuthMetadata = {
  providerId: "deepseek",
  api: { supported: true, envVar: "DEEPSEEK_API_KEY" },
  cli: { supported: false },
};
