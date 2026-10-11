# Pending detail observation contract

A merge-forward list descriptor is coverage debt, not a placeholder record. If
its first complete detail has a different root at the same numeric version, the
old strict comparison rejects it. History only visits existing records, so this
orphan debt previously had no confirmation producer.

Only a pending task with no existing record may acquire a complete conflicting
snapshot through the normal bounded detail retry. It uses the same observation
evaluator as record history. The first complete conflict stores one bounded
candidate on the task; a later independent detail acquisition may accept it
only when the entire root and expansion agree, the descriptor generation and
policy/account/database/source/scope context still match, and the first
observation predates the second acquisition. Repeated observation is not proof
that a source is latest. Existing-record detail retries remain non-confirming.

No record enters the writer before acceptance. First acceptance and the real
complete detail receipt commit atomically. List coverage advances independently;
full coverage advances only when every pending task is complete. History remains
record-only. Manual repair deferrals do not freeze normal observation handling.

The durable task candidate uses the existing observation policy and a dedicated
descriptor generation. List generation cannot serve that purpose because every
retry advances it. Descriptor/status changes invalidate candidate qualification,
including ABA changes; retry/backoff metadata does not. Current commits check the
complete selected descriptor and candidate evidence generation, absence of a
record, run/lease, list generation, source/scope and verified account admission.
Incomplete acquisitions retain debt and do not refresh candidate acquisition time.
A complete response exceeding the evidence cap retains previous bytes for
diagnostics but invalidates their confirmation qualification; it receives normal
task-local backoff without rolling back healthy tasks in the same batch. Restart
requires a new complete remote acquisition; replaying an old run cannot confirm.

Acquisition remains under the existing 30-second, 50-page, 1000-item detail limits
and current retry schedule. Identity changes, regressed or missing source
versions, incomplete trees, failed pagination and ambiguous comparisons remain
unaccepted. Calendar and unknown source fields are compared; mention alias
changes use only the existing restricted equivalence proof. Evidence capacity
is 4 MiB per task candidate and source comparison retains its existing bound.

Database file/sidecar admission is checked before acquisition and before commit
under the request owner's lease; SQLite guards database facts atomically, not
external filesystem replacement. No additional API endpoint, scheduler, budget,
placeholder record, deletion inference or manual business repair is introduced.

Migration 012 adds bounded slots and invalidating descriptor triggers without
rewriting existing business rows, observations, detail status or coverage. Detail
selection on a pre-012 database fails before acquisition; initialization is an
explicit deployment step. Code rollback retains the added schema and evidence;
do not restore an older database or delete pending tasks to manufacture coverage.

Cross-acquisition scope context uses the same lossless projection as history,
bound to its policy version. Only `hot_rank`, `hot_seen_at`, and
`last_hot_snapshot_id` are scheduling-only: changing them between independent
reads does not revoke a matching candidate. Unknown configuration remains bound;
ambiguous JSON or numbers use the exact original configuration text. Current
request admission and transactional scope checks still bind the full config,
including these scheduling fields, so an in-flight change still rejects commit.
Existing candidates with the former context hash simply need a new first vote.

The pre-lock due check loads at most one task; the configured batch is selected
again under the scope lock. Pending reads first select lightweight identities in the existing due order,
then fetch each complete task and record ownership together, conditional on the
selected descriptor/evidence generations and current due/pending state. Changed
rows are deferred without refilling the batch. This avoids multiplying the
4 MiB evidence cap by a supported batch limit inside one SQLite stdout result;
the shared 50 MiB output buffer is unchanged. The public 1–100 task read limit
and runner's 1–20 detail limit remain supported, including non-default values.
The returned array still holds up to the requested number of complete tasks;
this is a per-query output bound, not a claim of 4 MiB total process memory.
The existing run/list/observation CAS guards remain the commit authority across
these sequential reads.
