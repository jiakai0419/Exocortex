# Unified status contract

This change preserves the meaning of existing evidence and keeps `status` local
and read-only. It adds no persistence, worker protocol, migration or remote call.
The default screen remains compact; total/successful share one logical row and
the last completion's result/time/duration share one logical row.

## Evidence and result rules

- Runtime counts cover distinct completed rounds for the verified current worker
  and selected database in the retained current log. Always name that scope;
  rotation can reduce counts. Failed rounds remain failed.
- Add a `runtime_stats.last_completion` projection from the exact completion
  already selected for the existing time and duration fields. Include cycle,
  `at`, `ok`, `duration_ms`, finite `failed_steps`, and safe failure reasons.
  Do not combine it with the unbound `worker.last_cycle` summary. Keep existing
  scalar fields as compatible aliases of that same selection.
- Derive message-sync, history-task and retention groups from the expected
  steps and the completion's failure list. Expose group totals/successes/failures
  over the same retained completions, and each group's latest result. An absent
  optional step is not run, not successful; unavailable evidence is not zero.
  Message sync includes discovery/catch-up work, not a completeness guarantee.
  The history group describes the logical history task: a successful deferred
  task or one with no eligible records does not prove that messages were reviewed.
- Failure reasons come only from the same bound, validated step trail and a
  finite allowlist. Missing, contradictory or legacy reason evidence remains
  explicitly unavailable. No raw errors, identities or arbitrary strings.
- Show latest task groups when the latest round failed or detail is requested;
  omit optional tasks that did not run on the default screen, and retain them in
  detail. On the default successful screen the succeeded completion is sufficient.
- Remote sampling remains cached, bounded evidence. Display actual/planned
  recent-chat routes, compared messages and confirmed static-body count. Derive
  planned routes only from valid hot + fair counts; unknown counts stay unknown.
  Keep known/historical targets separate from recent-chat routes. A partial
  sample is inconclusive, not an observed difference; rejected bindings never
  become positive claims merely because counters remain present. No sample or
  no comparison is not zero confirmed bodies. Detail retains window, expiry,
  unverified content and coverage limits.
- Optimize the existing failed-run closure proof without changing its ordering,
  budgets, same-scope/source fences, cutoff, size limits or unknown/actionable
  semantics. Prove equivalence and scaling with wholly synthetic data.

## Invented full-screen target (80 columns)

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK
  Background             Running
  Current work           Waiting · between background rounds
  Runs                   4 total · 3 successful
  Run scope              Current worker · retained log
  Last completed         Failed · Today 11:59:25 (35s ago) · 12s duration
  Last tasks             Message sync succeeded · history task failed
                         (time budget)

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Remote sample          Partial cached sample · 3/5 chats checked · 8 messages
                         · 2 static bodies confirmed · checked Today 11:50:00
```

The fixture above is invented, not copied or derived from runtime data. Final
renderer output and narrow-terminal wrapping are generated and checked in
`status-screen-examples.md`. A failed maintenance task does not imply new-message
loss; local health and completed-round outcomes remain separate evidence.

## Verification boundaries

Cover failed/healthy mixed groups, optional history/retention absent, missing
reasons, zero completed rounds, log rotation/truncation, binding mismatch,
partial/different/expired/unavailable samples, historical targets, unknown
counts, and narrow terminals. Full verification runs only in the isolated
candidate. Any real database timing is bounded and read-only; no private rows or
derived fixtures enter this repository.
