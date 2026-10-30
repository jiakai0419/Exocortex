# Status closure query cost

The complete status snapshot includes bounded proofs for old failed list runs
whose details may have completed later. For each retained failure, the candidate
query must first restrict later successful detail runs to the same source and
scope. A result limit bounds returned candidates, not the number of unrelated
rows visited before finding them.

Both scope/start-time and status/start-time indexes exist in the application
schema. SQLite can choose the global status index for this correlated lookup and
repeatedly inspect successful history from unrelated scopes. The closure query
uses `+c.status='succeeded'` to exclude only the status predicate from ordinary
index-constraint selection. The scope condition remains available to the query
planner; this does not force a named index. Without the scope index the query
still returns the same evidence, but no similar cost improvement is promised.

Unary `+` removes SQLite type affinity. Here the column is TEXT and the right
operand is the fixed nonnumeric text `succeeded`; the accepted values are
unchanged. Synthetic comparisons also cover NULL, numeric, BLOB, differently
cased and space-suffixed values. This reasoning must not be generalized to
numeric comparisons.

The source/scope and later-ID fences, inclusive time cutoff, ascending candidate
order, 200-run proof budget, 101-candidate overflow detection, per-field limits
and 16 KiB complete-proof limit are unchanged. An exhausted or unavailable proof
remains unknown and actionable. No migration, statistics update, cache, remote
request or business-data write is added.

## Synthetic verification

Run `node --test tests/sync-status-query-plan.test.mjs` for the focused regression.
It creates all records from scratch in a temporary database and preserves the
application's competing indexes. Sixteen failed list runs and one later closure
are measured before and after adding 20,000 successful runs in another scope.
The regression control restores only the previous status access predicate.

Both complete proof rows and the complete status snapshot must be identical
between the original and optimized queries. The optimized VM work must remain
close to the small fixture and within a fixed synthetic instruction budget. The
regression control's cost is also reported; a future SQLite planner need not
reproduce the old inefficient plan to pass. SQLite's progress handler measures instructions in
1,000-instruction batches; wall times are printed only as diagnostic evidence,
never used as pass/fail thresholds. Each profiler process is bounded and uses a
read-only connection and transaction.

The existing tests retain exact proof-cell bounds and all semantic cases in
`tests/lark-run-progress.test.mjs`, including cutoff/identity failures, candidate
and UTF-8 byte overflow, and the unexamined 201st failure. A missing-index case
also checks result equivalence. Python query timings exclude process startup
and the SQLite CLI's JSON serialization; the separate actual-snapshot test
continues to constrain that serialization's per-cell payload size. These
synthetic results do not establish a production latency guarantee.

## Same-scope closure cost

The scope predicate alone does not bound work over ordinary successful runs in
that scope. The retained-failure budget is one materialized narrow
relation of the same highest 200 IDs selected by the original `where` condition.
A distinct source/scope relation restricts a separately materialized candidate
pool. The pool keeps only ID, source, scope and parsed start/finish times; it
classifies the original success/details predicates once, without caching wide
metadata, cursors or error payloads. It is a conservative SQL candidate relation,
not a semantic `closes` result.

Each failed run retains its later-ID, same-source/scope, start-time and cutoff
conditions, ascending order, and 101-candidate overflow detection. The cutoff
expression remains in that per-run selection, including when a caller supplies
an expression correlated with `r`. A count over those at most 101 narrow IDs
precedes the wide payload join. Only a non-overflow proof reads the selected wide
fields; a filtered aggregate never serializes an overflowing candidate set.
The existing per-field character limits and complete UTF-8 byte limit remain.
The query stays one read statement/snapshot with no schema, index or cache write.

The fixed scope relation and budget are materialized once per evidence query,
not re-expanded for each retained run. A `CROSS JOIN` keeps the narrow scope
relation as the outer loop, so the planner cannot choose unrelated successful
history first. No named persistent index is forced. The complete status snapshot
has its existing separate recent-run and failed-transition evidence queries;
each has its own budget and pool in that one statement. Verification therefore measures the complete query, returned proof bytes,
VM instructions and compiled statement size, including many same-scope ordinary
successes and a separate large failed-run population. Differential controls
retain exact proof ordering/values, raw failures, unknown cases, malformed
metadata, time boundaries, absent indexes and correlated cutoffs. A narrow pool
still grows with real detail candidates; this repair is not a constant-memory
or end-to-end latency guarantee for unbounded retained history.


The added authored population gates use 200 failed runs plus 1,000, 5,000 and
20,000 same-scope ordinary successes, and a separate 12,000-failure population.
On SQLite 3.51.0, the 1,000-success closure query falls from 22,746,000 to 107,000
VM instructions. The 20,000-success complete snapshot uses 719,000 instructions;
the large failed population's closure query falls from 47,662,000 to 2,726,000.
The fixed proof membership test allows planner margin but still rejects that
prior repeated-work pattern. All earlier cross-scope limits remain unchanged.

The same authored schema's complete snapshot compiles to 2,746 instructions,
compared with 3,237 before the repair; its SQL source is also smaller. These are
compiled-code and VM-work measurements, not a claim about peak SQLite heap use.
A wide-metadata/cursor/error fixture retains count-overflow unknown without
serializing its wide candidates. Differential tests freeze the previous SQL
builder and compare complete rows/proof strings, including row-correlated
cutoffs; a separate actual `buildStatus` snapshot comparison changes only its
two proof fragments and compares all returned JSON cells. No production rows
or aggregate sizes are used as fixtures. Local elapsed times remain diagnostic,
not pass/fail SLOs; a dense pool of real detail candidates can still require
bounded per-run selection work and temporary storage.
