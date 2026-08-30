/**
 * GLM 5.2 Free (OpenRouter) provider profile — derived from the bundled
 * `glm52FreeManifest` preset. Preferred harness: Claude Code redirected to
 * OpenRouter; direct-API fallback when the claude CLI is unavailable.
 */
import { glm52FreeManifest } from "../presets.js";
import { manifestToProfile } from "../manifest.js";
import type { ProviderProfile } from "../types.js";

export const glm52FreeProfile: ProviderProfile = manifestToProfile(glm52FreeManifest);
