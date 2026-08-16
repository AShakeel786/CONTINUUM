// Deterministic Tool Result Cache benchmark — hit rate + calls avoided for repeated
// identical read-only tool calls. Run: node scripts/tool-cache-benchmark.mjs
import { ToolResultCache, computeCacheKey } from "../dist/tool-cache/tool-cache.js";
import { ToolRegistry, textResult } from "../dist/mcp/tools.js";
import { estimateTokens } from "../dist/token/tokenizer.js";
import { makeScopeProvider } from "../dist/tool-cache/scope.js";
import { SessionManager } from "../dist/session/manager.js";
import { FileSessionStore } from "../dist/session/store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";

const payload = JSON.stringify([...Array(20)].map((_, i) => ({ name: `project-${i}`, path: `/work/project-${i}`, aliases: [`p${i}`], defaultProvider: "claude" })));
const tokensPer = estimateTokens(payload).tokens;

const tools = new ToolRegistry();
const counters = { project_list: 0, session_state: 0, memory_search: 0 };
tools.register({ definition: { name: "project_list", description: "", inputSchema: { type: "object" }, access: "read", cacheScope: "project" }, handler: async () => { counters.project_list++; return textResult(payload); } });
tools.register({ definition: { name: "session_state", description: "", inputSchema: { type: "object", properties: { sessionId: { type: "string" } } }, access: "read", cacheScope: "session" }, handler: async () => { counters.session_state++; return textResult(payload); } });
tools.register({ definition: { name: "memory_search", description: "", inputSchema: { type: "object", properties: { query: { type: "string" } } }, access: "read" }, handler: async () => { counters.memory_search++; return textResult(payload); } });

const sessionManager = new SessionManager(new FileSessionStore(mkdtempSync(join(tmpdir(), "cache-bench-"))));
await sessionManager.createSession({ sessionId: "s1", projectId: "p1", workingDirectory: "/w", activeProvider: { providerId: "claude", model: "m" }, taskGoal: "g" });
const scope = makeScopeProvider({ projectPath: cwd(), sessionManager });
const cache = new ToolResultCache();
const N = 100;

async function callOnce(name, args, scopeName) {
  const fp = scopeName === "global" ? "global" : scopeName === "project" ? await scope.projectFingerprint() : scopeName === "session" ? await scope.sessionFingerprint(args.sessionId) : undefined;
  const key = computeCacheKey(name, JSON.stringify(args), scopeName, fp);
  if (key !== undefined && cache.get(key) !== undefined) return true; // hit
  const res = await tools.call(name, args);
  if (key !== undefined) cache.set(key, res.content.map(c => c.text).join("\n"), tokensPer);
  return false; // miss
}

console.log("Tool Result Cache benchmark (100 identical calls each)");
console.log("======================================================");
for (const [name, args, scopeName] of [
  ["project_list", {}, "project"],
  ["session_state", { sessionId: "s1" }, "session"],
  ["memory_search", { query: "x" }, undefined],
]) {
  let hits = 0;
  for (let i = 0; i < N; i++) if (await callOnce(name, args, scopeName)) hits++;
  const calls = counters[name];
  const avoided = N - calls;
  console.log(`${name.padEnd(18)} hit-rate=${((hits / N) * 100).toFixed(0).padStart(3)}%  handler-calls=${calls}  calls-avoided=${avoided}  tokens-avoided~=${avoided * tokensPer}`);
}
