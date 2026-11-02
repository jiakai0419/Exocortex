# History preparation: fresh account reads and finite failure evidence

## Scope before implementation

This change is limited to the existing bounded known-record history command.
It removes redundant account aggregation within one validation boundary and
retains finite failure evidence at the point where an operation fails. It does
not increase request, SQLite, command, or worker budgets; change source/account
ownership rules; relax transaction fences; or turn an unknown failure into success.

The baseline command performs three account aggregation reads per checkBinding,
and invokes that check before and during each record commit. A six-row bulk
bracket therefore performs forty-one aggregations, including five preparation
reads. These repeated scans are avoidable, but reducing them does not establish
the cause of any historical failure whose underlying exception was discarded.

## Account validation contract

A new internal paired reader captures one fresh local account snapshot and
evaluates the existing self/sidecar/initial/sent-actor rules against that snapshot.
It returns both the snapshot and the admission result. The ordinary public
reader keeps its existing result shape and behavior. No caller-supplied cached
snapshot is accepted. Database identity is checked around capture/evaluation.

The three SQL counts used only to decide whether the source is empty become
EXISTS expressions. The exact sent-record, distinct-actor, and conflict
aggregations are retained. A local sidecar is rechecked after the paired read,
including deletion of an originally present sidecar; the last valid observation
sets sidecarVerified. This closes an inherited between-read deletion gap without
claiming filesystem atomicity against non-cooperating writers.

Each write-admission assertCurrent invokes that paired reader afresh and returns
the snapshot it actually validated. The history check compares this returned
snapshot with the original history binding, instead of scanning again twice.
The pre-commit check and the storage reviewBeforeCommit check both remain. There
is no reuse across remote requests, records, transactions, source mutations,
sidecar changes, or database replacement. The SQL account/source/scope/record CAS
and shared request lease remain authoritative inside the transaction.

## Failure evidence contract

The command must distinguish preparation suboperations, local read failures,
trusted transport outcomes, local admission stops, and unknown exceptions. A
budget stop and an operational failure are independent facts. An earlier
failure must survive a later budget wrapper; committed prefixes remain explicit.
Only locally produced typed/registered evidence can supply a cause category.
Arbitrary message, stack, SQL, path, identifiers, payload, error fields, or nested
cause objects must never be serialized. Unsupported causes remain unknown.

Use the existing closed history diagnostic projection, with a bounded extension
for preparation operation and locally verified failure category if necessary.
Keep existing outer stage values compatible. The new fields are observational:
they cannot grant admission, change retry, advance a cursor, or declare success.
Local pre-execution failures must not be reported as remote API rejections.

## Ownership

The integration owner edits history orchestration, failure evidence protocol,
related diagnostics, and final generated artifacts. The account-read subtask may
edit remote-account-binding.mjs, lark-write-admission.mjs, and focused account
reader/admission tests. It must not edit history.mjs or shared diagnostic files.
All implementation and wholly synthetic tests remain in the isolated candidate.
Production code, data, service, queues, credentials, and permissions are unchanged.

## Required verification

- Real SQLite and real history orchestration: exact aggregation counts, valid
  six/twelve-row progress, unchanged records, checkpoints and commit receipts.
- Fresh mismatch after capture/between records/inside reviewBeforeCommit: initial
  binding, sent actor, sidecar, database identity, source/scope/record version.
  Each must fail closed with existing CAS/rollback and committed-prefix semantics.
- Operation failure before any commit and after a committed prefix; remaining
  budget and simultaneous cutoff; direct admission stop; cleanup failure.
- Transport started/not-started/unknown, finite API result, parse/read failures;
  secret-looking synthetic text must never appear in CLI or worker projection.
- Actual maintenance CLI JSON/exit and worker summary, normal output parity,
  original budget thresholds, complete repository checks and independent review.

## Limits

Previously discarded exception details cannot be reconstructed by successful
reruns. No historical unknown is relabeled as timeout or permission denial. Live
messages and retained evidence remain private and are never test fixtures. This
candidate is not authorized for push or deployment.

## Implemented diagnostic projection

A process-local WeakMap records evidence only at the existing transport error
factories, required local reads, local admission constructors, synchronous
history operations, and the two owned cutoff-wrapping sites. The report retains
the original outer stage plus an optional finite operation and transport receipt.
No arbitrary cause chain or copied error prose can create trusted evidence.
Required history account reads rethrow their actual SQLite error when a generic
account helper would otherwise return null; optional priority-hint reads retain
their existing fallback policy.

Worker projection now retains the existing closed command-budget receipt,
validated committed-with-cleanup-failed receipt, and an explicit unknown failed
target commit state when a storage call has no acknowledged result. A five-row
returned prefix cannot prove whether a sixth transaction committed. The new
fields do not replay that transaction or change its outcome.

The synthetic opening-self timeout reproduces the broad zero-progress symptom
with ample whole-command time. Different synthetic SQL failures at cutoff retain
different categories and the same six-row committed prefix. Neither is evidence
of the underlying cause of an earlier uninstrumented production failure. A
separate exception thrown by existing finally cleanup can still replace an
original error; this patch does not change that unrelated exception policy.


## Conservative local-admission evidence

A constructor-registered local stop remains a pure admission diagnostic only
while the actual error has no cause or errors member, including inherited or
accessor members. Adding either member makes the cause unknown without reading
its value. Recheck this condition when observing or preserving the error; an
earlier operation observation must not freeze a now-ambiguous category. Owned
wrapper registration still preserves genuine failure evidence. CLI result,
unknown-commit handling, time endpoints, and all budgets are unchanged.
