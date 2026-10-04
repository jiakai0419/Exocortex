# Status screen contract

This design replaces the whole public `status` text screen. It preserves the JSON
schema and existing fields, adding evidence needed for honest human summaries.
All examples and tests are invented from scratch. No operational records,
screenshots, accounts, paths, IDs or log excerpts belong in this document or Git.

## Reading order and visual grammar

The default screen answers five questions: is local collection running, what is
working now, what is stored, what list work remains, and what needs attention.
Normal implementation evidence and commands belong in `--detail` / help.

1. **Exocortex status**: one final observation time and local IANA time zone.
2. **Health & current work**: local health, background service, verified activity.
   A normal result has no repeated qualification. Database association is shown
   only when it cannot be established (always available in detail).
3. **Messages & progress**: retained messages, enabled received conversations,
   content-checkpoint gaps and independent detail debt.
   Received conversation counts do not include the global sent-message source.
   Missing/invalid list evidence remains visible; raw checkpoint times are detail-only.
   Restricted conversations appear once, as a collection limit. Remote sample
   state remains compact; missing/expired sampling is not a local failure.
4. **Problems**, only when needed: database failure records, unavailable failure
   statistics, or abnormal/unavailable reservations. Do not repeat facts already
   visible above or add an
   empty “no required action” section.
5. **Background history**, detail only: unbound worker-log statistics and their
   exact observation limits. **Diagnostics** adds raw checkpoint summaries,
   detailed source reasons, evidence timing, database failure windows, commands
   and target-preservation instructions. No raw JSON or private identities.
6. `--format json` preserves every existing field and meaning. `--logs` remains
   explicitly private.

### Default-versus-detail decisions

Normal health has no `local sync checks only` suffix. A matched database has no
`selected database verified` suffix. Oldest list checkpoint, command targets,
optional remote-sample commands, zero database failures and all unbound log
history (including failures) move to detail. Restricted counts and their exclusion appear once.
Unavailable, positive or malformed evidence is never converted into normal zero.
Unbound log failures remain detail-only diagnostic facts with their source stated;
they cannot lower or raise the selected database's health, even if recent and explicit.

### Progress contract

Default progress is limited to known facts: initial conversation discovery not
yet complete, enabled received scopes without a content checkpoint, message
sources without a successful sync, and pending message details with retry counts.
A content checkpoint's presence is not fixed-target completeness. Pending detail
sources include the global sent scope and are never called conversation counts.

The raw oldest list checkpoint moves to detail. It summarizes only existing
tracked rows; it does not prove every conversation is covered through that time.
No rolling checkpoint ratio, fixed-target coverage option, cache or additional
query is introduced. Existing `check --through` remains unchanged. Continuous
successful-window coverage from the persisted baseline is a separate validation;
the default screen must not substitute list positions for that result.

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
| List progress | Default shows unavailable/invalid evidence; detail shows tracked source count and oldest checkpoint | Existing tracked rows only, not full message-content or continuous interval coverage |
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
unclassified and never turn into a failure merely through truthiness. All
unbound log results are history diagnostics and do not override independently
established target health, including explicit true/false results from a foreign,
old or seemingly current instance. Existing JSON fields keep their
meaning; additive source/window/evidence fields explain legacy `by_kind`.

Default text keeps unsupported source counts, detail debt and unavailable evidence
visible once. Database failures appear by default only when positive or unknown;
zero is available in detail. All unbound log history, including explicit failures
and failure totals, remains in detail with its source and observation window. Neither mode includes raw DB keys,
scope IDs, owners, private paths or raw errors. `status` stays read-only.
Commands in detail require the same `--db` and `--log-dir` values; that requirement
appears beside commands without printing private paths. Missing/expired samples
remain optional, with no command suggestions in the default screen.

## Synthetic whole-screen target (plain, 80 columns)

The following invented target precedes implementation; generated exact examples
are maintained separately in [whole-screen examples](status-screen-examples.md).

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health       OK
  Background         Running
  Current work       Waiting · between background rounds

Messages & progress
  Stored messages    240 total · 40 sent · 200 received
  Received chats     12 enabled
  Message details    2 pending · 1 due for retry · 1 source
  Restricted chats   1 excluded · access restricted
  Remote sample      Not verified · cached sample expired
```

Counts/times are invented. Known debt is not a fixed-target completion measure.
Scenarios cover waiting, syncing, missing/invalid progress, detail debt, empty DB,
stopped service, failures, old/unbound logs,
missing evidence, 40-column output, color/no-color and DST.
