/**
 * Codex provider profile — derived from the bundled `codexManifest` preset.
 * Native Codex CLI launch; cli-session auth (CONTINUUM holds no OAuth token).
 */

import { manifestToProfile } from "../manifest.js";
import { codexManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const codexProfile: ProviderProfile = manifestToProfile(codexManifest);
