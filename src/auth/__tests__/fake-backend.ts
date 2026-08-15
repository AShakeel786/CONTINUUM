/**
 * In-memory CredentialBackend for tests — deterministic, no OS keychain or
 * filesystem. Records every set/delete for no-secret-leak assertions.
 */

import type { CredentialBackend } from "../types.js";

export class FakeBackend implements CredentialBackend {
  readonly id = "fake";
  readonly securityLevel = "os-native" as const;
  readonly description = "in-memory test backend";
  private readonly store = new Map<string, string>();
  readonly setLog: string[] = [];
  readonly deleteLog: string[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    this.setLog.push(key);
  }
  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.deleteLog.push(key);
  }
  async list(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }
  /** Test helper — peek a stored value to assert the right thing was stored. */
  peek(key: string): string | undefined {
    return this.store.get(key);
  }
}
