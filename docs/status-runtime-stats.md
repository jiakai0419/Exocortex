# Bound runtime statistics and completion results

`Runs` combines total and successful counts; `Last completed` combines the result,
completion timestamp/age and measured duration. `Run scope` always identifies the
current worker and retained log. `Last tasks` shows the same completion's message
sync, history and retention outcomes when that round failed or detail is requested.
Default failure summaries omit optional tasks that were not run; detail names
all three groups and labels absent optional tasks `not run`.
The separate message-details display rule is documented in the
[screen contract](status-screen-design.md). The additions use already-read
evidence; there is no new query, persistence, worker protocol or storage schema.

| Fact | Meaning |
| --- | --- |
| Total runs | Number of distinct completed background rounds in the retained log for the verified current worker instance and selected database. Includes failed rounds; excludes an unfinished round. |
| Successful runs | Those completed rounds with an explicit successful result. |
| Last completed | Result and completion time of the last recorded round in that same scope, whether successful or failed. Uses the existing local timestamp and age formatting. |
| Last duration | Elapsed wall time from that round's first step start to its completion, only when all expected step records and their order/timestamps are intact. Includes time between steps. |
| Task groups | Message sync is the six required sent/discovery/received steps; history and retention are optional logical steps. Group counts cover the same retained completed rounds, counting only rounds in which that group was scheduled. |

The `Run scope` row applies to all runtime facts: **completed rounds ·
current worker / retained log**. These are recorded completions, not lifetime counters, individual sync
commands, the largest cycle number, or a 24-hour stability summary. The existing
reader retains at most the final 8 MiB / 20,000 events of the current log; rotation
or truncation can reduce the count. It does not read archived logs.

Use the existing verified service/process/database association, then require
explicit version-1 database and instance binding on each record. Never assign an
old unbound event to the current worker by proximity. No verified current worker,
missing log, or contradictory completion evidence means unavailable, not zero.
A verified usable log with no matching completion records can report zero.
Incomplete step evidence affects duration and failure reasons, without inventing duration from the gap
between completions or the configured interval. Steps must also follow any
retained prior completion in both append order and time. No private identifiers, paths,
raw events, or error strings enter the public projection.

## Additive public JSON

`runtime_stats.last_completion` is selected directly from the same verified
completion used by the counters. It contains `cycle`, normalized `at`, boolean
`ok`, nullable `duration_ms`, `failed_steps`, `failures: [{step, reason}]`, and
`groups: {sync, history, retention}`. Group results are `succeeded`, `failed`, or
`not_run`. The existing `last_completed_at` and `last_duration_ms` are aliases of
that object's `at` and `duration_ms`; they never borrow an unbound
`worker.last_cycle` result. `last_completion` is null when no matching completion
exists or runtime evidence is unavailable.

Top-level `runtime_stats.groups` contains `sync`, `history`, and `retention`, each
with `total_runs`, `successful_runs`, and `failed_runs`. An absent optional step
is `not_run` in the latest result and contributes nothing to its group counters.
A known empty retained history has zero counters; unavailable evidence has
`groups: null`. These group facts depend only on each validated completion's
expected step vocabulary and failure list. Losing a step trail does not erase a
valid completion. Conflicting receipts that assign different optional tasks to
the same cycle are rejected, even if their step counts match.

Every failed task still makes the complete round failed. A successful message
sync group means its six logical steps succeeded, not that all history or remote
messages are complete. A successful history task can include a deliberate
`batch_deferred` or `no_eligible_known_record` outcome with no processed records;
it is not a claim that any record was revisited. No processed-record count is
invented from a group success.

Specific failure reasons require the entire bound step trail to pass the same
identity, ordering, result and timestamp checks used for duration. Currently,
only an unsuccessful `known_record_history/v1` summary with a positive integer
exit code and no guardian diagnostic supplies a reason from
`request_budget.stop_reason`: `cli_budget`, `self_budget`, `time_budget`,
`clock_unavailable`, `sync_busy`, `lease_unavailable`, `rate_cooldown`,
`rate_limited`, or `shared_cooldown_unavailable`. All other failed steps and
missing, legacy, contradictory, process-failure or unknown reason evidence use
`reason_unavailable`. A recognized reason does not change the round's result.
Raw stderr, identifiers, arbitrary summary strings and neighboring cycles never
become public reasons.

Completion and step timestamps share the same strict worker-event parser with
`check --wait`: require an explicit timezone and a real calendar date, while
accepting valid timezone-equivalent instants. An impossible date must not be
normalized into a usable completion. An invalid completion makes these statistics
unavailable; invalid or incomplete steps make duration unavailable. These rules
do not merge the two consumers' acceptance policies: statistics may count a bound
failed completion, whereas waiting requires a complete successful round begun
after invocation.

## Invented target before implementation

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK
  Background             Running
  Current work           Waiting · between background rounds
  Runs                   4 total · 4 successful
  Run scope              Current worker · retained log
  Last completed         Succeeded · Today 11:59:25 (35s ago) · 12s duration

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Remote sample          Not verified · no cached remote sample
```

All examples and tests are invented from scratch. These tests do not read
production runtime data, and their fixtures contain no private operational data.
Validation covers bound normal,
active and failed rounds, zero history, stopped/unverified service, old/foreign
instances and databases, truncated/legacy/malformed logs, missing step evidence,
narrow terminals and no-color output. Group tests also cover optional tasks not
run, mixed failures, deferred history, equivalent/contradictory cycle policies,
and missing or unsafe reason evidence. Existing runtime result semantics remain
unchanged; unmodified screen rows are checked against the baseline output.
