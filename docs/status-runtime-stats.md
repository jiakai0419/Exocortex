# Four runtime statistics

The four statistics occupy two rows after current work (after phase observation
in detail mode): `Runs` combines total and successful counts; `Last completed`
combines the completion timestamp/age and the measured duration. Detail mode adds
`Run scope`; the default screen has no scope suffix. The separate message-details
display rule is documented in the [screen contract](status-screen-design.md).
There is no new history section, query, persistence, worker protocol or schema.

| Fact | Meaning |
| --- | --- |
| Total runs | Number of distinct completed background rounds in the retained log for the verified current worker instance and selected database. Includes failed rounds; excludes an unfinished round. |
| Successful runs | Those completed rounds with an explicit successful result. |
| Last completed | Completion time of the last recorded round in that same scope, whether successful or failed. Uses the existing local timestamp and age formatting. |
| Last duration | Elapsed wall time from that round's first step start to its completion, only when all expected step records and their order/timestamps are intact. Includes time between steps. |

The `Run scope` row in `--detail` applies to all four facts: **completed rounds ·
current worker / retained log**. The JSON `runtime_stats` object, including its
`scope`, is unchanged. These are recorded completions, not lifetime counters, individual sync
commands, the largest cycle number, or a 24-hour stability summary. The existing
reader retains at most the final 8 MiB / 20,000 events of the current log; rotation
or truncation can reduce the count. It does not read archived logs.

Use the existing verified service/process/database association, then require
explicit version-1 database and instance binding on each record. Never assign an
old unbound event to the current worker by proximity. No verified current worker,
missing log, or contradictory completion evidence means unavailable, not zero.
A verified usable log with no matching completion records can report zero.
Incomplete step evidence affects duration, without inventing it from the gap
between completions or the configured interval. Steps must also follow any
retained prior completion in both append order and time. No private identifiers, paths,
raw events, or error strings enter the public projection.

## Invented target before implementation

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK
  Background             Running
  Current work           Waiting · between background rounds
  Runs                   4 total · 4 successful
  Last completed         Today 11:59:25 (35s ago) · 12s duration

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Remote sample          Not verified · no cached remote sample
```

All examples and tests are invented from scratch. Production runtime data is
neither read for this change nor included in Git. Validation covers bound normal,
active and failed rounds, zero history, stopped/unverified service, old/foreign
instances and databases, truncated/legacy/malformed logs, missing step evidence,
narrow terminals and no-color output. Runtime data semantics remain unchanged;
unmodified screen regions are checked against the baseline output.
