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
