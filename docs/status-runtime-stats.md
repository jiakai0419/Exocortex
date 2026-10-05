# Four runtime statistics

This addition leaves the existing status layout and facts unchanged. It adds
exactly four rows after current work (after phase observation in detail mode).
There is no new history section, query, persistence, worker protocol or schema.

| Row | Meaning |
| --- | --- |
| Total runs | Number of distinct completed background rounds in the retained log for the verified current worker instance and selected database. Includes failed rounds; excludes an unfinished round. |
| Successful runs | Those completed rounds with an explicit successful result. |
| Last completed | Completion time of the last recorded round in that same scope, whether successful or failed. Uses the existing local timestamp and age formatting. |
| Last duration | Elapsed wall time from that round's first step start to its completion, only when all expected step records and their order/timestamps are intact. Includes time between steps. |

The short scope on Total runs applies to all four rows: **current worker / retained
log**. These are recorded completions, not lifetime counters, individual sync
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
  Total runs             4 completed rounds · current worker / retained log
  Successful runs        4
  Last completed         Today 11:59:25 (35s ago)
  Last duration          12s

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

All examples and tests are invented from scratch. Production runtime data is
neither read for this change nor included in Git. Validation covers bound normal,
active and failed rounds, zero history, stopped/unverified service, old/foreign
instances and databases, truncated/legacy/malformed logs, missing step evidence,
narrow terminals and no-color output. The prior rows and sections remain identical.
