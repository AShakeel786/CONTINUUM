/**
 * Agent-management errors — surfaced by both the interactive menu and the
 * domain layer. Distinct from `providers/errors` (registry identity) because
 * these describe *configuration* problems, not unknown providers.
 */

export class AgentValidationError extends Error {
  readonly providerId: string;
  constructor(providerId: string, detail: string) {
    super(`Cannot add/configure agent "${providerId}": ${detail}`);
    this.name = "AgentValidationError";
    this.providerId = providerId;
  }
}
