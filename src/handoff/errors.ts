export class HandoffProviderUnavailableError extends Error {
  readonly providerId: string;
  constructor(providerId: string, reason: string) {
    super(`Provider "${providerId}" cannot receive a handoff: ${reason}`);
    this.name = "HandoffProviderUnavailableError";
    this.providerId = providerId;
  }
}

/**
 * Thrown when a caller tries to finalize a handoff without having gone
 * through provider selection first — the enforcement mechanism behind
 * "the handoff workflow must support asking the user which available
 * agent/provider should take over" / "do not silently choose the next
 * agent": there is no code path that picks a provider on its own.
 */
export class NoProviderSelectedError extends Error {
  constructor() {
    super("No receiving provider was selected. Call listAvailableReceivingProviders() and have the user choose one before finalizing a handoff.");
    this.name = "NoProviderSelectedError";
  }
}
