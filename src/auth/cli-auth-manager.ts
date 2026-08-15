/**
 * Registry + orchestration over `CliAuthAdapter`s — the same shape as
 * Phase 3's `ProviderRegistry`, keyed by the identical `providerId` strings
 * so the two compose without duplicating provider identity logic anywhere.
 */

import { UnknownProviderError } from "../providers/errors.js";
import type { CliAuthAdapter, CliAuthStatus, CliInstalledStatus, CliLoginResult } from "./types.js";

export class CliAuthManager {
  private readonly adapters = new Map<string, CliAuthAdapter>();

  register(adapter: CliAuthAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  has(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  get(providerId: string): CliAuthAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new UnknownProviderError(providerId, [...this.adapters.keys()]);
    return adapter;
  }

  listIds(): readonly string[] {
    return [...this.adapters.keys()];
  }

  async checkInstalled(providerId: string): Promise<CliInstalledStatus> {
    return this.get(providerId).detectInstalled();
  }

  async checkAuthenticated(providerId: string): Promise<CliAuthStatus> {
    return this.get(providerId).detectAuthenticated();
  }

  async login(providerId: string): Promise<CliLoginResult> {
    return this.get(providerId).login();
  }

  async logout(providerId: string): Promise<CliLoginResult | undefined> {
    return this.get(providerId).logout();
  }
}
