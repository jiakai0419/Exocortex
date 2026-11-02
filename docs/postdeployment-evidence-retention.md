# Preserve resource attempt evidence and the original SQL gate

Status: local follow-up to frozen 2020285. No production deployment is authorized.

## Resource evidence

A name-only update can change the broad source fence without changing the exact account/message/resource binding. With no new resource attempt, discovery must preserve the last attempted failure stage/reason and their original association. It must not manufacture a fresh remote rejection, reset counters, reopen exhausted work, or relax source/CAS admission.

The independent exhausted-invalid-image counterexample must pass unchanged in its assertions. Add controls for derived sender/recipient/name changes, true resource/account/source changes, fresh claims, success, permanent denials and rollback/CAS. Historical diagnostic evidence and applicability to the current source are separate facts; prefer the smallest representation that preserves both. No broad new diagnostic ledger or retry policy is in scope.

The minimal representation adds two nullable 64-character lowercase SHA-256 columns in migration 023: `failure_binding_key` and `failure_source_fence`. They identify the binding and full source observed for the retained finite diagnosis; the immutable task key retains its source/account/endpoint association. Existing 022 diagnoses keep NULL associations because their original association cannot be reconstructed honestly. No backfill infers an old observation from the current row.

Discovery updates the current binding/source fields while preserving the four diagnostic fields, including across a true binding change until a new claim. New claims and successful results clear all four fields within the original CAS. Recorded failures store the observed association in the original result transaction. A source-fence diagnosis remains a local observation, not evidence of a remote request. A pre-claim source mismatch preserves the last attempt fields and reports its local diagnosis as not persisted; a post-claim source mismatch records the claimed binding/source, never the changed source. The existing permanent-denial, retry, counters and exhaustion policies remain unchanged.

`resourceWorkFailureEvidence(task, currentIdentity)` is a read-only diagnostic projection. It requires an explicit current identity and reports `exact_source` only when source/account/work, binding and source fence all match; `same_binding` when only the full source fence differs; `different_binding` when an established task or resource binding differs; and `unknown` when either association is unavailable or malformed. Its finite fields and hash associations never authorize a request, denial, publication, retry or state change. Callers must obtain the current identity under their existing source admission rules rather than treating the task snapshot as a fresh record observation.

Compatibility with older writers is guarded in migration 023. The published 7c resource writer does not maintain diagnostic columns; 2020285 maintains stage/reason but does not know association columns. Two small AFTER UPDATE triggers clear all four diagnosis fields on a new running claim or a transition into successful available state, and clear only association hashes when stage/reason values change without corresponding hash changes. Non-NULL predicates make recursive trigger execution converge. The guards leave source/binding-only scans, state/retry policy, task identity, generation, counters and CAS unchanged. The old 202 writer can still erase stage/reason during its own non-permanent scan; these guards cannot recover that deleted evidence. Older writers can still lose detailed causes they never recorded; the guarantee is that a subsequent new reader never attaches an old association to their new attempt result. Synthetic compatibility validation executes those exact older writer sources with explicitly documented dependency-import adaptation; no production rollback or queue mutation is required.

## SQL primary read and calibration

Primary structural SQL tests must again execute the original single TextIO.read through the observation wrapper. Keep the existing 30-second timeout, 4-MiB output bound, SQL/opcode/memory/effects assertions and original error precedence. Chunk/read1/EOF observation is an explicitly separate calibration fixture and must not replace the primary path.

Use the independent method-dispatch negative control: when the original TextIO.read fails, the primary gate must fail; a successful chunk control is not primary evidence. Preserve malformed/multibyte/encoding/newline and error/cleanup controls with their correct path labels. Record bounded, synthetic-only failed input/fixture and finite startup fingerprints if required for future attribution, without broad environment dumps or changing product SQL/guardian.

The original 6be stdin-stage timeout remains unexplained. New successful runs must not be described as a root-cause fix. Keep initial independent matrix 14/17 and corrected-receipt 3/3 separately.

## Ownership and validation

Resource owner: src/maintenance/resource-work.mjs and related synthetic resource-work tests; propose any schema change to the integrator before editing. SQL owner: tests/sql-projection-cost.test.mjs and its profiler observation document. Integrator owns this contract, native copying, docs/resource-worker-scheduling.md, complete verification, actual read-only messages comparison and recovery bundle. No shared edits, production mutation, API requests, ps retries or change to frozen2020285.

Freeze a new SHA only after scoped controls and review; run one complete exact-SHA verification, retain every failure, and obtain the existing independent reviews. Unsupported process premises remain unverified. Production four images/app names/sticker and minute-scale completion are independent outcomes and cannot be declared repaired by these local changes.

If a local process-inspection test is explicitly restricted, do not retry it or
replace its process evidence. Record its body as not run, retain the previous
failure, and report that the local full-green gate remains unmet. This does not
change the repository test inventory or the unrestricted exact-SHA CI gate.
