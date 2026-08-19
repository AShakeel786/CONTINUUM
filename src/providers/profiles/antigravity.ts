/**
 * Antigravity provider profile — derived from the bundled `antigravityManifest`
 * preset. Native `agy` CLI launch; cli-session auth (CONTINUUM holds no OAuth
 * token — it reuses `agy`'s own Google login).
 */

import { manifestToProfile } from "../manifest.js";
import { antigravityManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const antigravityProfile: ProviderProfile = manifestToProfile(antigravityManifest);
