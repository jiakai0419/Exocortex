# Finite history failure diagnostics

History can return a committed prefix after an internal exception. It can also
complete ordinary fair work when retained priority hints cannot be read, without
creating a debt ticket. Neither result proves a new source failure. A later
successful run cannot recover an exception discarded by an earlier run.

This change adds observation only. Selection, retry, request/SQLite time limits,
the fair fallback, account fences, CAS, transactions and committed prefixes keep
their existing behavior. No new queries, API calls, persisted fields or migrations
are introduced. The original exception is still thrown on the single-target path.

## Returned evidence

Optional `failure_diagnostic` describes an otherwise unexplained batch exception:
`{version:1,stage,kind}`. The controlled stages are `batch_prepare`, `batch_select`,
`batch_commit` and `single_target`. Known `SqliteReadError` instances retain only
their closed `dependency_unavailable`, `read_timeout`, `read_failed` or
`invalid_response` category. All other errors are `unknown`; message, name, stack,
SQL, query labels, file paths, record IDs and error properties are never copied.
An existing budget/lease/cooldown stop stays in `request_budget.stop_reason` and
does not become an unexplained failure.

Optional `priority_hint_diagnostic` preserves why the last committed target's
hints were unavailable, alongside the unchanged `priority_hint_reason`. Its
stages are `state_read`, `source_policy_read`, `source_policy_decode`,
`metadata_read` and `metadata_map`. State absence/invalidity is `state_missing` /
`state_invalid`; it does not claim which filesystem or JSON condition caused it.
Invalid policy JSON is `invalid_policy`. Read failures use the same finite SQLite
categories; unclassified exceptions remain `unknown`. The hints still return
`null` and ordinary work continues exactly as before. A missing hint file is a
normal absence, not a new synchronization error. This field describes the final
committed selection, not every transient hint read within a batch.

Optional `selection_stop_counts` counts existing non-error pool exits, using only
`no_target`, `outside_pool`, `already_consumed` and `source_changed`. Counts are
nonnegative safe integers with a total at most twelve. These explain discarded
prefetch capacity without claiming that a source changed remotely or granting a
different scheduling turn. Budget and progress receipts retain their meanings.

The worker's existing history summary admits only these exact finite structures.
Invalid versions, stages, kinds, fields and counts are omitted. Diagnostics are
returned/logged; they are not added to stored request receipts or used to decide
admission, success, retry, priority, progress or debt settlement.

## Synthetic verification and limits

The original cross-chat and initial-ticket assertions retain their exact expected
results and time limits. On failure they now include only a whitelisted writer
summary, including the existing budget receipt and the new finite diagnostics.
The initial-ticket assertion reports a missing debt explicitly instead of losing
the writer result in an `undefined.status` exception.

Synthetic injection verifies a three-row committed prefix followed by a local
read/commit error, budget stops without fake exception claims, unchanged rollback
and checkpoint boundaries, and unreadable hint-state/policy/metadata cases that
finish fair work with no debt. A healthy control still creates a priority ticket.
Private-looking sentinels in injected errors cannot appear in worker diagnostics.

These mechanisms can produce the observed symptoms. They do not establish the
exact causes of the original uninstrumented failures, whose logs remain retained.
No increased timeout or successful rerun substitutes for that missing evidence.
