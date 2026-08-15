/**
 * PricingAwarenessService — ties the calculator, notification dedupe logic,
 * and Session State together. This is the one entry point a caller (a CLI
 * loop, a future launcher, a test) actually uses; `calculator.ts`/
 * `notifications.ts` stay pure and framework-free underneath it.
 */

import { getCurrentTier, getNextTransition } from "./calculator.js";
import { describeTransition } from "./format.js";
import { computeNotificationEvents } from "./notifications.js";
import { DEFAULT_NOTIFICATION_CONFIG } from "./types.js";
import type { NotificationConfig, PricingNotificationEvent, ProviderPricingSchedule, SessionPricingState } from "./types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { TaskSession } from "../session/types.js";

export interface PricingCheckResult {
  readonly session: TaskSession;
  readonly events: readonly PricingNotificationEvent[];
}

export class PricingAwarenessService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly providerRegistry: ProviderRegistry,
    private readonly schedules: ReadonlyMap<string, ProviderPricingSchedule>,
    private readonly config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
  ) {}

  private displayNameFor(providerId: string): string {
    return this.providerRegistry.has(providerId) ? this.providerRegistry.get(providerId).profile.displayName : providerId;
  }

  hasSchedule(providerId: string): boolean {
    return this.schedules.has(providerId);
  }

  /**
   * Loads the session, checks its active provider's pricing schedule (if
   * any), computes any notification events that should fire right now, and
   * persists the updated pricing/notification state — so a second call at
   * the same or a later moment (including after a restart, since this
   * reads persisted state via `sessionManager`) never re-fires an event
   * that already fired. Providers with no pricing schedule are a no-op,
   * not an error.
   */
  async check(sessionId: string, now: Date = new Date()): Promise<PricingCheckResult> {
    const session = await this.sessionManager.loadSession(sessionId);
    const providerId = session.activeProvider.providerId;
    const schedule = this.schedules.get(providerId);
    if (!schedule) return { session, events: [] };

    const priorRecord =
      session.pricingAwareness && session.pricingAwareness.providerId === providerId
        ? session.pricingAwareness.pendingNotification
        : undefined;

    const displayName = this.displayNameFor(providerId);
    const currentTier = getCurrentTier(schedule, now);
    const nextTransition = getNextTransition(schedule, now);
    const { events, updatedRecord } = computeNotificationEvents({
      schedule,
      providerDisplayName: displayName,
      now,
      config: this.config,
      priorRecord,
    });

    const newState: SessionPricingState = {
      providerId,
      currentTier,
      lastCheckedAt: now.toISOString(),
      nextTransition: nextTransition ? { at: nextTransition.at.toISOString(), toTier: nextTransition.toTier } : undefined,
      pendingNotification: updatedRecord,
    };

    const updatedSession = await this.sessionManager.updatePricingAwareness(sessionId, newState);
    return { session: updatedSession, events };
  }

  /** Human-readable diagnostics line for the session's current pricing-window state, e.g. for a status display. */
  diagnostics(session: TaskSession, now: Date = new Date(), timeZone?: string): string | undefined {
    const state = session.pricingAwareness;
    if (!state) return undefined;
    const displayName = this.displayNameFor(state.providerId);
    const base = `${displayName}: currently ${state.currentTier}`;
    if (!state.nextTransition) return `${base} (no scheduled transitions)`;
    const transition = { at: new Date(state.nextTransition.at), toTier: state.nextTransition.toTier };
    return `${base}; next transition ${describeTransition(transition, now, timeZone)}`;
  }
}
