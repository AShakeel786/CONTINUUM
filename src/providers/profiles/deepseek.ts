/**
 * DeepSeek provider profile — derived from the bundled `deepseekManifest`
 * preset. Direct calls use DeepSeek's OpenAI-compatible API; CLI sessions are
 * redirected to DeepSeek's own Anthropic-compatible endpoint by default, with
 * an optional proxy-routed Tencent MemoryProxy route (`profile.proxyCliLaunch`).
 */

import { manifestToProfile } from "../manifest.js";
import { deepseekManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const deepseekProfile: ProviderProfile = manifestToProfile(deepseekManifest);
