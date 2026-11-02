# Bounded recovery and resource completion

Design contract v0.1, before implementation. Base: `7c60503`.
This candidate is isolated. It does not authorize deployment, account changes,
queue resets, manual target prioritization, or relaxed source acceptance.
Examples and tests must be authored synthetic data. Operational evidence stays
outside Git, including aggregate observations derived from real messages.

## Scope and ownership

- Main owns this contract, worker idle admission and capacity integration,
  worker-facing resource summaries, generated artifacts and final validation.
- Resource diagnostics owns `enrich-resources.mjs`, `resource-work.mjs`, a
  migration numbered 022 if needed, and its focused synthetic tests. No worker,
  source acceptance, request-session, JPEG or permission changes.
- History recovery owns the admitted history acquisition path in
  `history.mjs`/`sync-runner.mjs`, the relevant adapter call boundary if needed,
  and focused synthetic tests. No worker or shared storage-policy rewrite.
- Service-target diagnosis remains separate and read-only until actual process
  evidence distinguishes its hypotheses. Do not change status presentation.

## Shared limits and invariants

The existing idle slice retains its original monotonic deadline, at most
12 CLI attempts and 6 self observations. The 25-second bound, interval-derived
shorter bound, cleanup reservation, per-request lease/cooldown, and minimum
resource admission remain unchanged. Time starts once and never resets.
Each resource unit retains its own three-CLI/two-self maximum. Unknown or
incomplete execution/commit outcomes remain unsuccessful; no refunded grant
may be inferred from missing evidence.

The forward cycle stays partial when details remain unresolved. Recovery
eligibility is separate from health. Missing account/source/version/generation
proof, process failure, transport pressure, ambiguous commit, or source-policy
drift must not be relabeled as the narrow saved-list/detail-backoff case.

## Resource capacity

After an eligible resource-only unit succeeds with a complete, matching budget
receipt, the same slice may consider at most one additional resource unit.
It must use the actual remaining time and call balances, retain the minimum
admission and inter-unit gap, and stop on failure or uncertainty. No parallel
resource process is introduced and no later foreground target is extended.

An additional unit does not take a second lane-age grant or jump ahead of an
unserved eligible lane. Resource task selection continues to use the existing
fresh/oldest policy and its transaction/CAS. No real message identifiers are
special-cased. Summaries must account for both units and every consumed call;
the final result must not overwrite an earlier failure with a later success.
Single-unit callers retain their behavior and limits.

## Finite resource failure evidence

Keep a finite producer stage and finite reason from the actual selected unit,
including local byte/format/decoder failures, request admission/execution,
account closing, and publication. Arbitrary exception text, paths, identifiers,
response bodies and credentials must never enter this evidence or summaries.
Persist evidence atomically with the exact task transition and its existing
source/account/claim fences; preserve it across restart. Older rows have
explicitly unknown evidence. A successful new result must not retain a stale
failure as its current outcome.

The queue's existing retry/permanent-decision rules are not weakened. A reason
string alone does not prove an authenticated remote refusal. Permanent remote
denial still needs the established execution receipt and closing account
observation. Evidence unavailable from old attempts cannot be reconstructed.
At the worker boundary, finite evidence is additive and has no target data.

## Known-record history recovery

The strict saved-list/detail-backoff proof may admit bounded known-record
history recovery, sharing the original budget and lane fairness. It must not
enable unbounded legacy fallback, general discovery, a source-policy bypass,
or history after arbitrary foreground failure. The exact admissible history
selection must be documented and tested before wiring this exception.

Where the admitted history path currently drops same-version conflict evidence
before storage can evaluate it, capture may be enabled only after account,
source, context, local generation and complete-tree prerequisites are known.
Ordinary detail acquisition remains unchanged. Confirmation requires two
independent acquisitions and all existing version/context/generation/CAS
guards. A later real detail completes debt through the existing writer result;
neither a history opportunity nor the first candidate clears pending work.

## Validation and release gates

Use synthetic actual CLI/SQLite counterexamples for unused slice capacity,
fairness under continuous arrivals, second-unit budget/clock/cleanup failure,
typed failures and restart persistence, source changes and denied routes, and
the existing-record history recovery cycle. Unknown or changed observations
must remain negative controls. Preserve the existing semantic assertions.

Complete the generated/build/type/syntax/full-test recipe for one frozen SHA;
obtain independent correctness and timing review, and save a restorable bundle.
Actual read-only messages JSON/text must retain fixed membership, identities,
source fields, order and layout. Observed completion is distinct from resource
registration, successful downloads for other records, or an empty new-message
sample. A new candidate needs publication approval; production remains on the
already approved version while this work is isolated.

## Implementation notes

The admission mode is now `known_records`, not `resources_only`. The predicate
that earns it is unchanged; only the bounded existing history lane joins the
resource lane. Remote sampling stays disabled in this exception. The truthy
logical event continues to suppress the unbounded core fallback on every
untrusted foreground failure. The original restriction was introduced in
`89a546e07327b857b5efd2a00fb4252d593d4be3`; this change restores the narrow
known-record opportunity without restoring the former null/fallback behavior.

The resource surplus slot runs only after every originally eligible lane has
been served. In addition to the unchanged minimum admission, it reserves the
first unit's measured elapsed time plus the existing cleanup margin and request
gap. This is conservative admission, not a promise that the next unit takes the
same time: its guardian deadline remains authoritative. At most two resource
units run per slice; their individual finite receipts are retained under
`resources.units`, with totals only when both receipts are trusted. A failed or
untrusted later unit cannot make the aggregate successful or invent zero usage.
A single-unit result retains its existing fields. First-service sequence changes
once per slice, regardless of surplus work.

Known-record history validates the selected native record, ordered version,
observation generation and captured database/source/scope/account admission
before collecting an equal-version conflicting complete tree. The adapter's
identity/tree limits and storage's independent-observation/CAS rules remain
unchanged. The first acquisition remains a candidate, and history acceptance
only rebases the matching pending descriptor. A subsequent ordinary detail
receipt is still required to finish that task. Generic legacy detail failures
remain unknown until a new legitimate observation explains them.

The logical history/idle event also reduces the complete result: a failed
resource, untrusted receipt, failed local admission, or unavailable/rollback
clock makes the step summary, step, cycle and worker unsuccessful. Earlier
confirmed units remain in the report. A valid budget stop is not by itself an
unknown commit; missing or malformed evidence is never promoted to success.
This distinction is checked at the actual worker/core event boundary, including
a second-unit failure after a first successful publication.
