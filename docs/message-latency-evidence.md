# Message latency evidence adapter

This independent candidate performs no database, network, clock read or
publication action. It adds no production instrumentation. Integration must
persist each stage with the transaction whose completion it denotes. Never
manufacture collection, readiness or publication time from `records.updated_at`,
task attempts, or a `messages` read.

`measureMessageLatency` accepts one JSON object encoded as a string, at most
8,192 characters and 16,384 UTF-8 bytes. Duplicate or unknown keys, invalid
numbers and oversized fields are rejected. The string boundary makes parsing
and validation bounded before materialization; caller-controlled objects and
getters are not executed.

The object contains `current`, optional `source`, `collected`, `identityReady`,
`published`, and optional `clockToleranceMs` (default 1,000; at most 60,000).
`current` is `{ recordKey, sourceVersion, identityGeneration, contractVersion }`.
Source and collection `binding` contain only `recordKey` and `sourceVersion`;
readiness and publication bindings contain all four current fields. Thus new
identity evidence does not invalidate actual collection time, but old readiness
cannot complete a new identity generation or source version. The two latter
stages require `complete: true` from the shared completeness contract. This
module does not decide whether names or content are complete.

Source has `atMs`, `precisionMs` (1 through 86,400,000), and optional `clockEpoch`
and `clockDiscontinuity`. A rounded-down minute timestamp denotes the inclusive
interval `[atMs, atMs + 59,999]`, not an exact event. Local stages have `atMs`,
optional paired `processKey`/`monotonicMs`, optional `clockEpoch` and
`clockDiscontinuity`. Epoch, process, record and version strings are nonempty,
bounded to 128 characters and cannot contain a NUL.

A clock epoch is the producer's independently verified continuity and
comparability assertion, not a constant added to obtain a passing result.
Without equal verified epochs, cross-clock durations remain unverified.
Same-process monotonic stamps provide elapsed time. A negative elapsed duration,
explicit discontinuity, or wall/monotonic discrepancy above tolerance marks the
interval anomalous. This pure function cannot discover an unreported forward
clock jump between processes; integration must collect that evidence.

End-to-end latency is composed from source-to-collection and the verified local
processing chain. The complete collection-to-publication interval is checked
in addition to each adjacent stage: two individually tolerated discrepancies
cannot conceal accumulated drift. A supplied whole-process monotonic interval
must also agree with the sum of the local stage intervals; conflicting evidence
fails closed. Accepted monotonic elapsed time is propagated into the result even
when its wall-clock difference is within tolerance. Tolerance never rounds that
elapsed time away or allows the end-to-end duration to understate known local
processing. Source precision bounds are propagated through that same chain.

Output contains fixed states/reasons and numeric intervals only. Input bindings,
IDs, version strings, process keys, message text and absolute timestamps are not
returned. Missing evidence remains unknown. A source precision interval that
overlaps collection retains signed bounds and is uncertain, rather than being
clamped into an apparently successful sample.

Metrics are source-to-collection, collection-to-identity,
identity-to-publication and source-to-publication. Publication metrics require
valid collection and readiness evidence in temporal order. A cached identity
observation can predate collection; the message-specific readiness transition
cannot. Collection is the first committed acquisition of this source version,
not necessarily the record's original `received_at` if its version changed.

`classifyLatency(metric, thresholdMs)` uses an explicit caller-provided threshold
and reports `within`, `exceeded`, `straddles`, or `unknown`. Only verified,
nonnegative measurements can pass. No threshold here is an approved SLO or
service setting. `measureMonotonicBudget(startMs, endMs, limitMs)` independently
checks finite monotonic samples and reports `within`, `exhausted` or `invalid`.
It never interprets requested sleep duration as elapsed time.

`delayCause` remains `unclassified`: large elapsed values and worker-log gaps do
not prove sleep, upstream invisibility or program queueing. These diagnoses need
independent awake-state, upstream visibility and durable queue-stage evidence.

Synthetic acceptance covers missing/stale/incomplete stages, version and
generation changes, minute precision, monotonic and cross-process clocks,
clock reversal/discontinuity, ordering, bounded inputs and request deadlines.
It does not establish production publication latency or deployment readiness.

Local validation: all 19 tests in `tests/message-latency.test.mjs` pass, and
`npm run typecheck` exits successfully in the isolated candidate. No full build,
production read, migration, service operation, or remote request was performed
for this module. Independent integration testing remains required after callers
persist and supply the stage evidence.
