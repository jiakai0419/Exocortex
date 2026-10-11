# Acceptance and unresolved work

A successful operation, a healthy service and a resolved user problem require
different evidence. Keep those outcomes separate in release receipts and CLI
diagnostics. This document maps the fourteen unified-remediation items to their
delivered mechanisms and the evidence still needed to close a particular data
or display problem. It is an acceptance contract, not a claim about a live
installation.

## Read the result at its actual scope

| Signal | What it establishes | What it does not establish |
| --- | --- | --- |
| `status` exits 0 | The requested status was read and rendered. | Health, quality or remote agreement passed. |
| Worker step or cycle succeeds | The recorded operation completed under its step contract. | Every historical candidate, detail task, name or sample discrepancy is resolved. |
| Sampler state is ready / last outcome is ok | The sampling attempt and publication succeeded. | The report is healthy; inspect its status, reason and findings. |
| Default `check` exits 0 | Database, local sync readiness and quality passed for the final local snapshot. | Service deployment, remote equivalence, full-history coverage or client presentation equality. |
| `check --wait` exits 0 | A new complete cycle and the final local acceptance requirements passed. | Historical business problems were repaired by that cycle. |
| A bounded remote sample passes | The reported targets satisfy the comparisons it supports. | All source messages, older edits, dynamic cards or client rendering agree. |
| Synthetic regression passes | The specified mechanism handles its synthetic counterexamples. | Existing production rows were revisited or repaired. |

`check` exits 2 for incomplete or failed acceptance conditions, and exits 1 for
argument, dependency or execution failures. Missing evidence is not success.
See [operations](operations.md#read-only-diagnostics-and-explicit-repair) for the
command and wait contracts.

## Fourteen-item completion matrix

“Delivered” below describes the code contract. A release must separately bind
its executed tests to a fixed SHA and record any unresolved operational work.

| Item | Delivered mechanism | Remaining boundary | Evidence required to close the user problem |
| --- | --- | --- | --- |
| A1 — lossless projection | Text patches preserve unowned JSON values; duplicate keys are rejected independently. | Preservation does not repair previously damaged source data. | Synthetic large-number, duplicate-key and unknown-subtree counterexamples; attributable before/after evidence for any authorized data repair. |
| A2 — final admission | Sync, replay, history and enrichment conjoin account, source and scope guards at final commit; maintenance reacquires the shared lease. | External database or sidecar replacement is not SQLite-atomic. Disabled provenance is not permission to enable a scope. | Entry-point admission regressions; writer quiescence for an external replacement. |
| A3 — root evidence | Replay and detail compare complete merge-root evidence using one normalization contract. | Consistent comparison alone does not fetch missing descendants. | Equivalent/conflicting root regressions and the target's accepted ordinary detail receipt. |
| B1 — retry independence | An equivalent ordinary retry preserves a qualified history candidate's original context and clock. | The same retry is not an independent confirmation. | Candidate-preservation regression and later qualifying history evidence. |
| B2 — history/detail convergence | History may rebase the selected pending descriptor only under descriptor and list-generation CAS. | Rebase does not complete detail debt or advance the full cursor. | A later ordinary detail receipt closes the current task and permits coverage/cursor advancement. |
| B3 — sample debts | Missing, version, deletion, type, body and legacy-content debts remain independent; current target counts are mutually exclusive. | A partial or unverified observation cannot settle another dimension; an unrevisited target stays unresolved. | Per-dimension positive proof, target closure only after all debts settle, and explicit current/history sample scope. |
| B4 — repair exclusions | Exclusions constrain the directed manual repair only. | They are not a permanent hold, service stop or absolute freeze against normal sync/history. | The repair's selection and apply receipt; any separate freeze requires an explicit operational contract. |
| C1 — application identity echoes | An application ID echo is not cached as a successful name and does not block exact bot fallback. | A missing authoritative application/bot name remains unresolved. | Synthetic echo/fallback regressions; bounded authorized lookup evidence for the specific identity. |
| C2 — name observations | Adopted value, original observation and latest verification are separate and fenced by identity/account; explicit single-sender verification is bounded. | An adopted name is not current client equality. Cache reuse is not a new observation; reviewed proposals may retain unknown observation time. There is no automatic known-name refresh. | Exact identity and observation provenance, a separate latest lookup outcome, and attributable client comparison when that is the acceptance target. |
| C3 — system/group display | Event context requires matching identity, provenance and time. Supported join templates may separately label a current local group title. | A current local title is not the historical event parameter or a verified current server/client title. Historical missing-parameter evidence stays partial. | Template/identity/time/privacy regressions; the relevant UI display and provenance label; authoritative event-time evidence only if historical reconstruction is required. |
| D1 — dependency failures | Required live dependencies fail with a specific reason and exit 1. | Dependency availability does not prove collection or cleanup succeeded. | Actual CLI missing-dependency regression plus bounded collector/guardian failure diagnostics. |
| D2 — final wait acceptance | Wait requires the final database and local acceptance checks to pass. | A healthy new cycle cannot override final quality or database failure. | Actual CLI regression combining a successful cycle with each failing final check. |
| D3 — worker vocabulary | Worker producers and status readers share finite task names, including history, and consistent event-time parsing. | A displayed successful history step does not prove all historical debt is cleared. | Producer-to-status regression plus separate current detail, candidate and error evidence. |
| D4 — terminal text | Truncation preserves complete graphemes; JSON keeps full text. Provenance labels stack in narrow terminals. | A renderer passing synthetic cases is not an observation of the user's exact client or terminal. | Actual CLI boundary-width/grapheme cases, full JSON assertions, and targeted UX acceptance where requested. |

The primary regression families are
[lossless entry points](../tests/lossless-json-entrypoints.test.mjs),
[write admission](../tests/lark-write-admission.test.mjs),
[convergence](../tests/lark-convergence-interleaving.test.mjs),
[sample debts](../tests/remote-sample-debts.test.mjs),
[name verification](../tests/lark-im-name-verification.test.mjs),
[system context](../tests/messages-system-context.integration.test.mjs),
[current group context](../tests/messages-current-group-context.integration.test.mjs),
[dependencies and final database checks](../tests/check-dependencies-database.integration.test.mjs),
[CLI acceptance diagnostics](../tests/check-acceptance.integration.test.mjs),
and [history producer/status integration](../tests/status-history-producer.integration.test.mjs).
These overlap; do not add their counts to manufacture a suite total.

## Actionable, bounded diagnostics

Remote checks must preserve both collection and process-lifetime evidence.
Show the allowlisted collector and guardian primary/cleanup codes independently,
including the relevant phase and errno when available. A cleanup failure
must not disappear behind a successful collection, and a timeout or unknown exit
must not be rewritten as a confirmed success. Keep raw subprocess output, native
identities, names, bodies and private paths out of public diagnostic summaries.

Report current creation-window sampling separately from historical revisits.
The JSON evidence retains current chat/page counters, the combined message
total and a separate historical block with requests, chats/pages/messages,
window, truncation and unsupported or unroutable counts. Current message count
is the combined total minus `history.messages_checked` when history is present.
Compact `check` text separates current messages/chats from the historical
target, showing its window, unroutable and truncated counts.
Contradictory counts, overlapping windows or invalid projected evidence instead
show `sample scope unverified`; clamping a count is not evidence of a revisit.
Findings can span both collections; do not label their total
as exclusively current-window evidence. No historical request, an empty revisit
and a completed positive comparison are distinct outcomes.

`unresolved_prior` counts targets still owing proof that are not already a
missing/version/content discrepancy in the current report. It is not the sum of individual
debt dimensions. Content-unverified can coexist with a version discrepancy;
neither content-unverified nor successful transport clears body debt. Preserve
overflow and stale-evidence markers. Never edit the state to make a summary
healthy. See [remote sampling](remote-sample-design.md) and
[process lifetime](remote-sample-lifecycle.md).

For a name, report adopted-value provenance and the latest lookup outcome
separately. Unknown observation time remains unknown. For a group event, keep
historical missing parameters separate from any labelled current local title.
`check` text shows nonzero stored sender-name, group/topic-name and malformed-body
gaps as message-record counts. These are neither distinct-identity counts nor
tests of adopted-name freshness; a displayed current local title does not erase
a stored historical gap. The unchanged JSON evidence retains the other quality
categories. Zero-value gap rows do not clutter the ordinary passing screen.
See [name observations](lark-name-observations.md) and
[terminal presentation](terminal-experience.md).

The [synthetic CLI acceptance](../tests/check-acceptance.integration.test.mjs)
combines the real parser, report and renderer with the real sampler/evaluator
and an isolated SQLite quality case. It covers successful collection with
remaining debt, partial and empty historical revisits, attributable resolution,
independent process/cleanup failures, contradictory success evidence, narrow
output, privacy and unchanged JSON/exit semantics. External account and API
dependencies are synthetic; no production state is read.

## Release and closure receipt

Use three separate conclusions: implementation verified, deployment/runtime
verified, and user problem resolved. For each claimed conclusion, retain the
fixed SHA, command or observation, timestamp, scope, result and limitations.
Keep failed attempts and superseded receipts; a later passing run supplements
them with its own scope. An earlier handoff that says “not deployed” is not a
contradiction when a later exact-SHA deployment receipt exists.

For unresolved work, record the failed acceptance condition, current evidence,
next permitted operation and owner. A targeted remote lookup requires a bounded
plan within the existing cumulative account/request budget and shared leases;
an internal capability or default sampler limit is not a new allowance. Preserve
the existing ledger. A new material repair proposal needs its own valid review;
do not extend expiry or reuse an unrelated approval.

Run acceptance fixtures with wholly synthetic identities and data. Keep private
before/after rows, client captures, raw logs and production receipts outside Git.
Source preservation at a stopped deployment boundary does not promise that
normal synchronization will never change data afterward. Rollback must preserve
current data and debt evidence and use a compatible writer; see
[unified contracts](unified-remediation-contracts.md).
