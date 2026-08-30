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
  /** Legacy provider ids → their current canonical id (e.g. "ox-alpha" → "glm-5-2-free"). */
  private readonly aliases = new Map<string, string>();

  /** Register a provider adapter. Throws if the id is already registered. */
  register(adapter: ProviderAdapter): void {
    const id = adapter.profile.id;
    if (this.adapters.has(id)) {
      throw new DuplicateProviderError(id);
    }
    this.adapters.set(id, adapter);
    for (const alias of adapter.profile.idAliases ?? []) {
      this.aliases.set(alias, id);
    }
  }

  private resolve(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /** Look up a provider adapter by id (legacy aliases resolve to the current provider). Throws UnknownProviderError if not found. */
  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(this.resolve(id));
    if (!adapter) {
      throw new UnknownProviderError(id, this.listIds());
    }
    return adapter;
  }

  /** True if a provider id (or a legacy alias of one) is registered, without throwing. */
  has(id: string): boolean {
    return this.adapters.has(this.resolve(id));
  }

  /**
   * The current canonical id for a possibly-legacy id: an alias maps to its
   * registered provider, anything else (including an unregistered id) is
   * returned unchanged. `undefined` passes through, so persisted state that
   * carries no provider id at all never trips the alias map.
   */
  canonicalId(id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    const canonical = this.resolve(id);
    return this.adapters.has(canonical) ? canonical : id;
  }

  /** All registered provider ids, in registration order (canonical ids only, never aliases). */
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
