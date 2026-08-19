import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { CostTelemetryEvent } from "./types.js";

export class CostTelemetryStore {
  readonly file: string;
  constructor(dataDir: string) { this.file = join(dataDir, "cost-telemetry.jsonl"); }
  async append(event: CostTelemetryEvent): Promise<void> { await fs.mkdir(dirname(this.file), { recursive: true }); await fs.appendFile(this.file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 }); }
  async list(sessionId?: string): Promise<CostTelemetryEvent[]> {
    let text = ""; try { text = await fs.readFile(this.file, "utf8"); } catch { return []; }
    return text.split("\n").filter(Boolean).flatMap((line) => { try { const e = JSON.parse(line) as CostTelemetryEvent; return !sessionId || e.logicalSessionId === sessionId ? [e] : []; } catch { return []; } });
  }
}
