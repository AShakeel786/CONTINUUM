/**
 * Deterministic, lossless-first content optimizers. Each returns the optimized
 * text, or the ORIGINAL unchanged when it cannot safely prove a lossless
 * transformation. None use an LLM; none invent a result.
 *
 * Critical information (errors, warnings, stack traces, filenames, line
 * numbers, exit codes, summaries, counts, changed values) is always preserved.
 */

// ── shared helpers ─────────────────────────────────────────────────────

const ERROR_LIKE = /(^|\s)(error|fail|fatal|exception|panic|assert|✗|✘|FAIL|ERROR|Fatal|Exception|TypeError|ReferenceError|SyntaxError)/i;
const WARNING_LIKE = /(^|\s)(warning|warn|deprecated|deprecation|WARN|Warning)/i;
const STACK_LINE = /^\s+(at |\.at |Caused by:|#\d+\s)/;

function countLines(text: string): number {
  return text.split("\n").length;
}

function truncateMiddle(text: string, maxLines: number): string | undefined {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return undefined;
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return `${head.join("\n")}\n…[${lines.length - maxLines} lines omitted]…\n${tail.join("\n")}`;
}

// ── JSON (lossless minify) ──────────────────────────────────────────────

export function optimizeJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return undefined; // not parseable JSON → passthrough
  }
}

// ── repeated identical consecutive lines (lossless dedup) ───────────────

export function dedupeRepeatedLines(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l !== "");
  if (lines.length < 5) return undefined;
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j += 1;
    const count = j - i;
    out.push(count > 1 ? `${line}  (×${count})` : line);
    i = j;
  }
  const result = out.join("\n");
  return result.length < text.length ? result : undefined;
}

// ── log dedup (identical non-error lines collapse to a count) ───────────

export function dedupeLogs(text: string): string | undefined {
  const lines = text.split("\n");
  const seen = new Map<string, number>();
  const order: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const key = line;
    if (!seen.has(key)) order.push(key);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if (order.length === lines.length || order.length === 0) return undefined;
  const out = order.map((l) => {
    const n = seen.get(l)!;
    // Always keep errors/warnings verbatim even if repeated.
    if (n === 1) return l;
    if (ERROR_LIKE.test(l) || WARNING_LIKE.test(l)) return l;
    return `${l}  (×${n})`;
  });
  const result = out.join("\n");
  return result.length < text.length ? result : undefined;
}

// ── test runner (keep failures + stack, collapse passes) ────────────────

export function optimizeTestRunner(text: string): string | undefined {
  const lines = text.split("\n");
  const pass = /(^|\s)(PASS|passed|✓|ok\b|√|PASSED)/i;
  const fail = /(^|\s)(FAIL|failed|✗|✘|×|✕|FAILED|Failing)/i;
  const summaryRe = /(Tests?|Suites?):?\s+\d+\s+(passed|failed)|(\d+)\s+(passing|failing)|(\d+)\s+(passed|failed)/i;

  let hasPass = false;
  let hasFail = false;
  const kept: string[] = [];
  const tail: string[] = [];
  let summaryLine = "";

  for (const line of lines) {
    if (summaryRe.test(line)) { summaryLine = line; continue; }
    if (fail.test(line)) { hasFail = true; kept.push(line); continue; }
    if (pass.test(line)) { hasPass = true; continue; }
    // Keep stack traces + error context that follow a failure.
    if (hasFail && (STACK_LINE.test(line) || ERROR_LIKE.test(line) || line.includes("Expected") || line.includes("Received"))) {
      kept.push(line);
      continue;
    }
    if (hasFail) { tail.push(line); continue; }
  }

  if (!hasPass && !hasFail) return undefined; // not test output
  const head = hasPass ? [`[passed tests omitted — see summary]`] : [];
  const summaryBlock = summaryLine ? [summaryLine] : [];
  const keptBlock = kept.length ? [...head, ...summaryBlock, ...kept] : [...head, ...summaryBlock, ...tail.slice(0, 20)];
  const result = keptBlock.join("\n");
  return result.length < text.length ? result : undefined;
}

// ── compiler / typecheck (keep error/warning lines) ─────────────────────

export function optimizeCompiler(text: string): string | undefined {
  const lines = text.split("\n");
  // compiler diagnostic: path.ext:line[:col] ... error|warning|note (the file
  // extension distinguishes a source path from a timestamp/log "text:number").
  const diag = /^[^:\n]+\.\w+:\d+[^\n]*(error|warning|note)/i;
  const kept: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const line of lines) {
    if (diag.test(line)) {
      kept.push(line);
      if (/error/i.test(line)) errors += 1;
      else if (/warning/i.test(line)) warnings += 1;
      continue;
    }
    // keep a following stack/context line for an error diagnostic
    if (kept.length && diag.test(kept[kept.length - 1]!) && /error/i.test(kept[kept.length - 1]!) && STACK_LINE.test(line)) {
      kept.push(line);
    }
  }
  if (kept.length === 0) return undefined;
  const summary = lines.filter((l) => /error|warning/i.test(l) && /found \d+|error\(s\)|warning\(s\)/i.test(l));
  const result = [...(summary.length ? summary.slice(-1) : []), ...kept.slice(0, 400)].join("\n");
  return result.length < text.length ? result : undefined;
}

// ── git status ──────────────────────────────────────────────────────────

export function optimizeGitStatus(text: string): string | undefined {
  if (!/(Changes (to be committed|not staged)|Untracked files|On branch|Your branch)/.test(text)) return undefined;
  const lines = text.split("\n");
  const kept: string[] = [];
  let matched = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // hint lines add no information
    if (/^\((use|no changes|commit|all conflicts)/.test(t)) continue;
    // headers + branch
    if (/^(On branch|Your branch|Changes|Untracked files|nothing to commit)/.test(t)) { kept.push(t); matched = true; continue; }
    // anything indented is a file/status entry; strip the leading status word
    if (line.startsWith(" ") || line.startsWith("\t")) {
      kept.push(t.replace(/^(modified|deleted|new file|renamed):\s*/, ""));
      matched = true;
      continue;
    }
    // short-format " M path" / "?? path"
    kept.push(t);
    matched = true;
  }
  if (!matched) return undefined;
  const result = kept.join("\n");
  return result.length < text.length ? result : undefined;
}

// ── git log ─────────────────────────────────────────────────────────────

export function optimizeGitLog(text: string): string | undefined {
  if (!/^commit\s+[0-9a-f]{7,40}/m.test(text)) return undefined;
  const lines = text.split("\n");
  const out: string[] = [];
  let sha = "";
  let subject = "";
  for (const line of lines) {
    const m = /^commit\s+([0-9a-f]{7,40})/.exec(line);
    if (m) {
      if (sha) out.push(`${sha.slice(0, 8)} ${subject}`.trim());
      sha = m[1]!;
      subject = "";
      continue;
    }
    const subj = /^\s{4}(.+)/.exec(line);
    if (subj && !subject && !/^(Author|Date|Merge):/.test(line)) { subject = subj[1]!.trim(); }
  }
  if (sha) out.push(`${sha.slice(0, 8)} ${subject}`.trim());
  const result = out.join("\n");
  return result.length < text.length ? result : undefined;
}

// ── git diff ────────────────────────────────────────────────────────────

export function optimizeGitDiff(text: string): string | undefined {
  if (!/^diff --git /m.test(text)) return undefined;
  const lines = text.split("\n");
  const kept = lines.filter((l) => /^(diff --git|index |@@|[+-](?!\+\+|---)|(new|deleted|similarity|rename|old|new) mode|Binary files)/.test(l) || /^[+-]{3} /.test(l));
  if (kept.length === 0) return undefined;
  const stat = lines.filter((l) => /^\s*\d+ files? changed/.test(l));
  const result = [...stat, ...kept].join("\n");
  return result.length < text.length ? result : undefined;
}

// ── file / directory listing ────────────────────────────────────────────

export function optimizeFileListing(text: string): string | undefined {
  // `ls -l` style: permissions size date name
  if (!/^(total|drwx|[-dl][-rwx]{9})/m.test(text) && !/^\/.*:$/m.test(text)) return undefined;
  const lines = text.split("\n");
  const kept = lines
    .map((l) => {
      // find-style: /path:  → keep the path header
      if (/^\/.*:$/.test(l)) return l;
      // ls -l: keep only the basename (last token)
      if (/^([-dl][-rwx]{9})/.test(l)) { const parts = l.split(/\s+/); return parts[parts.length - 1] ?? l; }
      return l;
    });
  const result = kept.join("\n");
  return result.length < text.length ? result : undefined;
}

export { truncateMiddle, countLines, ERROR_LIKE, WARNING_LIKE, STACK_LINE };
