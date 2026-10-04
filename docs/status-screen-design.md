# Status screen contract

This design replaces the whole public `status` text screen. It preserves the JSON
schema and existing fields, adding evidence needed for honest human summaries.
All examples and tests are invented from scratch. No operational records,
screenshots, accounts, paths, IDs or log excerpts belong in this document or Git.

## Reading order and visual grammar

1. **Exocortex status**: one observation time and the local IANA time zone.
2. **Health & current work**: local health, background service association, and
   process-verified activity. A passing local health check does not verify remote
   freshness. Unavailable evidence is explained, not collapsed into `UNKNOWN`.
3. **Coverage**: stored messages, initial conversation discovery, enabled received
   conversations still awaiting a full-content cursor, message list progress,
   detail retries, current chat refresh/review, and cached remote sample evidence.
4. **Attention**: actionable limitations and failures with a next diagnostic;
   missing or expired remote samples are optional checks, not required action;
   no invented automatic recovery or claim that a stopped service must be started.
5. **Recent history**: completed background rounds, latest task/round results,
   failed steps, success spacing and incomplete history. Logs never establish
   current work. Database failed runs have a separate explicitly labelled source
   and time window.
6. `--detail` adds readable **Diagnostics**, not a raw JSON block. `--format json`
   retains the complete machine projection; `--logs` remains explicitly private.

Every section uses the same colored heading, two-space indent and aligned keys.
Labels have sentence case. Color reinforces meaning but conveys no unique fact.
At narrow widths labels stack above wrapped values. Text is sanitized before
wrapping/styling; untrusted controls cannot create headings, rows or ANSI. Public
status text fits the supplied terminal width under the usual narrow-ambiguous
cell setting, including no-color output. Wrapping uses complete Unicode graphemes;
common CJK characters take two cells, combining/default-ignorable marks take zero,
and emoji presentation, VS16, ZWJ, flags, keycaps and skin-tone sequences take two
cells per grapheme. Private logs may contain arbitrary Unicode: this is a cell
estimate, not a guarantee about every font or terminal. Wide ambiguous-character
settings or terminals that render a joined emoji as separate pictures can differ.
A single grapheme wider than an explicitly requested width is kept intact, never
split or clipped; normal status rows have at least 16 cells. No content is silently
clipped, and errors/categories are not silently limited to three entries.

## Field semantics and evidence limits

| Field | Meaning and source | Missing/negative boundary |
| --- | --- | --- |
| Observed | Final local observation time; local zone named once | Not an atomic remote snapshot |
| Local health | Existing `health.status`, with a finite reason from service/database checks | Never promoted because of a successful historical event; not full remote freshness |
| Background | OS service state and separate current database association | Installed config alone cannot verify the selected DB; loaded without verified process means running state unverified |
| Current work | Existing process/database/phase validation; named task only from the verified current phase | Missing, stale, damaged or contradictory phases explain why work is unconfirmed; locks/history cannot prove syncing |
| Phase timing | Actual phase update and finite validity deadline | Deadline is evidence validity, not promised completion; waiting deadline is scheduled interval end |
| Stored messages | Local retained record total, sent/received and unclassified directions | Zero records does not prove absence of remote messages |
| Conversation discovery | Initial full conversation-list cursor and completion time | Remaining pages are backlog, not proof discovery is currently running |
| Received conversations | Enabled received scopes and scopes missing full-content cursors | Scope = received conversation in this adapter; presence of cursor is not fixed-target complete coverage |
| Message sources | Enabled message scopes (sent plus received) without a successful run | Kept separate from received conversation counts |
| List progress | Count of tracked message scopes and oldest continuous list cursor | A list frontier is not full message-content coverage; invalid or legacy evidence stays explicit |
| Message details | Pending content tasks, due retries, affected scopes, oldest pending and next retry | Pending content prevents a complete-content claim; no data/legacy is not zero |
| Restricted chats | Disabled received scopes by finite public reason and numeric code | A source-access limitation, not a worker crash; no raw remote error |
| Active chat refresh / chat review | Last successful cursor update / reconciliation completion | A completed list review is not proof of message freshness |
| Remote sample | Cached bounded hot-message sample, checked/expiry/window/count | No implicit network request; expired/missing/unbound sample is unverified with specific reason. A matching sample only supports that sample; current remote identity remains unverified |
| Worker log window | Requested last-24h window, and retained observation start to observation end | Partial log, no events and truncation explicit; actual event span separate from query window; never claim continuous uptime |
| Completed rounds | `cycle` completion events within log window, success/failure counts | One background round runs the scheduler's task sequence, not all remote content; numbers can restart |
| Latest result | Most recent completed round/task in retained log, with absolute time and age | Label history explicitly; old events outside the window are still dated; no current phase inference |
| Success spacing | Longest observed interval between two successful completions in this log window | Need at least two successes; not downtime or a freshness SLA |
| Incomplete round | Step history without a following completion record | Could be interruption, retention or still-running work; explicitly no completion recorded, never current activity |
| Database failures | Retained failed sync_runs started within `[window start, observation]`, classified safely | Independent SQLite source/window; query failure is unavailable, never zero; retention may have removed earlier rows |
| Lock diagnostics | Occupied/abnormal reservations and finite reasons | Reservations never prove work; no cleanup or repair while reading |

All relative ages use the observation clock; absolute times share the declared
local zone. Same-day dates may use Today. Cross-day/year endpoints include dates;
DST ambiguity includes offsets. Worker statistics use one final observation
clock. Database run classification freezes its own cutoff before the read and applies an
upper bound. Activity is still evaluated after all reads, so an expired phase
cannot survive a slow query. The database range is not silently relabelled as the
shorter log range. Future and malformed
history must not become recent successful work; malformed result booleans remain
unclassified and never turn into a failure merely through truthiness. Such
unverified log results are history diagnostics and do not override independently
established target health, even when the log contains a foreign or old instance. Existing JSON fields keep their
meaning; additive source/window/evidence fields explain legacy `by_kind`.

Default text keeps important diagnosis visible, including unsupported source
counts, debt, unavailable evidence and historical failures. `--detail` adds
supporting timestamps, counts, history and lease breakdowns, while preserving the
same screen order. Neither mode includes raw DB keys, scope IDs, owners, private
paths or raw errors. All actions are suggestions; `status` remains read-only. Every suggested command
requires the same `--db` and `--log-dir` values as the invoking status command.
The screen says this explicitly instead of interpolating private paths or implying
that a bare follow-up may safely switch to the defaults. No-argument invocations
keep the same defaults. A missing/expired sample does not create a required-action
item: the screen separately labels a new live sample as optional.

## Synthetic whole-screen target (plain, 96 columns)

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health         OK · local service and database checks passed
  Background           Running · selected database verified
  Current work         Syncing · reviewing the conversation list
  Phase observed       Today 11:59:52 · evidence valid until Today 12:00:30

Coverage
  Stored messages      240 total · 40 sent · 200 received
  Conversation list    Initial discovery complete · Today 08:00:00
  Received chats       12 enabled · 0 awaiting a full-content cursor
  Message sources      13 enabled · 0 without a successful sync
  Message lists        13 tracked · oldest list cursor Today 11:50:00
  Message details      0 pending · 0 due for retry
  Restricted chats     1 · access restricted · code 230100
  Active chat refresh  Last success Today 11:59:40
  Chat list review     Complete · Today 11:45:00
  Remote sample        Not verified · cached sample expired

Attention
  Coverage limits      Restricted chats are excluded from enabled-chat progress.
  Command targets      Keep this invocation's --db and --log-dir values on all commands.
  Optional sample      npm run exo -- check --live for a new remote sample.

Recent history
  Worker log           Last 24h requested · retained observations Today 08:00–12:00
  Log completeness     Partial window · earlier observations unavailable
  Completed rounds     15 succeeded · 0 failed · 15 total
  Latest round         Succeeded · Today 11:58:40 (1m 20s ago)
  Latest task          Conversation list review succeeded · Today 11:59:40 (20s ago)
  Success spacing      Longest observed interval 4m30s
  Failed tasks         0 in the log window
  Open history         A round has task records but no completion record; see Current work.
  Database failures    0 retained failed runs · started in the last 24h
  Database window      2029-12-31 12:00–2030-01-01 12:00
```

This example defines the information hierarchy, not a pixel-exact golden. [Generated whole-screen examples](status-screen-examples.md) and terminal-width tests accompany implementation, including
healthy waiting, catch-up, empty database, stopped service, failures, old-only
history, missing evidence, color/no-color, 40-column output and DST transitions.
