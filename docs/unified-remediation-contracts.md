# Unified remediation contracts

This candidate addresses eleven demonstrated defects, adds two bounded
capabilities, and records one operational constraint. It does not authorize a
production deployment, a new remote request budget, or any directed repair.

## Data and admission

Canonical projection updates preserve unowned JSON values as text. Valid large
numbers remain intact during name and scope enrichment. Duplicate keys at any
depth are rejected separately. Incoming explicit unknown keys replace their old
value as a complete raw subtree; absent unknown keys remain. Only an explicit
derived-field list is deleted when missing from an incoming projection.

Account admission is conjoined with the existing run, lease, scope, observation,
review and record guards at the final SQLite transaction. Legacy unbound
databases and same-account pending-to-confirmed transitions retain their existing
policies; historical confirmation still requires verified admission. Names-only
repair may retain a disabled provenance scope and must not enable it. A disabled
source cannot receive new maintenance effects.

Database file identity and the account sidecar are not SQLite-atomic facts.
Maintenance reacquires the shared request lease for its local identity recheck
and transaction, excluding cooperating sync publishers. Arbitrary external file
replacement or account switching requires writer quiescence. Local commit lease
acquisition adds no remote attempt; existing remote budgets remain in force.

## Convergence and remote findings

Replay and detail acquisition compare complete merge-root evidence using one
normalization contract. An ordinary equivalent detail retry preserves a qualified
history candidate's original attempt, time and context, but cannot confirm it.
History may rebase a selected pending detail descriptor only under its original
descriptor and list-generation CAS. It does not complete that debt or advance the
full cursor; a subsequent ordinary detail receipt must do so.

Remote findings retain independent missing, version, deletion, type, body and
legacy-content debts for each target. A partial or unverified later observation
cannot clear a debt it does not prove resolved. Current report categories remain
mutually exclusive per target. `unresolved_prior` excludes targets already shown
as a current difference, including when a revisited target still has another
unresolved dimension. Private state remains bounded to 200 targets and 96 KiB.

One response may establish several independent contradictions. A newer remote
version must retain any explicit deletion or type difference, and any comparable
static-body difference, from that same response. Each contradiction raises its
own version floor. The public category still gives version drift precedence;
it does not discard the other debts. Cross-version equality cannot settle a
content debt: the local and remote versions must agree at or above its floor.
Native identity and comparable version evidence can settle missing debt
independently. Unreadable or
dynamic card bodies supply no body proof; mention rendering is not an edit
signal, and unknown calendar fields are not normalized away. No new request,
queue slot, schema field or higher budget is required for this accounting.

## Names and display

An adopted name and its original observation time are separate from the latest
lookup result. Cache reuse preserves the original time. Identity namespace, chat
and explicit account conflicts cannot transfer those observations between
senders. A failed lookup may retain a compatible adopted name while recording a
failed verification. Legacy observation times remain unknown.

Reviewed name repairs retain their exact canonical proposal comparison. A newly
varying lookup timestamp is not persisted in those proposals; when a new name
invalidates older timing or verification metadata, that metadata is removed and
its observation time remains unknown. This limitation avoids weakening review
hashes or extending an approval's lifetime. Ordinary unreviewed enrichment and
normal synchronization can retain their attributable observation metadata.

The explicit single-sender adapter verification capability is read-only, bounded
to a 15-second total deadline and at most three user-lookup requests or two
application-lookup requests, without retry. Its caller still owns account
admission, shared leases and the cumulative API budget. There is no new refresh
CLI, automatic whole-database refresh or network activity in `messages`.

System-message display accepts event-time context only with matching identity,
provenance and timestamp evidence. A message snapshot containing a group name is
insufficient to reconstruct the name at a historical event. Existing ambiguous
messages therefore retain unknown parameters; the new context capability does
not claim to resolve those historical names.

Live checks identify missing dependencies. A successful wait also requires the
final database check to pass. Worker producer and status display share a finite
task vocabulary. Terminal body truncation preserves complete graphemes within
the existing budget; JSON output retains the complete text.

## Operational and rollback limits

Exclusions from a directed manual repair constrain that repair only. Normal sync
and history continue their verified admission rules. No permanent hold, default
service stop or absolute record freeze is introduced by this candidate.

The history follow-up adds the container-routing index in migration 011 and
bounded pending-detail observation fields and a descriptor-invalidation trigger
in migration 012. Both require explicit initialization before the new workers
run. The routing and upgrade boundaries are described in
[Known-record history routing](history-routing-contract.md) and the
[pending-detail confirmation contract](pending-detail-confirmation-contract.md).
The remote-finding private state gains
bounded debt fields; older code rejects that state rather than interpreting it
correctly. Schema compatibility alone does not make an older writer safe for the
new convergence rules. Preserve current data and evidence during rollback; use
a writer compatible with the retained state, or quiesce writers while arranging
one. Never restore an older database or remove debt fields to force acceptance.

The [acceptance and unresolved-work matrix](acceptance-closure.md) separates
these fourteen delivered mechanisms from deployment verification and closure
of a specific name, display or historical-data problem.

Pending details without a stored record use the [shared observation confirmation contract](pending-detail-confirmation-contract.md); history remains record-only and existing-record ordinary detail retries remain non-confirming.
