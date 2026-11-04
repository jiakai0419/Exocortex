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
