# Observation, acceptance, and historical rechecks

This contract distinguishes a captured source representation, the locally selected
observation, a derived projection, and its display. A changed digest, timestamp,
or review proposal is **not evidence that a person edited a message**. The saved
`raw_json` is a parsed CLI item serialized locally, not an HTTP wire capture.

## Decisions from the three independent designs

The designs were independently prepared against `118bff15`; their synthetic
experiments characterize the baseline, not the correctness of this implementation.

| Choice | Decision and reason |
| --- | --- |
| Shared comparison and acceptance (all three) | Adopt. List, details and replay must use the same source relation. Authorization and completeness remain additional gates. |
| Exact raw, structural and projection identities (all three) | Adopt separate meanings. Preserve `content_hash = sha256(raw_json)` and every unknown source field. Never rename this a semantic hash. |
| Reference graph proof (all three supplements) | Adopt a bounded, closed grammar. Compare every reference position and typed target, not identity/name sets or rendered text. Unsupported consumers make proof unavailable. |
| Observation/current/projection tables | Adopt route three's unchanged 19-column records interface. Use an additive state table with a generation and bounded previous/latest-observed/pending slots; current raw stays in records. No eager rewrite/backfill of payloads. |
| Full event ledger / general multi-kind job framework | Defer. It adds migration, retention and ownership machinery beyond this slice. One current, one previous, one latest observation and one pending candidate per existing record suffice for the accepted guarantees; this is not a complete edit history. |
| Two independent observations for ambiguous equal-version changes | Adopt only for the bounded historical recheck path, with a captured local generation, a distinct acquisition, the same account/profile/source-policy context and a later request start. Ordinary ingestion cannot overwrite a conflicting equal-version current row. |
| Treat numeric Lark timestamps as globally ordered revisions | Reject that claim. Keep the existing numeric no-regression guard as a conservative local policy, explicitly without claiming all source fields have a strict revision clock. Timestamp regressions remain unresolved. |
| Default approval of an immutable local candidate (route two) | Defer. Existing replay promises a fresh read. Changing that promise needs a separate explicit user-facing mode, not an incidental repair. |
| New review semantics | Version them. Old v1-v3 retain exact-byte approval behavior. A new replay review may use the declared source equivalence proof plus exact local dependencies; unsupported proof remains exact. |
| Durable histories of every old creation window | Defer to a later migration. This slice fairly revisits **known local records** with a fixed sweep horizon. It does not claim recovery of never-ingested historical messages. |
| Replace detail scheduling / split all scope configuration | Defer. Preserve the existing detail queue, coverage fences and v3 scope-policy projection. No expanding ignore-list for unknown config. |
| Source timestamp decrease after repeated reads (route three option) | Reject by default. Two identical reads are not enough to discard the existing no-regression policy. |

## Pure comparison

One versioned comparison reports identity, source-version relation, representation
equivalence and projection equality separately. Its finite source verdicts are
exact, JSON representation equivalent, proven reference renaming, different, and
unverified. None means client approval state.

Object-key order and whitespace in declared JSON content slots may be normalized.
Arrays remain ordered except an explicitly validated mention-definition map.
Missing, null, empty, number/string, URLs, calendar references and unknown values
remain distinct. Duplicate JSON keys, unsafe numbers, malformed input and resource
limits prevent an inner structural proof. Identical opaque content strings still permit a proof of outer object-key reordering. Ordinary strings are never recursively parsed
because they happen to resemble JSON.

Mention renaming is permitted only when definitions and all consumers form a
closed, unambiguous typed graph. Preserve consumption position/order, identity
namespace, name evidence, multiplicity and all remaining fields. Hidden actions,
unknown consumers, dangling keys, duplicate definitions, same-name different
people and namespace changes are counterexamples, not exceptions to ignore.
The renderer and proof share consumer dispatch: a typed `user_id` does not look
up a native alias or mention key. Native `userID` uses only the attachment bridge
when attachment evidence exists; without it, the existing unambiguous legacy
fallback applies. A string matching an ID in another namespace is not a proof.

## Shared acceptance

| Observation relative to current | Selection |
| --- | --- |
| New identity in an authorized complete scope | Insert with original raw evidence. |
| Exact / proven equivalent source | Preserve current raw/hash and redundant source representations; refresh derived projection using the existing name merge. Preserve unknown canonical keys from both observations. |
| Larger numeric timestamp | Accept under the existing local no-regression policy; retain predecessor evidence. No claim that visible content changed. |
| Smaller timestamp | Retain current; record unresolved regression. |
| Equal timestamp, different or unverified source | Retain current and pending evidence. No last-wins selection, including within a batch. |
| Later independent historical recheck agrees with pending candidate | May select the stable observed snapshot if identity, profile, captured local generation and all transaction fences still match. This is an observation policy, not proof of latest remote truth. |
| Identity/profile ambiguity or incomplete fetch | Do not replace a complete current record. Retain a finite reason/debt. |

The local generation changes with selected record updates and protects against
ABA. A separate evidence generation fences pending-candidate replacement. A decision prepared from a stale local basis cannot overwrite a newer row; stale candidates cannot supply the first confirmation.
Network I/O occurs outside SQLite transactions. Existing account binding,
source/scope enabled checks, run ownership, cursor, maintenance lock, API lease,
cooldown, review TTL and exact predecessor fences remain mandatory.

An explicit authoritative deletion flag is source evidence and follows these same
rules. Absence, 403/404, timeout or partial pages do not create a tombstone, clear
names, erase a row, or prove a history window complete.

Detail completion consumes the same materialized, transaction-fenced acceptance
result as the record write. Accepted/equivalent complete responses can retire
debt, including an equivalent no-op. Rejected observations remain pending with
bounded backoff and `LarkDetailObservationConflict`; their scope's full-content
cursor and completeness claim cannot advance, while healthy siblings and later
list windows can progress. History selection does not retire detail debt: after
history confirms a received record, a fresh accepted detail retry must still
complete the queued descriptor. Sent records have no automatic historical
confirmation in this slice; repeated equal-version conflicts remain explicit
debt until a newer accepted observation or a separately designed authorized
resolution, not a falsely complete cursor.

Native rows without an ordered numeric version cannot automatically acquire a
new numeric baseline from a different source observation. This conservative
change from the old writer is surfaced as `source_version_unordered` and
`pending_unordered_versions`; those rows are excluded from historical selection.
Do not interpret null as zero or promise eventual automatic recovery. A fenced
baseline-establishment or explicit authorization mode is future work.

## Failure evidence and approval compatibility

A fully fetched candidate rejected during review completion survives a refused apply in an owner-only bounded
sidecar next to the review. Save the fresh observation, actual effective proposal,
comparison policy and finite reason before returning rejection. It is evidence,
not a new approval; it cannot be passed back as a review or silently extend a TTL.
Private publication failure prevents business mutation. Old approval files are
never overwritten and their digests are never reinterpreted. There are three
exclusive evidence slots per approval digest, each capped at 4 MiB. Capacity or
publication failures are explicit rejections; no record mutation is attempted.
The v4 proof binds both observed and effective records, including every unknown
canonical field and all non-source local dependencies. Names reviews remain v3;
replay defaults to v4, while v1-v3 inputs retain their exact comparison and strict
preview policy, enforced again as an additional commit gate for every member of a mixed approval. Early account/input/fetch failures and final SQLite CAS refusals are finite errors,
not complete sidecar artifacts; this slice does not promise an all-stage failure
archive or HTTP-wire capture. Three slots bound each approval digest, not the
total lifetime size of a directory containing many approvals.

## Bounded known-record history

The worker reserves one small maintenance slice per cycle. It uses the normal
source/account admission and shared actual-CLI budget, lease and cooldown. One
native record with a numeric version is selected from its enabled first-seen
received scope; its one-second creation window is read with at most two list pages,
100 listed items and 1 MiB before selection. Only the selected merge root is
expanded, with a separate closure cap of two pages, 100 items and 1 MiB; unrelated
merge roots cannot consume its detail budget. Truncated, denied or oversized
target closures remain errors. Both list and details share a maximum of four
actual CLI attempts and 30 seconds of remote work, including self verification;
this is not an end-to-end subprocess wall-clock bound. Existing local database
timeouts and the worker step timeout also apply. No name lookup fanout is needed.

Persist a fixed maximum local record ID for each sweep, the processed position,
attempt result and generation. New traffic cannot indefinitely move that horizon.
Accepted rows, candidate evidence and checkpoint/receipt complete atomically. Each scope keeps its latest automatic audit receipt; replacing that receipt prunes only its linked predecessor in the same transaction. Explicit repair audits remain unchanged.
Failures remain recorded and rotate; they are not successful verification. A
restart does not reset the sweep or count one acquisition twice as confirmation.
The discovery cursor and full-content coverage cursor are never advanced by this
work. Disabled scopes are never temporarily enabled. A versioned worker cycle
receipt distinguishes the extra history step from older six-step cycles and
optional retention. Public status adds source-observation counts separately from
list/detail coverage; processing a row does not prove it was verified.

History business errors remain failed step/cycle results and retain finite reason
and request-budget summaries. They do not by themselves shrink a healthy forward
batch or indefinitely block diagnostic sampling. Forward health and actual shared
transport pressure are evaluated separately; real rate limits/cooldowns still
constrain related work. `adaptiveTargetCycleSeconds` excludes historical processing
time from forward batch workload; `history_ms` is recorded separately. Existing
retention timing and failure effects remain unchanged.

For a finite reachable known-record inventory, eventually stable observations
under the supported equivalence rules and recurring successful budget slices,
every eligible record gets another turn; ambiguous equal-version selection needs
two distinct historical observations in the same account/profile/source context
and scope-policy projection. That projection reuses the review policy: only
`hot_rank`, `hot_seen_at` and `last_hot_snapshot_id` are excluded; unknown config
fields reset confirmation. Every single commit still fences the full scope
configuration. Ordinary ingestion candidates are retained but cannot supply the first historical confirmation. Persistent permission failure, saturation, unknown
grammar or an unstable source has no finite convergence promise. This slice does
not recover missing historical identities or claim client-state equivalence.

## Acceptance slices and evidence

1. Shared pure comparison: representation metamorphisms, full reference binding,
   hidden/unknown fields, calendar identity, unsafe JSON and type distinctions.
2. Shared list/detail/replay persistence: actual SQLite preview/commit parity,
   equal-version conflict, older response, projection refresh, generation/ABA and
   preserved raw/name evidence.
3. Fresh apply mismatch: candidate sidecar survives, old approval unchanged,
   zero record mutation; legacy review formats keep their contract.
4. History: restart and response-loss idempotence, fixed-horizon fairness under new
   traffic, finite request accounting, permission/missing/deletion behavior,
   disabled-source protection and unchanged discovery cursor.
5. Cross-layer synthetic workflow plus full repository verification; independent
   review of the fixed candidate and final tree before any deployment proposal.

## Migration and deployment boundary

Schema changes are additive and initialization is explicit. Read-only commands
must not migrate a database. The records schema and IDs/raw/hash/received times
stay compatible; old observations have unknown acquisition times, never fabricated
ones. Rows without explicit native provenance keep their legacy selection behavior and are not inferred native from raw shape. Generation triggers observe writes to the compatibility table. Upgrading
requires one active writer and stopping the old worker before enabling the new
policy; allowing an old binary to keep selecting conflicting equal-version rows
is not a supported rollback. A rollback preserves new evidence and disables the
new scheduler; it must not restore an older business database.

No production data, credentials, real case identifiers or captured payloads belong
in source, documentation or fixtures. Tests here start from invented data.

## Follow-on dependencies

A complete historical discovery sweep must come after this acceptance contract,
with its own creation-window coverage, pagination receipts and fair retry state;
known-row checkpoints cannot stand in for that evidence. An immutable-candidate
approval mode would separately version the freshness promise and bind captured
account/profile/dependencies. A complete observation event history needs explicit
retention and migration sizing. None is required to safely reject current source
conflicts or run the bounded known-row recheck, and none is claimed delivered here.
