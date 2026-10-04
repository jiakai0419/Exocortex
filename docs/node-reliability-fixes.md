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

Normal synchronization now separates list coverage from complete content. `fetchChatMessageList` / `fetchSentMessageList` finish every list/search/mget page before returning ordinary messages and raw merged roots. Migration 009 adds a durable list checkpoint and per-root detail tasks. A fenced transaction commits ordinary records, queued roots, and the next list checkpoint together. Partial list pagination commits none of these. The complete-content cursor stays unchanged while any root is pending, so ordinary messages beyond a denied root remain ingestible across shrinking windows and process restarts without claiming full coverage.

Detail retries use a separate run and the root fingerprint as a compare-and-swap condition. Each successful listing attempts at most one due root; `--scope details` independently retries a bounded batch (default 5, maximum 20) without any list request. The batch shares a 30-second request deadline; each root has at most 50 pages, 1000 items, and 64 tree levels. Failures remain pending with exponential backoff from 60 seconds up to 24 hours. Locked scopes are refilled within a finite candidate scan of `max(3×limit, limit+20)`; scopes beyond that bound can be deferred under sustained contention. Completed receipts are updated to the authoritative refreshed root and prevent unchanged inclusive-boundary roots reopening debt. Identical repeated roots from completed pages are deduplicated; conflicting same-ID evidence rejects the list transaction. The authoritative current root may be a newer source version; identity changes, regressions, same-version conflicts, and missing expansion remain incomplete. Failed refreshes retain any previously stored complete root.

Only after every task is complete does the storage transaction promote the full cursor to the continuous list frontier and emit a composed coverage interval. Partial runs contain `list_window_*`, `list_complete: true`, `details_complete: false`, and `window_complete: false`, never successful interval keys. Status, service readiness, and coverage diagnostics consider current detail debt even when historical successful runs or old health values exist. Read-only legacy diagnostics explicitly distinguish unavailable old-schema evidence from a damaged upgraded database.

`MessageWindowBudgetError` still identifies exhaustion of the shared 180-second native list deadline. The runner then retries the smallest minute-aligned prefix once; page-cap failures retain their bounded bisection behavior. Ordinary request timeouts, rate limiting, malformed responses, and permission errors do not justify shrinking. Detail limits never trigger list bisection. A saturated minimum prefix remains a safe failure. Strict fetch APIs used by bounded replay still require the complete content window.

The initial candidate saved ordinary messages only inside its repeatedly retried prefix. Independent review found that a denied root plus window shrinking could starve later ordinary messages, despite passing its original tests. That candidate is retained unchanged for comparison. This follow-up replaces that insufficient progress contract rather than claiming that all detail failures previously blocked every list shape.

### Truthful lifecycle and activity

launchd inspection returns loaded, absent, or unknown. Absence requires both exit status 113 and the service-not-found diagnostic; permission/domain/spawn/signal errors remain unknown. Start and install propagate kickstart failure; `start requested` confirms command acceptance only. Stop verifies absence before success; uninstall retains the plist if verification fails.

Completed worker-step events are historical facts, even when their cycle never finished. `unfinished_cycle` tracks append order independently of reset cycle numbers; `in_progress` cannot be inferred from these events. Service SYNCING requires a valid unexpired database lease, capped at the store's one-hour hard limit. This includes foreground synchronization while the background service is stopped. Missing current evidence is UNKNOWN. Lease evaluation samples the clock after all diagnostic evidence has been collected, so leases acquired or expired during subprocess queries are interpreted against the actual observation time. Tests retain numeric time overrides and cover acquisition, expiry, and hard-lease crossings. `wait-ok` rejects unfinished cycle history, failed status subprocesses, and pending detail debt.

### Consistent health evidence

All database facts used by the status report—detail debt, list progress, records, scopes, discovery, runs, and locks—are read by one SQLite SELECT inside one read-only transaction. Schema preflight chooses the query shape only; the final snapshot rechecks that shape and migration 009. Concurrent schema changes, missing sections, or unparseable evidence reject the report; invalid aggregate counts remain unavailable and require attention instead of becoming zero debt or legacy evidence. Service health and `wait-ok` consume that consistent report.

A report describes one database snapshot. A writer may commit after the snapshot begins, so a coherent earlier report remains possible; it cannot combine earlier zero debt with a newer incomplete list frontier or failed run. Synthetic WAL tests keep a real reader transaction open while a separate process commits through the real synchronization adapter and store, then verify both the complete earlier report and the incomplete subsequent report. The earlier `b528dc6` candidate is retained in Git history as the negative comparison; this correction is an appended commit.

### Status timing and concise explanations

The longest success interval now measures only adjacent observed successful cycles inside the requested window. Neither window edges nor time since the last success contributes to it; fewer than two successes yields `null`. The last-success age remains separate. Observation metadata describes the retained current-log range, clipped to the requested window, with explicit tail truncation and unknown-range cases. It never claims service startup or continuous coverage. Exact milliseconds remain available in JSON; only the gap's terminal display rounds to a second.

The existing service layout remains: Chat list review shows its recorded completion time instead of leading with page counts; Active chat refresh shows its last successful refresh time. Both default to the API list of non-muted group and private chats, not an unbounded all-conversations claim or proof of complete messages. Existing received-scope counts retain their distinct meaning. Normal lease occupancy stays in Activity; only timestamp-supported lease anomalies produce a warning. No waiting or process-liveness claim is inferred from a lock alone. Technical cursor and lease fields remain in detailed diagnostics, and no new discovery-count storage mechanism is introduced.

### Shared name merging

The Lark-specific SQL merge is shared by ingestion and enrichment. Null/empty lookup results mean unknown; explicit `*_name_state: "cleared"` is authoritative. Known names and provenance remain together only when record and canonical identities agree, including the container for scoped sender names. Unknown cannot resurrect a cleared name; a fresh resolved value may replace a clear. Cached chat names explicitly carry `scope_config` / `local_history` provenance and can only fill unknown fields; they cannot overwrite a known name or authoritative clear. A fresh message name remains eligible for a same-version improvement. Other record types keep their existing replacement semantics.

Ingestion applies the merge within its transaction before calculating actual write effects. Enrichment applies the same expression to its snapshot and commits only under the existing exact comparison and maintenance fence. Equivalent typed JSON projections retain stored bytes so property ordering does not create spurious updates. Same-version projection improvements remain allowed; older source versions cannot replace newer records. The helper explicitly materializes intermediate SQLite results to prevent exponential expression expansion.

## Regression and counterexample map

All identities, message bodies, clocks, subprocess outcomes, and databases in new tests were invented from scratch.

| Area | Preserved counterexample | Counterexamples defining the boundary | Tests |
| --- | --- | --- | --- |
| Detail isolation and progress | A denied root disabled the conversation; the initial fix then pinned list progress at a shrinking prefix | Both directions, repeated shrinking, fresh runner instances, late ordinary records, default page limits, independent repair, continued healthy detail tasks, preserved old expansions | `lark-im-detail-progress.test.mjs`, `lark-im-native-sync.test.mjs` |
| Durable list/debt transactions | A restart must retain both progress and unresolved root descriptors | List failure commits nothing; baseline/gaps, lock/lease/cursor/generation/identity/fingerprint fences; mutable discovery metadata allowed; receipts, version conflicts, rollback and final closure | `lark-detail-store.test.mjs`, `lark-im-detail-adapter.test.mjs` |
| Status timing and presentation | Window edges inflated a success-to-success interval; technical counts duplicated existing status | Synthetic dominant-edge intervals, zero/one success, exact time bounds, partial/rotated logs, safe completion timestamps, normal versus abnormal lease display | `lark-im-service-stability.test.mjs`, service view and lease evidence tests |
| Consistent status snapshot | Separate read-only connections combined old zero debt with a new incomplete list and failed run | Real concurrent WAL writer; consistent before/after reports; Service and wait-ok; schema preflight race; malformed/missing evidence fails closed | `sync-status-snapshot.test.mjs`, `sync-status-command.test.mjs`, `diagnostics-readonly.test.mjs` |
| Coverage and diagnostics | List-only evidence or historical health could hide pending details | Partial flags and malformed composed intervals rejected; target-relative debt; legacy versus damaged schema; public aggregate output | `lark_im_coverage_check_test.py`, `sync-status-command.test.mjs`, `sync-status-core.test.mjs` |
| Window timeout | Shared deadline repeatedly retried one large window without progress | One minimum-prefix retry; boundary messages reread; non-minute start; ordinary timeout/rate limit unchanged; minimum saturation and incomplete pagination never advance | `lark-im-core-pagination.test.mjs`, `lark-im-native-sync.test.mjs` |
| Failed record transaction | Complete ordinary records needed durable storage without claiming full coverage | Cancelled run, replaced owner, lost lock and stale lease reject writes; cursor and last-success markers remain unchanged | `ingestion-store.test.mjs` |
| Service commands | print errors reported stopped/removed; failed kickstart reported started | Canonical absence vs status/text mismatch, missing domain, permission, signal/spawn failures; bootstrap race; final inspection failure preserves plist | `lark-im-service-command.test.mjs`, `lark-im-service-status.test.mjs` |
| Service activity | A 33-day-old unfinished step reported SYNCING | Recent completed step also insufficient; restart resets cycle number; foreground valid lease works; future/malformed/expired/hard-expired leases fail; stale raw health cannot claim activity; lease acquisition/expiry during diagnostic collection | `lark-im-worker-core.test.mjs`, `lark-im-service-status.test.mjs` |
| Name preservation | Same raw/hash/version after successful lookup then permission failure caused updated=1 and a null name | Unknown replay is duplicate; same-version improvement and rename allowed; clear→unknown stays cleared; clear→resolved removes marker; identity/container changes do not inherit; older version rejected; cached chat name cannot replace known or cleared values | `lark-name-projection.test.mjs` |
| Enrichment parity | Independent enrichment could diverge on failed lookup and clear state | Known app name/provenance stays byte-stable; contact/partner resolution replaces clear; dry-run and concurrent source update remain protected | `lark-im-enrich-records.test.mjs` |
| SQL resource bound | An intermediate implementation expanded nested merge expressions until SQLite ran out of memory | Explicit materialization plus a 100-record synthetic known→unknown transaction, with an external process deadline; a deliberately blocked `spawnSync` child proves actual termination | `lark-name-projection.test.mjs` |

The original baseline was also executed against synthetic comparison probes: detail denial disabled its scope and saved zero ordinary records; shared deadline made only one attempt; stale activity, false service success, and destructive unknown-name replay were observed. The committed tests preserve the corrected behavior and its limits; local comparison probes are supplementary evidence.

## Validation and operational boundary

Final checks use Node.js 22 and SQLite CLI 3.51.0. The initial candidate passed 510 tests but failed subsequent independent review. The durable-progress candidate then passed 601 tests before review found the mixed-snapshot diagnostic race; neither historical pass is acceptance of this snapshot follow-up. The review counterexamples for a diagnostic clock crossing and cached chat names were run against the frozen candidate and failed as expected before the fixed focused tests passed. A separate intentionally blocked child verified the external test deadline.

| Check | Follow-up result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run check` | PASS; 70 JavaScript files |
| `npm test` | PASS; 642 tests, 0 failures, 0 skipped; includes synthetic Python coverage tests |
| `git diff --check` | PASS |
| `npm run build:check` | PASS; generated files match committed source |
| Production service/account/data and deployment acceptance | NOT RUN; deferred until independent final review |

No real launchd operation, account request, synchronization, deployment, or production data repair was performed. All fixtures are invented; none are real or sanitized operational data. Existing disabled scopes are not automatically re-enabled. Permanently unavailable details continue to block *full-content* completion while list scanning proceeds. A saturated minimum list minute still fails safely. An unexpired lease is activity evidence, not proof that its owner process is alive. Runtime acceptance and publication remain deferred until independent final review. The original and follow-up candidates are retained for independent review.
