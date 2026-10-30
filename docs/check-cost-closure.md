# Local check cost closure

Implemented contract v0.2, following the v0.1 design written before code.
Base `26c31fb7d6110194f22025cd43e364a6b83fffd6`.
This isolated candidate does not modify production, permissions or the frozen
reviewed tree. The default operational `check` is a serial local collection,
not the development `npm run check` and not a network probe.

## Evidence and limits

An independent actual default check was externally interrupted at 60 seconds
without stage observations or output. A later bounded observer preserved that
first failure and found substantial cost in the status SQL and the message
snapshot wire path. The original failure's exact phase and concurrent machine
load cannot be reconstructed. A later completed invocation is not proof that
the original failure was harmless or that the service met its latency goal.

Authored tests demonstrate that the retained failure closure query repeatedly
filters same-scope successful history for each failed run. Its candidate and
proof limits bound matched output, not all rows visited. Existing unrelated-
scope growth controls do not cover this case. A separate authored wide-message
experiment must confirm the SQLite shell JSON formatting cost before that wire
path changes. Real rows, reports and SQL remain private and are never fixtures.

## Minimal implementation contract

1. Preserve retained run proof semantics: source/scope and later-ID fences,
   time comparisons, candidate ascending order, 101 overflow, 200 transition
   budget, per-field and 16 KiB proof bounds, unknown/actionable behavior, and
   a single read statement/snapshot. Avoid repeated history classification and
   correlated CTE re-expansion. A materialized narrow candidate relation may
   contain only the columns required to select IDs; obtain wide source payloads
   only for selected proofs. Do not introduce a migration, write, new index,
   unbounded payload cache, truncated proof or broader success rule.
2. Preserve message page selection, source TEXT bytes, numbers/nulls, every
   evidence branch and metadata, schema fences, atomic read, output byte cap,
   process timeout, error diagnostics and public JSON/text. If the shell's outer
   escaping is the measured cost, an internal single-column row-JSON encoding
   may avoid it. SQL must encode the row; source JSON strings remain strings.
   The reader must reject malformed, truncated or non-object frames. No new CLI
   option, remote call, dependency installation or Python product reader.
3. Do not raise any timeout or reduce the completeness denominator to make the
   check finish. Do not redesign status/renderer output or replace a missing
   identity with a guess. The default check's lack of a total deadline and its
   original uninstrumented timeout stay documented; this change addresses the
   two demonstrated cost mechanisms, not a universal runtime guarantee.

## Ownership and gates

The status route owns `lark-run-progress.mjs`, its narrow performance tests and
the related status query cost documentation. The message route owns proposed
wire encoding/decoding and its narrow tests; main reviews the shared readonly
helper interface before integration. Main owns this contract, integration,
actual read-only stage observations, full validation and code-only recovery.
Routes work in separate copies; no frozen or production tree is edited.

Before freeze: demonstrate baseline red/candidate green with identical authored
same-scope and cross-scope populations; compare complete proof/snapshot values,
boundary and malformed evidence; measure full query work and compilation, not
only a subquery. For the wire, compare wide and narrow messages with Unicode,
quotes, NUL, invalid source JSON, JSON-looking TEXT and nulls; retain all source
bytes and ordering, and test process/error/output limits and malformed frames.
Run original affected tests and full generated/build/type/syntax/tests with the
existing libjpeg prefix. Preserve process-permission failures without bypass.
Actual CLI check and messages should have bounded private stage observations,
full fixed denominators and source-drift disclosure. Those are read preservation
and timing evidence, not completion of undeployed resource or name jobs.

All packages and Git changes contain code, documentation and authored synthetic
tests only. A new SHA requires original independent review and later release
approval; production remains on its previously deployed version.

## Implemented boundaries and validation

The run-proof query materializes its highest-200 membership and distinct scopes
once, then classifies a narrow closure relation once for those scopes. Each
failure still selects at most 101 ordered IDs using its own later-ID and time
conditions, including a caller-provided correlated cutoff. A window count carries
the candidate overflow decision through one traversal; the conditional join does
not fetch wide proof fields when that count exceeds 100. The existing aggregate
and UTF-8 proof limit retain NULL for overflow and unknown evidence. All stages
remain inside the same SELECT. There is no persistent pool, index or migration.

The message data SELECT now supplies SQL-encoded complete row objects to an
internal framed list-mode reader. The payload remains opaque TEXT (`payload ||
''` removes JSON subtype without changing NULL). Fixed begin/end markers frame
the entire result; END is emitted after COMMIT. Missing, repeated or partial
frames, extra output, raw NUL and non-object rows fail closed, even when a prefix
is parseable. Child exit/error/signal and output limits are checked first.
The new path explicitly selects `-batch -init /dev/null -noheader -list`; the
original JSON helper and every other default caller retain their original argv,
input and parsing. Schema discovery and injected `sqliteJson` interfaces remain
unchanged. The shared execution/diagnostic helper retains 30 seconds and 50 MiB.

Authored controls reproduce the old same-scope and large-failure amplification,
compare complete old/new proof and status snapshots, and bound compiled opcodes
as well as executed VM work. Existing performance assertions and the 100-million
VM progress guard remain; the new profiler also stops after nine seconds. New
tests retain all unexamined failures as unknown/actionable. The separate wire
controls compare all fields of one frozen SQL result, including its identical
observation time, and preserve invalid/duplicate-key/large-number source TEXT,
Unicode, escaped NUL and ordering. Protocol tests cover truncation at whole-row
boundaries and successful-looking output from failed child processes.

On the supported SQLite CLI build, synthetic high-escape TEXT measurements grow
approximately quadratically in the old JSON emitter; plain wide ASCII does not
show the same cost. This is an observed implementation characteristic, not a
claim about every SQLite version or its exact internal algorithm. The framed
path avoids that outer re-escaping without changing the public message format.
SQL classification and message wire costs are separate mechanisms; no synthetic
measurement establishes production percentiles or recovers an earlier missing
stage trace. Actual private acceptance must retain source drift and its first
failed observations rather than retry until reports look identical.
