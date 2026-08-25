/**
 * Ox Alpha Free (OpenCode Go) provider profile — derived from the bundled
 * `oxAlphaManifest` preset. Direct-API only: CONTINUUM's api-agent runtime
 * calls the OpenAI-compatible Zen Go endpoint with a bearer API key stored
 * in the OS credential store. Limited-time free promo (see profile.promo).
 */

import { manifestToProfile } from "../manifest.js";
import { oxAlphaManifest } from "../presets.js";
import type { ProviderProfile } from "../types.js";

export const oxalphaProfile: ProviderProfile = manifestToProfile(oxAlphaManifest);
