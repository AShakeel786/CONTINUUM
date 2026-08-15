/**
 * SessionManager — explicit, per-field state-capture APIs (brief: "State
 * must update during work, not only at session end"). Every method is
 * load → mutate one field → save-with-optimistic-concurrency → return the
 * new session. There is no single big "setState()" — each call names
 * exactly what changed, which is also what makes `recentToolActivity`
 * meaningfully incremental rather than a periodic dump.
 */

import { randomUUID } from "node:crypto";
import type { FileSessionStore } from "./store.js";
import type {
  CreateSessionInput,
  DecisionRecord,
  FileRef,
  GitFingerprint,
  HandoffMetadata,
  ProviderRef,
  SessionStatus,
  TaskSession,
  ToolActivityRecord,
  WorkItem,
} from "./types.js";
import { SESSION_SCHEMA_VERSION } from "./types.js";
import type { ContextEnvelope } from "../context/types.js";
import type { SessionPricingState } from "../pricing/types.js";

const MAX_TOOL_ACTIVITY = 20;

function now(): string {
  return new Date().toISOString();
}

export class SessionManager {
  constructor(private readonly store: FileSessionStore) {}

  async createSession(input: CreateSessionInput): Promise<TaskSession> {
    if (await this.store.exists(input.sessionId)) {
      throw new Error(`Session "${input.sessionId}" already exists — use loadSession() or a new sessionId.`);
    }
    const timestamp = now();
    const session: TaskSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: input.sessionId,
      revision: 1,
      projectId: input.projectId,
      workingDirectory: input.workingDirectory,
      activeProvider: input.activeProvider,
      taskGoal: input.taskGoal,
      status: "active",
      completedWork: [],
      remainingWork: [],
      importantDecisions: [],
      relevantFiles: [],
      recentToolActivity: [],
      git: input.git,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.save(session);
    return session;
  }

  async loadSession(sessionId: string): Promise<TaskSession> {
    return this.store.load(sessionId);
  }

  /** All session ids on disk (no ordering guarantee — sort by `updatedAt` yourself). */
  async listSessionIds(): Promise<string[]> {
    return this.store.listSessionIds();
  }

  /** Permanently remove a session (used by archive/cleanup). */
  async deleteSession(sessionId: string): Promise<void> {
    return this.store.delete(sessionId);
  }

  private async update(sessionId: string, mutate: (session: TaskSession) => TaskSession): Promise<TaskSession> {
    const current = await this.store.load(sessionId);
    const next: TaskSession = { ...mutate(current), revision: current.revision + 1, updatedAt: now() };
    await this.store.save(next, { expectedRevision: current.revision });
    return next;
  }

  async updateTaskGoal(sessionId: string, taskGoal: string): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, taskGoal }));
  }

  async setStatus(sessionId: string, status: SessionStatus): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, status }));
  }

  async setActiveProvider(sessionId: string, provider: ProviderRef): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, activeProvider: provider }));
  }

  async addCompletedWork(sessionId: string, description: string): Promise<TaskSession> {
    const item: WorkItem = { id: randomUUID(), description, recordedAt: now() };
    return this.update(sessionId, (s) => ({ ...s, completedWork: [...s.completedWork, item] }));
  }

  async addRemainingWork(sessionId: string, description: string): Promise<TaskSession> {
    const item: WorkItem = { id: randomUUID(), description, recordedAt: now() };
    return this.update(sessionId, (s) => ({ ...s, remainingWork: [...s.remainingWork, item] }));
  }

  /** Moves a remaining-work item to completed-work — the common "I finished the next thing" transition. */
  async completeWorkItem(sessionId: string, workItemId: string, completionNote?: string): Promise<TaskSession> {
    return this.update(sessionId, (s) => {
      const item = s.remainingWork.find((w) => w.id === workItemId);
      if (!item) return s;
      const completed: WorkItem = {
        id: randomUUID(),
        description: completionNote ?? item.description,
        recordedAt: now(),
      };
      return {
        ...s,
        remainingWork: s.remainingWork.filter((w) => w.id !== workItemId),
        completedWork: [...s.completedWork, completed],
      };
    });
  }

  async recordDecision(sessionId: string, decision: string, rationale?: string): Promise<TaskSession> {
    const record: DecisionRecord = { id: randomUUID(), decision, rationale, recordedAt: now() };
    return this.update(sessionId, (s) => ({ ...s, importantDecisions: [...s.importantDecisions, record] }));
  }

  async recordRelevantFile(sessionId: string, filePath: string, note?: string): Promise<TaskSession> {
    const record: FileRef = { path: filePath, note, recordedAt: now() };
    return this.update(sessionId, (s) => ({
      ...s,
      // De-dupe by path: a re-note of the same file replaces, doesn't accumulate.
      relevantFiles: [...s.relevantFiles.filter((f) => f.path !== filePath), record],
    }));
  }

  /** Bounded ring buffer — only the most recent MAX_TOOL_ACTIVITY entries are kept. */
  async recordToolActivity(sessionId: string, tool: string, summary: string): Promise<TaskSession> {
    const record: ToolActivityRecord = { id: randomUUID(), tool, summary, recordedAt: now() };
    return this.update(sessionId, (s) => ({
      ...s,
      recentToolActivity: [...s.recentToolActivity, record].slice(-MAX_TOOL_ACTIVITY),
    }));
  }

  async updateContextEnvelopeSnapshot(sessionId: string, envelope: ContextEnvelope): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, contextEnvelope: envelope }));
  }

  async updateGitFingerprint(sessionId: string, git: GitFingerprint): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, git }));
  }

  async updateCacheMetadata(sessionId: string, stablePrefixHash: string): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, cacheMetadata: { stablePrefixHash, checkedAt: now() } }));
  }

  /** Records that a handoff completed, for audit/history — does not itself change activeProvider (call setActiveProvider separately). */
  async recordHandoff(sessionId: string, handoff: HandoffMetadata): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, lastHandoff: handoff }));
  }

  async updatePricingAwareness(sessionId: string, pricingAwareness: SessionPricingState): Promise<TaskSession> {
    return this.update(sessionId, (s) => ({ ...s, pricingAwareness }));
  }
}
