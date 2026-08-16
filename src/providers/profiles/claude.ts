/**
 * Claude provider profile — derived from the bundled `claudeManifest` preset
 * through the same manifest→profile converter user manifests use. Native
 * Anthropic Messages API for direct calls; native CLI launch for sessions.
 */

import { manifestToProfile } from "../manifest.js";
import { claudeManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const claudeProfile: ProviderProfile = manifestToProfile(claudeManifest);
