# Node reliability fixes

## Scope and implementation plan

This change is limited to three reliability fixes on the existing Node implementation.

1. Isolate merged-message detail failures from conversation availability. Preserve ordinary messages, represent missing details, and keep them retryable. Split oversized native windows after bounded timeout, with explicit limits; incomplete windows must never advance a cursor.
2. Make service lifecycle results reflect launchd outcomes. Distinguish an absent job from an inspection failure and propagate start failures. Require fresh activity evidence before reporting active synchronization, including independent foreground synchronization.
3. Use one merge policy for synchronization and enrichment. An unknown name lookup must preserve a known name; an explicit authoritative clear must remain expressible. Same-version projection improvements remain valid and idempotent.

## Acceptance plan

- Use only newly invented messages, identities, clock values, subprocess results, and temporary databases. Do not derive fixtures from operational data.
- Retain regression cases for each reported failure and counterexamples that define the limits of each fix.
- Run focused tests while implementing, then the repository's build, typecheck, syntax checks, full test suite, and generated-file consistency check.
- Document exact pass/fail/not-run outcomes and the remaining operational validation boundary.
- Keep runtime entry points stable. No rewrite, deployment, service lifecycle operation against a real service, or production data mutation is part of this work.

## Implemented contracts

### Incomplete details and bounded progress

`MessageDetailsIncompleteError` separates merged-message hydration from chat-list permission. It is produced only after list/search pagination completes; it carries validated complete messages and missing-detail reasons. The runner saves those records with a failed run through the existing transaction fence. The scope remains enabled; cursor, cursor update time, and last successful run stay unchanged. Failed metadata uses `window_complete: false`, `missing_detail_count`, aggregate reasons and `attempted_window_*`, never successful coverage-window keys. Unresolved merged roots cannot overwrite a previously complete expansion.

`MessageWindowBudgetError` identifies exhaustion of the shared native-window deadline. Normal synchronization then retries the smallest minute-aligned prefix once. Page-cap failures keep their existing bisection behavior. Ordinary request timeout, rate limiting, malformed responses, and permission errors do not independently justify shrinking. An incomplete minimum prefix remains a failure. Earlier page-cap retries and later work still consume the worker step limit; this is bounded recovery, not an unconditional progress guarantee.

### Truthful lifecycle and activity

launchd inspection returns loaded, absent, or unknown. Absence requires both exit status 113 and the service-not-found diagnostic; permission/domain/spawn/signal errors remain unknown. Start and install propagate kickstart failure; `start requested` confirms command acceptance only. Stop verifies absence before success; uninstall retains the plist if verification fails.

Completed worker-step events are historical facts, even when their cycle never finished. `unfinished_cycle` tracks append order independently of reset cycle numbers; `in_progress` cannot be inferred from these events. Service SYNCING requires a valid unexpired database lease, capped at the store's one-hour hard limit. This includes foreground synchronization while the background service is stopped. Missing current evidence is UNKNOWN. `wait-ok` also rejects unfinished cycle history and failed status subprocesses.

### Shared name merging

The Lark-specific SQL merge is shared by ingestion and enrichment. Null/empty lookup results mean unknown; explicit `*_name_state: "cleared"` is authoritative. Known names and provenance remain together only when record and canonical identities agree, including the container for scoped sender names. Unknown cannot resurrect a cleared name; a fresh resolved value may replace a clear. Other record types keep their existing replacement semantics.

Ingestion applies the merge within its transaction before calculating actual write effects. Enrichment applies the same expression to its snapshot and commits only under the existing exact comparison and maintenance fence. Equivalent typed JSON projections retain stored bytes so property ordering does not create spurious updates. Same-version projection improvements remain allowed; older source versions cannot replace newer records. The helper explicitly materializes intermediate SQLite results to prevent exponential expression expansion.

## Regression and counterexample map

All identities, message bodies, clocks, subprocess outcomes, and databases in new tests were invented from scratch.

| Area | Preserved counterexample | Counterexamples defining the boundary | Tests |
| --- | --- | --- | --- |
| Detail isolation | A denied merged root disabled the conversation and lost ordinary messages in that run | Both sent and received; later pagination failure writes nothing; previously complete root stays intact; repeated denial is idempotent; successful retry completes coverage | `lark-im-native-sync.test.mjs`, `lark-im-native.test.mjs` |
| Window timeout | Shared deadline repeatedly retried one large window without progress | One minimum-prefix retry; boundary messages reread; non-minute start; ordinary timeout/rate limit unchanged; minimum saturation and incomplete pagination never advance | `lark-im-core-pagination.test.mjs`, `lark-im-native-sync.test.mjs` |
| Failed record transaction | Complete ordinary records needed durable storage without claiming full coverage | Cancelled run, replaced owner, lost lock and stale lease reject writes; cursor and last-success markers remain unchanged | `ingestion-store.test.mjs` |
| Service commands | print errors reported stopped/removed; failed kickstart reported started | Canonical absence vs status/text mismatch, missing domain, permission, signal/spawn failures; bootstrap race; final inspection failure preserves plist | `lark-im-service-command.test.mjs`, `lark-im-service-status.test.mjs` |
| Service activity | A 33-day-old unfinished step reported SYNCING | Recent completed step also insufficient; restart resets cycle number; foreground valid lease works; future/malformed/expired/hard-expired leases fail; stale raw health cannot claim activity | `lark-im-worker-core.test.mjs`, `lark-im-service-status.test.mjs` |
| Name preservation | Same raw/hash/version after successful lookup then permission failure caused updated=1 and a null name | Unknown replay is duplicate; same-version improvement and rename allowed; clear→unknown stays cleared; clear→resolved removes marker; identity/container changes do not inherit; older version rejected | `lark-name-projection.test.mjs` |
| Enrichment parity | Independent enrichment could diverge on failed lookup and clear state | Known app name/provenance stays byte-stable; contact/partner resolution replaces clear; dry-run and concurrent source update remain protected | `lark-im-enrich-records.test.mjs` |
| SQL resource bound | An intermediate implementation expanded nested merge expressions until SQLite ran out of memory | Explicit materialization plus a 100-record synthetic known→unknown transaction, with a bounded test timeout | `lark-name-projection.test.mjs` |

The original baseline was also executed against synthetic comparison probes: detail denial disabled its scope and saved zero ordinary records; shared deadline made only one attempt; stale activity, false service success, and destructive unknown-name replay were observed. The committed tests preserve the corrected behavior and its limits; local comparison probes are supplementary evidence.

## Validation and operational boundary

Final checks use Node.js 22 and SQLite CLI 3.51.0. Intermediate regression failures (SQLite expression expansion and clear-state idempotence) were corrected and rerun.

| Check | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run check` | PASS; 69 JavaScript files |
| `npm test` | PASS; 510 tests, 0 failures, 0 skipped; includes the synthetic Python coverage suite |
| `git diff --check` | PASS |
| `npm run build:check` | PASS; generated files match the committed source |
| Production service/account/data and deployment acceptance | NOT RUN; outside this local implementation authorization |

No real launchd operation, account request, synchronization, deployment, or production data repair was performed. No fixture uses real or sanitized operational data. The candidate needs independent review and separately authorized runtime acceptance. Existing disabled scopes are not automatically re-enabled. Permanently unavailable details can still hold a cursor; a saturated minute still fails safely. An unexpired lease is activity evidence, not an independent proof that its owner process is alive. The lower-level raw sync-status historical running/lock summary remains unchanged; Service does not treat it alone as active evidence.
