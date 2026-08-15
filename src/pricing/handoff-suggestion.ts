/**
 * Surfaces an *optional* handoff choice alongside a peak-pricing
 * notification — "the handoff workflow must support asking the user which
 * available agent/provider should take over," applied here to pricing
 * events specifically. This module never calls `HandoffManager.
 * finalizeHandoff` itself and never picks a provider; it only packages the
 * notification message with the same non-automatic provider-choice list
 * `HandoffManager.listAvailableReceivingProviders()` (Phase 5) already
 * exposes. The decision to stay on the current provider or hand off — and
 * to whom — remains entirely the caller's (a human's) to make.
 */

import type { HandoffManager, ProviderChoice } from "../handoff/manager.js";
import type { PricingNotificationEvent } from "./types.js";

export interface HandoffSuggestion {
  readonly message: string;
  readonly availableProviders: readonly ProviderChoice[];
}

/**
 * Returns a handoff suggestion for a peak-related pricing event
 * ("pre-peak" or "peak-started"), or `undefined` for any other event kind
 * (nothing to suggest). Calling this never mutates session or provider
 * state — it's read-only packaging of information that already exists.
 */
export function suggestHandoffOnPeakEvent(
  event: PricingNotificationEvent,
  handoffManager: HandoffManager,
): HandoffSuggestion | undefined {
  if (event.kind !== "pre-peak" && event.kind !== "peak-started") return undefined;
  return {
    message: event.message,
    availableProviders: handoffManager.listAvailableReceivingProviders(),
  };
}
