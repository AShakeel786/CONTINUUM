# License Compatibility Matrix — CONTINUUM v0.1.0-beta.1

**Verdict: LICENSE_CLEAR**

## Summary

| Item | Result |
|---|---|
| Copied third-party source (A/B) | **none** |
| Reimplemented patterns/ideas (C) | several, all from MIT or generic/public sources |
| Runtime dependencies (D) | `js-tiktoken` (MIT) |
| Dev dependencies (D) | MIT / Apache-2.0 / ISC / BSD-3-Clause |
| Copyleft / source-available / UNKNOWN | **none** |
| Upstream with a license (TencentDB-Agent-Memory) | **MIT** (verified) |

## Compatibility verdicts

| License to adopt | Safe? | Rationale |
|---|---|---|
| **MIT** | ✅ | No copied source; only MIT upstream pattern reuse + permissive deps. Simplest. |
| **Apache-2.0** | ✅ | Same — no Apache-2.0 *code* is copied in (only dev deps, not distributed), so no NOTICE aggregation obligation beyond standard. |

## Recommended license

**MIT.** It is the simplest fit and matches the one relevant upstream (TencentDB-Agent-Memory,
MIT). Apache-2.0 is also safe if the maintainer prefers it (explicit patent grant).

## Required artifacts (after choosing a license)

- `LICENSE` file (chosen license text).
- `package.json` `"license"` field.
- **Recommended (courtesy, not legally required):** `THIRD_PARTY_NOTICES` acknowledging
  TencentDB-Agent-Memory (MIT, © 2026 Tencent) as the memory-infrastructure upstream and the
  source of reimplemented patterns, and `js-tiktoken` (MIT).

## What is NOT required

- No per-file attribution/license headers (no copied source to attribute).
- No NOTICE aggregation (no Apache-2.0 code is copied in).
- No modified-file notices (nothing was modified from an upstream file).

## Note on legal certainty

This audit is a factual provenance review, not legal advice. It separates:

- **Confirmed:** no copied source; TencentDB-Agent-Memory is MIT; all deps are permissive.
- **Likely interpretation:** pattern/interface reuse without copying creates no license obligation.
- **Needs legal review:** none strictly, but final license selection and any NOTICE wording should
  be confirmed by the maintainer (and counsel if distributing commercially).
