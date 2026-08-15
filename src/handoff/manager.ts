/**
 * HandoffManager — orchestrates the flow from the brief:
 *
 *   Agent A → flush session → create HandoffPackage → choose receiving
 *   provider → validate capability/availability → render receiving-agent
 *   context → Agent B resumes
 *
 * The "choose receiving provider" step is a real, separate, two-call API
 * (`listAvailableReceivingProviders` then `finalizeHandoff(..., chosenId)`)
 * specifically so nothing in this class can pick a provider on its own —
 * `finalizeHandoff` has no default for `chosenProviderId`, and there is no
 * "auto" mode. A caller (a human, via whatever surface asks them) must
 * supply it explicitly every time.
 */

import { renderContextForProvider } from "../rendering/render.js";
import type { RenderedContext } from "../rendering/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ProviderCapabilities } from "../providers/types.js";
import type { SessionManager } from "../session/manager.js";
import type { GitFingerprint, ProviderRef, TaskSession } from "../session/types.js";
import type { TokenLimits } from "../token/types.js";
import { HandoffProviderUnavailableError } from "./errors.js";
import { flushHandoff } from "./flush.js";
import type { FlushHandoffOptions } from "./flush.js";
import type { HandoffPackage } from "./types.js";

export interface ProviderChoice {
  readonly providerId: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
}

export interface FinalizeHandoffOptions {
  readonly tokenLimits: TokenLimits;
  /** Model alias to resolve on the target provider ("default" if omitted). */
  readonly targetModelAlias?: string;
  readonly currentGit?: GitFingerprint;
  readonly memoryCore?: FlushHandoffOptions["memoryCore"];
}

export interface HandoffResult {
  readonly handoffPackage: HandoffPackage;
  readonly rendered: RenderedContext;
  readonly session: TaskSession;
}

export class HandoffManager {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly providerRegistry: ProviderRegistry,
  ) {}

  /**
   * Every registered provider, with its capabilities, so a caller can
   * present a real choice to the user. Never filters down to "the one
   * recommended provider" — that would reintroduce silent selection by
   * another name.
   */
  listAvailableReceivingProviders(): readonly ProviderChoice[] {
    return this.providerRegistry.listProfiles().map((p) => ({
      providerId: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    }));
  }

  /** Loads the session and the current provider choices together — the shape a "pick who takes over" prompt needs in one call. */
  async prepareHandoff(sessionId: string): Promise<{ session: TaskSession; availableProviders: readonly ProviderChoice[] }> {
    const session = await this.sessionManager.loadSession(sessionId);
    return { session, availableProviders: this.listAvailableReceivingProviders() };
  }

  /**
   * Finalizes a handoff to an explicitly-chosen provider. Validates the
   * provider is registered (ProviderRegistry.get throws UnknownProviderError
   * otherwise) and capable of receiving a CLI handoff (cliAvailable), flushes
   * the session into a token-budgeted HandoffPackage, renders it for the
   * target provider, then records the transition on the session. If
   * anything before the final session update throws, the session is left
   * completely untouched — no partial handoff state.
   */
  async finalizeHandoff(sessionId: string, chosenProviderId: string, opts: FinalizeHandoffOptions): Promise<HandoffResult> {
    const targetAdapter = this.providerRegistry.get(chosenProviderId); // throws UnknownProviderError if unregistered
    const capabilities = targetAdapter.getCapabilities();
    if (!capabilities.cliAvailable) {
      throw new HandoffProviderUnavailableError(chosenProviderId, "no CLI integration available (cliAvailable=false)");
    }

    const session = await this.sessionManager.loadSession(sessionId);
    const sourceProvider = session.activeProvider;
    const targetProvider: ProviderRef = {
      providerId: chosenProviderId,
      model: targetAdapter.resolveModel(opts.targetModelAlias),
    };

    const handoffPackage = await flushHandoff(session, {
      sourceProvider,
      targetProvider,
      currentGit: opts.currentGit,
      tokenLimits: opts.tokenLimits,
      memoryCore: opts.memoryCore,
    });

    const rendered = renderContextForProvider(handoffPackage.contextEnvelope, targetAdapter);

    // Only touch session state once the package is fully built and rendered
    // -- an error anywhere above leaves the session exactly as it was.
    await this.sessionManager.setActiveProvider(sessionId, targetProvider);
    const updatedSession = await this.sessionManager.recordHandoff(sessionId, {
      handoffId: handoffPackage.handoffId,
      fromProvider: sourceProvider,
      toProvider: targetProvider,
      at: handoffPackage.createdAt,
    });

    return { handoffPackage, rendered, session: updatedSession };
  }
}
