# Bounded readiness observer recovery

Baseline: `5c231acdc568a9e0317d42ea1ff5561a9db25cc5`. Local candidate only; no release authorization.

The observer's timeout injection currently selects the legacy SQLite JSON output instead of the framed reader used by ordinary `messages`. A fixed-content synthetic record below the existing byte limit times out there while the default reader completes. A claim can persist without its finish; the caller drops the returned failure. Separately, the ascending tail can put new observations behind hundreds of old rows. These are demonstrated implementation defects. They do not explain every historical failed attempt or establish missing historical first-complete timestamps.

## Required behavior

- Read the same single source/evidence snapshot using the existing framed wire. Carry a fresh remaining-deadline option independently of test reader overrides. Never let invalid/nonpositive timeouts fall back to the ordinary 30-second default.
- Keep the observer invocation within its existing 5,000 ms envelope, including admission, claim, reads, finish and owner-qualified cleanup. Reuse the existing internal execution-budget primitive with its cleanup/output reservations contained in that grant. No remote calls or enlarged per-call/count/row/byte/cadence budgets.
- Keep 40 total selected records: latest head at most10, continuous tail at least10 slots (up to20 when duplicate head entries free slots), historical20. Head and tail together use the old2MiB role budget; history retains2MiB; individual rows retain2MiB. De-duplicate IDs. Head reads never advance the contiguous tail watermark. Continuous tail and historical cursors advance only over their own selected/scanned pages under their existing CAS. Empty/overlapping roles must not fabricate observations or lose old debt.
- With no more than10 new records per successful opportunity, within byte/time limits, those newest records can be observed on that opportunity. This is a conditional capacity bound, not a production SLO. Burst/failed/deferred records remain in the denominator and continuous backlog progresses across restart. Latest-head observation must not starve continuous or historical work.
- A successful ingestion and an unhealthy observer are separate facts. Preserve observer results in an additive `sync.readiness` JSON/worker receipt; do not change ingestion `ok`, status formatting, messages layout or message coverage. The returned receipt describes the current attempt, not stale last-finish counters.
- First-ready remains first **observed** ready for the same source epoch/account/contract. Never backdate it to source, insert, lookup, or task times. Do not reconstruct missing historical completion.

## Internal interfaces

`loadMessages` / `readMessageSnapshot` dependencies gain `sqliteReadOptions?: () => {timeoutMs:number}`. Evaluate it afresh before schema and snapshot reads. Default snapshot stays framed JSON-lines; production observer no longer injects `sqliteJson`. Existing test hooks remain compatible.

Observer result retains `reason, scanned, observed, deferred` with finite allowlisted reasons and nonnegative bounded counts. Optional diagnostic fields are closed-schema only:

- `diagnostic` and `cleanup_diagnostic`: `{version:1,stage,kind,read}`. Stages: admission, claim, select, read, plan, finish, release, dispatch. Kinds: sqlite_read, time_budget, clock_unavailable, invalid_response, unknown, cleanup_failed. `read` is null or the existing safe SqliteReadDiagnostic, never SQL/exception text/paths.
- `claim_state`, `finish_state`: not_started, confirmed, unknown. Confirmed means the returned guarded commit receipt proves it; ambiguous execution is not success or a claimed rollback.
- `cleanup_state`: not_required, succeeded, failed, unknown. A confirmed finish survives a later cleanup failure, which is retained separately. Primary failure must not be replaced by cleanup failure.
- `command_budget`: existing finite `{version,max_ms,elapsed_ms,stop_reason,complete}` with max_ms5000 and original budget semantics.

Root supplies the pure closed-schema validator in `src/core/readiness-observer-result.ts` and the trusted local error adapter `src/diagnostics/readiness-observer-result.mjs`: `readinessFailure(stage,error)` returns the safe diagnostic; `normalizeReadinessObservation(value)` copies only a valid closed result; `failedReadinessObservation(stage,error)` returns a bounded dispatch/wrapper failure. Unknown external objects cannot supply arbitrary error text through these helpers. Caller and worker use the same sanitizer.

`commitEnrichmentUpdates` gains an optional `executionBudget`; default callers retain behavior. Budgeted lock acquisition/guarded transaction/owner release use that budget. The bounded caller can inspect a trustworthy finite outcome for confirmed commit and cleanup failure; no raw SQL/error text is projected. All account/lease/source/sync-lock/maintenance/CAS fences remain.

## Ownership for this candidate

- Reader branch: message-read-snapshot.mjs, messages-report.mjs, new reader-specific tests only.
- Fairness branch: message-readiness-ledger.mjs and new ledger/fairness tests only; use root's safe diagnostic helper; do not edit wrapper or reader.
- Budget branch: message-readiness-sync.mjs, enrichment-commit.mjs and new budget/commit tests only; consume reader/ledger interfaces above; no shared helper edits.
- Root: shared result helper, sync-command.mjs, worker compact summary, existing integration assertions, this document, integration/full checks and final freeze. Other history/check investigations remain proposals, not mixed into this patch.

## Acceptance before freezing

Use exclusively authored fixtures. Reproduce large JSON through actual sync CLI and real SQLite/account/lease paths; keep current5s limit. Exercise fresh callbacks, clock errors, every pre/post-claim failure, source/account/CAS changes, confirmed commit plus cleanup failure, unknown commit, and restart. Test >885 old rows with sustained new arrivals and bursts, all40/byte limits, no skipped cursor range or starvation. Keep raw/source/body/name/time/order/JSON/text semantics and source epochs unchanged. Preserve original failures and corrections; do not count a later rerun as explanation.

Run the complete suite on a fixed candidate, preserving protected process-check limitations. Compare actual messages JSON/text read-only against an unchanged private snapshot, and provide a persistent code-only recovery bundle. Production remains5c; do not execute the observer against production before separate release approval.

## Implementation status

Design was recorded before changes. Reader, fair selection, budgeted local commit and safe sync/worker receipts are now connected. Source data, account/source/record CAS and the original reader wire remain intact. Required admission query exceptions are retained per capture/recheck even when the account inspector catches them internally; later stages cannot reuse an earlier stage's exception.

The old initial scan jumped its tail to the maximum ID. The new initial scan starts continuously at zero and uses the independent head for fresh data. Consequently the old65-record +25-record-burst fixture has75/90 observed after four opportunities and reaches90/90 by opportunity eight; the outstanding15 remain explicit. That burst exceeds the fresh10 capacity assumption. The separate900-old +10-new-per-opportunity fixture covers all1,350 records over45 opportunities, preserving every original record and each fresh batch. These are synthetic opportunity bounds, not production timing promises.

Unbudgeted compatible commit callbacks cannot attest cleanup; their receipt reports cleanup_state unknown rather than claiming no cleanup was required. The production observer uses the private bounded commit receipt. Invalid child receipts remain visible as dispatch/invalid_response; explicit unknown or not-started finish cannot claim successful observations. Ingestion success is unchanged.

Validation artifacts are kept outside Git. They retain the original six old-policy assertion failures and the admission-error-preservation counterexample, along with corrected tests that preserve the original complete-coverage/fence/denominator requirements. Full candidate verification and independent review remain release gates. Two previously protected process-precondition tests will remain explicitly unverified locally rather than retrying their restricted queries.

## Byte-capacity recurrence correction

The first frozen implementation has a demonstrated counterexample: with35 authored records, two legal near2MiB rows at the historical page head and newest head repeatedly consume both role budgets. Capacity-deferred rows2–20 receive no observations even as both cursors cycle. Moving beyond a row deferred only by the current page's byte allocation does not establish fair revisiting.

Before implementation of this narrow correction, the required rule is: tail and historical cursors may only advance across a continuous prefix whose rows were selected in either role, or whose individual size exceeds the existing per-row limit and therefore cannot be observed under this contract. Stop before the first otherwise-eligible row excluded by this opportunity's byte allocation. Preserve empty-page/horizon completion and selected-row de-duplication. A permanently oversized individual row must not block legal successors; it remains explicitly deferred and may be revisited on historical rounds. This changes no row/role/time/API budget or readiness truth and requires no schema change.

Reproduce the original35-row recurrence with real SQLite and finite rounds; require every legal row to be observed, with no record writes and no fabricated past timestamps. Also cover a row exactly at the limit, an oversized predecessor, repeated large fresh arrivals, restart, selected-row overlap, source CAS changes and failed reads. Keep the original counterexample and all prior frozen validation results. The correction must not equate selection with a confirmed readiness observation; existing guarded observation SQL remains authoritative.

The correction now advances only that eligible continuous prefix. Under the original heavy-head input, the19 missing rows are observed on opportunity2 and all35 on opportunity3. The near2MiB raw objects remain blocked by the separate existing identity-parsing limit; their first-ready time stays null. Their first-observed time and the small ready rows' first-ready time come only from actual completed readings. The original light-head control still covers its19 rows on opportunity2. These are authored finite controls, not historical completion reconstruction or production latency measurements. Original missing-dependency failures, first-fixture errors and the frozen8c fairness failure remain in external validation evidence; no test limit or product parser bound was relaxed.
