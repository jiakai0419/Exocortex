# Bounded SQL projection cost

This repair is local and not released. Base: d6bd290 (product code 9c65ae4).
The independent synthetic probe found 4,210,787 compiled instructions and
450,010,928 bytes for one ordinary upsert, versus 78,046 / 7,870,752 on 563.
Account retention attached to the correlated name-merge CTE graph multiplies
upstream compilation. This is a storage regression, not only a CI timeout.

## Contract and ownership

The integrator owns record-storage.ts and generated output. Account/name
validation rules are preserved; no migration, API budget, identity policy,
permission, status or renderer change is planned. Independent reviewers read
the phase contract and existing negative controls; they do not edit shared
modules. All performance input is authored synthetic data.

Name projection and account-proof retention must have a separate materialized
input. Freeze the final canonical once per source/external identity and reuse
it for differences, write-effect counts and the record write. Incoming raw and
canonical bytes remain text, never JS-parsed/reserialized as an optimization.
Account retention keeps every existing source/identity/duplicate-key, exact
numeric token, acquisition-clock and clear/conflict condition.

Write paths keep the existing transaction and run/account/observation fences;
no network call enters a transaction. Internal TEMP stages are connection-local
and bounded by the existing input batch. Direct upsert callers consume changes()
after the record INSERT, so subsequent cleanup must not replace that count.
No-op inputs must preserve updated_at and original canonical bytes. New records
must not evaluate a needless old-record retention path. First-seen scope and
source/version admission must remain unchanged.

Read-only replay review keeps the existing -readonly + query_only snapshot.
It cannot create TEMP tables or weaken the readonly reader. Top-level
MATERIALIZED phases may be used only if EXPLAIN proves upstream compilation is
not duplicated through correlated references. Review and commit must still
produce identical effective projection and stable approval hashes.

## Implementation

The two projection phases use top-level MATERIALIZED CTEs keyed by the exact
`(source_id, external_id)` pair. The account helper receives the name result as
a materialized TEXT column and still runs separately for each original row.
Its internal single-row recursive scans are not flattened across a batch.
The final byte-preserving comparison runs only after both phases; the name
phase retains the original account context needed for failure diagnostics.

The direct upsert keeps one record DML statement per normalized input, so
existing callers can read `changes()` immediately and retain their 0/1 result.
The run-commit path freezes the computed canonical in a connection-local
`__record_projection` table and reuses it in effects and mutation. Its lifetime
matches the existing incoming/acceptance/effects TEMP tables in that connection.
Neither path opens a new transaction or performs post-write cleanup DML.

Both write paths freeze their existing admission predicate before projecting.
Rejected records bypass both projection phases: a lower source version must
remain a harmless rejection even if its unadopted name would fail a projection
guard. Accepted equivalent records remain accepted for detail-debt completion
without executing an UPDATE. Read-only review keeps its original preview
semantics and creates no TEMP tables.

## Validation gates

Compare the same synthetic input across baseline, old candidate and repair:
compiled instructions, statement memory, prepare/step time, fresh insert,
conflict update and no-op, plus bounded batches. Measure whole new multi-stage
programs rather than stripping setup and reporting only the cheap final INSERT.
Use structural instruction/memory bounds as regressions, not flaky wall-clock
microbenchmarks alone. Preserve all original assertion inputs in affected
identity, account proof, lossless JSON, replay approval, version, CAS/fence,
write-count, updated_at and caller changes() tests. Then run complete verify,
independent frozen review and exact-SHA CI before any release decision.

## Local measurements

On the same macOS SQLite 3.51.0 build, the full single-record direct operation
(including its transaction and identity guard) compiled 78,179 instructions on
563, 4,210,920 on the regressed candidate, and 126,965 after the phase split.
Summed statement memory was 7,891,136 / 450,031,312 / 10,526,192 bytes respectively.
These are complete-program measurements, not just the final record INSERT.

Five alternating post-warmup samples per baseline/repair case cover all three
entrypoints, ordinary and native-observation inputs, and single-row
fresh/update/no-op variants. The maximum paired median preparation CPU ratio
was 1.574 versus 563; maximum instruction and summed statement-memory ratios
were 1.625 and 1.351. The run-commit path uses less compiled structure than 563
because it reuses the final canonical for counts and the write. An absent replay
target is measured only as a structural case, not as successful replay review.

The 2/12/50/100-row matrix separately measures full structure and execution,
including mixed batches; it is not an uncontended timing benchmark. Across
these measured cases the largest instruction ratio was 1.625 and summed
statement-memory ratio was 1.384. For the 100-row mixed fixture:

| Complete operation | 563 instructions | Repair instructions |
| --- | ---: | ---: |
| Direct upserts, one DML per record | 7,813,753 | 12,691,878 |
| Fenced run batch | 177,145 | 148,540 |
| Read-only replay projection | 79,420 | 128,204 |

The existing larger window-commit bound is not established by this matrix.
That path still emits one direct upsert per record; no claim is made that the
100-row measurement verifies a 10,000-record window or its peak process memory.

These measurements establish local SQL preparation cost, not production
message latency or CI completion time. The platform's global SQLite allocator
statistics were unavailable even after requesting memory statistics; they are
reported as unavailable, not zero. Per-statement memory, process peak RSS and
database cache/schema statistics are recorded separately in the local evidence.
