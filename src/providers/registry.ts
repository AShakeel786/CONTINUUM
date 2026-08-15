/**
 * Data-driven provider registry. This is the one place CONTINUUM's runtime
 * looks up "which adapter handles provider X" — adding a new provider means
 * calling `register()` with a new adapter, not editing a switch statement
 * anywhere else in the codebase (Phase 3 requirement #1).
 */

import { DuplicateProviderError, UnknownProviderError } from "./errors.js";
import type { ProviderAdapter, ProviderCapabilities, ProviderProfile } from "./types.js";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  /** Register a provider adapter. Throws if the id is already registered. */
  register(adapter: ProviderAdapter): void {
    const id = adapter.profile.id;
    if (this.adapters.has(id)) {
      throw new DuplicateProviderError(id);
    }
    this.adapters.set(id, adapter);
  }

  /** Look up a provider adapter by id. Throws UnknownProviderError if not found. */
  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new UnknownProviderError(id, this.listIds());
    }
    return adapter;
  }

  /** True if a provider id is registered, without throwing. */
  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /** All registered provider ids, in registration order. */
  listIds(): readonly string[] {
    return [...this.adapters.keys()];
  }

  /** All registered provider profiles (safe to serialize — no secrets). */
  listProfiles(): readonly ProviderProfile[] {
    return [...this.adapters.values()].map((a) => a.profile);
  }

  /** Convenience: capabilities for a single provider, by id. */
  getCapabilities(id: string): ProviderCapabilities {
    return this.get(id).getCapabilities();
  }
}
