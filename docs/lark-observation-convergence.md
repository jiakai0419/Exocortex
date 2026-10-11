# Source observation and detail convergence

The accepted record, ambiguous historical candidate, and pending detail descriptor
have distinct jobs. These changes reuse those bounded slots; no schema migration
or new background API request is needed.

## Complete root admission

Both a bounded replay window and a queued detail retry fetch a complete tree,
validate the same root identity/version relationship, and normalize the **refreshed
root** with that response's subtree. At equal versions, complete source evidence
must be equivalent under the existing source relation; sender and unknown fields
are not ignored. JSON object ordering, normalized timestamps and absent/empty root
parent metadata may differ. Meaningful parent identifiers remain source evidence.
An authoritative higher version is adopted as a whole; a regressed version or
changed message/chat/creation identity is rejected. The rendering boundary also
rejects an inconsistent root supplied directly with its expansion.

The acquisition deadline, paging/item budgets, name scope and account admission
remain responsibilities of their existing callers. A complete bounded response is
an observation, not proof of a globally atomic remote snapshot or client UI state.

## Historical confirmation

An ordinary observation equivalent to the pending historical candidate may retain
its candidate JSON, local generation, policy, context, attempt and observation time.
It cannot create a history confirmation or refresh the first observation's time.
The sidecar's last-observed evidence still reflects the ordinary attempt.

Confirmation requires a later independently acquired history observation with the
current context, unchanged local generation and current policy. An old context
retained through ordinary retries is inert if the next history context differs.
A different candidate or changed local generation does not inherit qualification.
The row and evidence-generation transaction guards also fence concurrent/ABA writes.

## Pending detail coordination

Before network acquisition, history snapshots a pending descriptor and its list
progress generation. After accepting a complete record C, its transaction may
refresh that still-matching descriptor to C. The CAS includes raw descriptor,
fingerprint, version, creation time, pending state and list generation. It does not
overwrite a concurrent D or an intervening B → D → B transition. It never downgrades
a numerically newer queued version. If CAS fails, debt remains for a later sweep.

Only descriptor fields and retry availability change; attempts are retained and
list generation advances to fence older runs. Task status remains pending. History
does not advance list/full cursors, coverage, or success markers. A fresh accepted
detail retry supplies the normal completion receipt and then may promote coverage.
A former merge whose accepted type is now ordinary can still obtain that receipt.

No permanent user hold is introduced. Session-specific manual repair constraints
do not freeze normal history or forward ingestion.

## Regression evidence

`tests/lark-convergence-interleaving.test.mjs` uses only synthetic SQLite fixtures
and injected API transport. It exercises actual CLI replay dispatch/commit plus:

- Root sender/body/identity conflict and version regression: both fetch routes
  reject; CLI preserves existing records and detail debt.
- JSON/timestamp representation and newer full root: both routes agree; CLI stores
  a root actor identical to the expansion root actor.
- Detail → history → detail → history: the original qualified candidate is retained,
  the second independent history accepts, and a later detail completes coverage.
- Context, generation and candidate changes cannot borrow old qualification.
- History C rebases queued B; a stale B result fails its transaction.
- Concurrent D and descriptor ABA preserve the newer task; later history/detail
  can converge without history claiming forward coverage.
- An accepted ordinary replacement remains debt until detail verifies it.

Existing lost-acknowledgement, disabled-source, account/context drift, source
comparison, paging and lease tests continue to apply. This is isolated synthetic
validation, not evidence about any user's message or current API contents.

The SQLite schema remains unchanged, but the old writer does not implement these
state transitions (including an ordinary descriptor for a former merge). Schema
readability alone is not a safe writer rollback guarantee; preserve the current DB
and use a reviewed compatible writer or corrective forward release.
