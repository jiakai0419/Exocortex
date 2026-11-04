# Bounded resource source reads

Resource discovery reads at most 20 fresh and 20 historical candidates. Each
source remains limited to 128 KiB and the combined source page to 8 MiB. These
limits, the fixed scan horizon, shared request budget, per-read 2-second maximum,
and whole-command deadline are unchanged.

The default source-payload read must encode one JSON object per row in SQL and
use the existing framed JSON-lines reader. The SQLite CLI must not re-escape
large raw/canonical TEXT values in its `-json` output mode. Preserve every source
field, TEXT byte content, NULL, integer, and row order. Do not normalize nested
JSON or build a page-wide aggregate. The reader must observe its successful
COMMIT/end frame before accepting any rows; a valid prefix is not success.

Admission and small metadata queries retain their ordinary JSON reader. A test
injection of the row reader retains its existing raw-row interface; it must not
replace or silently bypass the optimized default path in real execution.

Every local read still obtains a fresh timeout from the existing command budget
and checks the deadline after return. A failed read cannot enter enrollment,
claim, remote request, publication, or a later local write. Deadline exhaustion
remains separate from the failure already observed.

Retain a bounded `read_diagnostic` adjunct on a resource report when the owned
read boundary produced one. It consists only of a fixed operation category and
the existing closed SQLite diagnostic schema. Keep it when a higher admission
helper converts the exception to a generic failure, and through worker summary
compaction. Do not retain SQL, labels, paths, identifiers, stderr or exception
prose. It is transient observation, not a queue-state update, remote result,
permission proof, or transaction/rollback receipt. Other ordinary exceptions
remain unknown unless their own boundary provides evidence.

Acceptance uses wholly authored long payloads, including Unicode, quotes,
newlines, NULL and framing-looking text. Compare the same fields and order,
exercise the actual default resource enrollment path, and preserve the 2-second
read and whole-command limits. Inject genuine read-boundary timeout/failure and
deadline controls; assert no later requests/writes and safe worker propagation.
Keep original failures and distinguish synthetic cost from production latency.

This change requires no migration, queue reset, manual image selection, retry of
denied/exhausted work, permission change or service configuration change. It
does not reconstruct lost historical diagnostics or first-complete timestamps.

The executable controls are `resource-source-read-wire.test.mjs` (actual default
SQLite path and enrollment, framing, exact fields and deadline) and
`resource-read-diagnostic.test.mjs` (owned diagnosis, swallowed admission error,
simultaneous deadline and real worker summary projection). A long card fixture
keeps its rendered content inside the existing renderer limit and places bulk
authored text in raw metadata; increasing the content limit to make a wire test
pass would weaken a separate contract. Existing resource/producer/idle/fairness
and framed-reader regressions remain required, followed by full verification.

## Literal NUL through storage and source fences

Read fidelity alone does not prove enrollment. A valid post can render a literal
NUL in its stored body. Sending that byte inside a quoted SQL program can truncate
or alter the comparison, so a source can be skipped while the scan advances.
The same common value encoder also feeds ordinary ingestion and replay writes.

For application UTF-8 TEXT containing NUL, the shared `quoteSql` value encoder
must emit a UTF-8 hex literal cast to TEXT. Only that representation changes;
all non-NUL values and NULL retain the exact previous SQL output. Never strip,
replace, truncate or normalize source content, and never weaken an exact source
fence into a prefix/hash-only comparison. The SQL program must contain no literal
NUL. This single encoding boundary covers source enrollment, claim/result fences
and incoming record writes without a separate resource-only quoting convention.

Keep the pre-write NUL wire test, but additionally require a real rendered NUL
post to traverse storage and actual resource enrollment. It must enter the
endpoint-unverified queue with zero requests, not silently vanish. Mixed normal
and NUL sources must enroll independently; changing only text after NUL must fail
the stale exact-source fence while stable neighbors remain eligible. Exercise
normal claim/result completion and source drift with authored resources and the
existing request/command budgets. This is not authority to download an unverified
post/card resource or reopen denied/exhausted work.

Native update preparation must also read its full predecessor, including text
after NUL. SQLite CLI `-json` truncates a raw TEXT column at that byte. The
observation-basis query therefore returns the closed record column set inside
SQLite `json_object`, then decodes it before evaluation. This changes neither
the predecessor's fields nor the full-row/generation CAS; the ordinary store
executor, transaction boundaries and execution budget remain unchanged. Test a
normal native update, equivalent observation and suffix-only competing update,
as well as rollback and the real messages JSON/terminal output. Do not treat a
truncated predecessor as a valid basis or relax its guard to make an update pass.

Executable gates are `sqlite-nul-text.test.mjs` (shared encoding, normal native
ingestion/update/equivalence, exact predecessor race, rollback and real CLI) and
`resource-source-nul-enrollment.test.mjs` (default enrollment, mixed sources,
suffix races and synthetic producer claim/result). Keep the original independent
counterexample as a baseline-negative/candidate-positive control outside Git.
Existing observation, history, storage-cost and resource suites plus full
verification are required; no separate deadline or native binary change is needed.
