/**
 * DeepSeek auth metadata — API-only, derived from the bundled `deepseekManifest`.
 */

import type { ProviderAuthMetadata } from "../types.js";
import { manifestToAuthMetadata } from "../../providers/manifest.js";
import { deepseekManifest } from "../../providers/presets.js";

export const deepseekAuthMetadata: ProviderAuthMetadata = manifestToAuthMetadata(deepseekManifest);
