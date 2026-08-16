/**
 * DeepSeek provider profile — derived from the bundled `deepseekManifest`
 * preset. Direct calls use DeepSeek's OpenAI-compatible API; CLI sessions are
 * proxy-routed through the Tencent MemoryProxy (Claude Code semantics).
 */

import { manifestToProfile } from "../manifest.js";
import { deepseekManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const deepseekProfile: ProviderProfile = manifestToProfile(deepseekManifest);
