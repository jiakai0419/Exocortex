# Message completeness and identity consistency

Design v0.5 — integrated local candidate, base 5631504dade6c0ce2092bdfa6f5811f0314f376a. Final full-tree validation and independent acceptance remain pending. Production, services, permissions and API budgets remain unchanged. No push/deploy is authorized. All test inputs must be authored from scratch; never commit real or redacted business data.

## Goal

Normal low-volume messages must be correct and complete at first normal display. Missing fields, wrong identity mappings and hour-long recoverable name waits are defects or actionable exceptions, not a normal eventual-consistency experience. Incomplete placeholders are an exceptional fallback. First fix local evidence reuse and new-message preparation; do not hide defects behind a new UI.

Raw acquisition stays durable even if enrichment fails. Network requests run outside database transactions. Normal publishing uses a consistent, versioned projection with trusted identity. Never guess a name, infer identity namespace from a prefix, invent a personal recipient for a group, weaken account fences, or silently skip rows to fill limit.

## Ownership and integration

Main checkout: /tmp/exocortex-completeness-20261027-1SCjPK/repo, branch candidate/message-completeness. Main is the only integrator. Other routes work in separate checkouts and submit fixed commits/diffs. Main may assign local agents exclusive file ownership for a narrow integration fix; shared files still have one writer.

| Owner | Files and responsibilities |
| --- | --- |
| Main | This shared document; new src/adapters/lark-im/message-completeness.mjs and exact local projection evidence helper; pure p2p-recipient.mjs proof/display sharing (not recipient scheduler); src/diagnostics/messages-report.mjs; src/terminal/messages-view.mjs; src/diagnostics/lark-im-quality-report.mjs; src/storage/sqlite/lark-name-projection.ts and generated counterpart; related CLI/docs/tests; final integration |
| Latency route 01a17c6f-8b5f-7711-8f03-1557cac80009 | name-history.mjs, name-sync.mjs, sender-name-work.mjs, sync-runner.mjs/sync-command.mjs, recipient scheduling integration and narrowly needed schema/tests. Confirm additions before editing other files. Local evidence before remote requests, fresh actionable work and continuation priority, finite failure isolation, timing evidence. |
| Independent route 01a1498c-530b-717e-9b7e-a0c307d9a0c9 | Independent synthetic real-CLI matrix, counterexamples, fixed-candidate review; no product edits in main checkout |

Each route writes design before code and updates actual behavior/limits afterward. Shared interface changes go through this file first. Main-owned module changes must not be duplicated by another route.

## Existing contracts to preserve

Keep source/native/canonical separation; typed sender/partner and explicit-clear/conflict gates; exact page-local chat scopes and account/chat evidence; short storage transactions, fixed horizons, generation/claim/CAS fences; request leases/cooldowns; persistent tasks and bounded retries. messages remains read-only with no network. Ready-message layout, body, source clocks, ordering and filters stay compatible. No status redesign.

The old sent-first title omission is fixed in this base; do not present it as a current defect. Current sender reading can still miss exact persisted sender task evidence; local ingestion reuse runs after remote lookup and may be skipped with no remaining budget. Adopted authority and latest lookup diagnostics must be distinguished.

## Shared message contract

Main adds a pure evaluator in src/adapters/lark-im/message-completeness.mjs. Its input is a record plus the exact projection/evidence bundle already read by the caller. No DB/API access or mutation. Messages, quality counts and acceptance must use the same evaluator, not a second set of empty-string checks.

Initial interface:

```js
evaluateMessageCompleteness({ row, canonical, raw, display, evidence })
// => { version: 1, state, requirements, reasons, next_action }
// state: captured | enriching | ready | blocked
// requirement: { field, state, reason, evidence }
// field: sender | recipient | conversation | content
// requirement state: satisfied | not_applicable | missing | conflict | blocked
```

Finite reasons are shared implementation constants. Do not use raw error strings. `captured` avoids conflating lifecycle with direction=received. A nonempty label is not proof. Numeric-looking nonempty string names are valid. An adopted value may remain valid when the latest lookup fails; explicit account/identity conflict must not be ignored. Missing diagnostic metadata is separate from missing adopted authority.

Requirements are type-specific:
- Common: stable message/source identity, event time, direction, bound conversation identity/mode and type-appropriate content representation.
- Human private: typed sender and trustworthy adopted name; sent recipient has exact typed relationship/name, received recipient is the admitted own account. Never infer from a lone member or ID prefix.
- Group/topic: human/app/system sender contract plus exact chat identity/type/title; individual recipient is not_applicable.
- Application: explicit app namespace and exact mapping; a lone unbound bot or historical guessed name cannot establish readiness.
- System: a valid system actor/event can be complete without a fictitious human name.
- Text/card/media/forward/recalled: respect existing rendered/partial/structured_fallback status and detail debt. Media need not have prose; a revoked message is a valid tombstone. Partial content cannot be passed off as fully rendered.

Consult trusted bounded local identity/relationship/title evidence before optional remote work and before normal publishing. Incoming messages, historical recovery and reading must agree on identity, account, clear and conflict rules. Reuse is exact, source-scoped and namespace-aware; unknown is not an explicit clear.

## Scheduler interface and latency

The latency route prepares trustworthy local fields first and protects new actionable work from old backfill and repeated failures. Reuse remaining capacity of idle roles without exceeding shared API budgets. Do not call generic failed tasks permanent permission failures, nor broaden one app's denial to all applications.

Proposed scheduler diagnostic envelope, optional until producer integration is agreed:

```js
{ version: 1, kind, state, reason, error_code, last_attempt_at, retry_at,
  oldest_required_at, evidence_observed_at, projection_complete }
```

All fields are finite safe metadata; actor/account/chat binding remains in the existing private task identity. Main accepts only documented producer reasons; absent diagnostics remain unknown. Resolved task != all rows projected: fixed horizon and capacity/deferred progress still matter. 256 pages and 24h expiry are local bounds, not remote list totals or permanent invisibility proofs.

End-to-end latency means source occurrence -> correct complete readable projection. Measure acquisition, preparation/lookup, queue, evidence and publication separately. Existing updated_at is not a completion clock. Propose testable seconds/minutes objectives with explicit polling/network/permission assumptions; do not promise an unapproved exact SLO. Historical work must not consume the normal path's entire correctness budget.

## Display and observability

Ready rows preserve their current complete text layout. An incomplete selected row must not silently vanish or be skipped to fill limit. Initial exception policy: retain its position with a concise explicit incomplete/blocked notice and inspectable reason; do not present an ID-only partial message as an ordinary complete message. Normal preparation must make this rare. JSON keeps row identity and evidence/readiness fields so exceptions remain auditable; exact schema extension is documented before release.

Count affected messages separately from deduplicated identity tasks. State counts are mutually exclusive within the declared source/filter/range; field reason counts may overlap. Include oldest wait and finite actionable block reasons, and detect ready->incomplete regressions. Discovered-but-not-yet-stored details and acquisition coverage are separate from stored-row readiness. A successful sync or zero canonical empty strings does not prove complete display. Any status addition is minimal and uses this same classification; no redesign.

Do not first LIMIT then silently discard incomplete rows. The selected page keeps its stable order and explicit exceptions. Global completeness counts must not claim that all remote messages were captured.

## Verification retention

No-query replay must not erase previous latest-result diagnostics under exact record/actor/namespace/chat and compatible explicit account constraints, unchanged adopted name/source. Missing incoming data must not manufacture a new observation or current-account proof. Genuine later failed/conflict/cached/resolved lookup results may replace the latest slot. Do not freeze that slot to the recovery task. Body/raw/source clocks and adopted evidence remain independent.

## Mandatory release gates

- Pure synthetic SQLite runs the real messages CLI JSON and text path: parser, store, projection, renderer. Cover private/group/topic, sent/received, human/app/system, typed namespaces, sent-first, local-known/no-network, partial content, permission/conflict/failure recovery, replay, restart and out-of-order input.
- Compare actual sender/recipient to exact authority unconditionally. Nonempty values, success counters, status-short-circuited checks and name-normalized layout do not establish correctness. Assert body/raw/event time/identity/order/layout, adjacent messages, count conservation and later replay regressions separately.
- Real local read-only latest-message and fixed-target acceptance after natural sync/replay. Keep private contents/identities/screenshots/DB/logs out of Git and remote systems, even redacted. Blocked external cases need individual evidence, not blanket excuses.
- Full synthetic verify and independent frozen-candidate review. Save a durable incremental bundle and verify exact restoration before requesting new release approval.

## Integration and acceptance status

The read protocol and finite reason vocabulary below are implemented. Migration 016 and the latency route are integrated; final full-tree verification and independent frozen review remain release gates. The latest application-name screenshot has been materialized locally and pixel-inspected; it is private evidence and is never included in this repository. A screenshot name gap is not by itself proof of a particular upstream permission error.


## Frozen read protocol v1

`messages --format json` remains an array. Each selected row adds `source_id` and `readiness={version:1,state,requirements,reasons,next_action}`. Requirements always appear exactly once in sender, recipient, conversation, content order. A group destination has recipient=not_applicable. JSON retains raw/canonical/body and the inspectable candidate display even when readiness is not ready; only a ready row is presented as an ordinary complete text message. An exception keeps its actual selected header and position, followed by state, finite reasons and the JSON inspection hint. No older row replaces it. Ready-row layout is unchanged.

Reduction priority is conflict/blocked -> blocked; otherwise unprepared -> captured; otherwise all satisfied/not_applicable -> ready; otherwise enriching. Current read projection always prepares its selected page, so captured is reserved for unavailable/invalid preparation and lifecycle producers. Invalid source/message identity maps to conversation conflict; invalid event time maps to content conflict; account disagreement maps to conversation conflict. Direction unknown remains missing. For an unnamed application, exact error 210508 from both supported routes, with matching target and account, can block the sender component; one route or a generic failure cannot. A valid adopted value remains valid despite a newer failed check unless its identity/account/clear contract is contradicted.

Reason vocabulary is MESSAGE_COMPLETENESS_REASONS in the pure evaluator. Actions are none, prepare, review_identity, review_permissions, review_explicit_clear, review_content, resolve_sender, resolve_recipient, resolve_conversation, resolve_content. Priority is ready/captured, identity conflict, verified permission, explicit clear, unsupported content, then first missing requirement. Unknown errors do not invent a permanent block.

One schema-only preflight selects legacy optional tables; one subsequent SQLite SELECT reads selected records, exact candidate evidence, scopes and population under one read snapshot. No long transaction wraps network work. source_max_record_id is a watermark, not a database revision or completion clock. Reading never writes progress. Invalid or duplicate source JSON and contradictory typed aliases fail closed. Familiar ID prefixes do not establish actor kind.

Trust sources: a native name must match the same exact typed source actor. Adopted contact/member/self/application names need a high-confidence authority and their own matching account key. A chat title account cannot supply missing sender adoption proof. Scoped member/bot authority does not establish a private relationship. A resolved sender task must validate its full source/account/chat/actor/namespace/key and observation envelope; its outcome string alone grants nothing. No-query replay may preserve diagnostic metadata without inventing adoption authority.

A local application mapping is a separate explicit local authority: the reader verifies the private file and database binding, then exact native tenant/chat/app identity. Only that validated in-memory envelope can change completeness; a canonical source string cannot. The same mapped messages feed quality reporting. Sidecar mappings do not establish a private own-account relationship.

Quality adds completeness for latest at most 1000 stored messages, with scope/filter/as_of/total/evaluated/not_evaluated and mutually exclusive state counts. Reasons overlap per component; readiness_unavailable is a summary error, never ready. Existing canonical-only counters retain their old meanings and are not the completeness denominator. Unstored detail debt and identity tasks are separate populations. Source age is not time spent incomplete. If first_missing/first_complete is not durably attested for the same source and contract version, report unknown; do not substitute task enqueue, updated_at or lookup time. End-to-end release tests use an external source/availability publisher and actual JSON/text observer, including incomplete and censored samples.

## Acquisition-account proof

Current authorized acquisition can persist `message_account_evidence` independently of whether name lookup succeeds. Its exact envelope is schema=lark_message_acquisition/v1, source_id, account_key, external_id, container_id, source_hash (SHA256 of exact raw_json), source_version (external_version or null), acquired_at. Only newly normalized records actually returned by the admitted account's current source request may receive it. Merely selecting a historical row or seeing a single sent actor never grants this right. The helper must validate exact message/chat/source/hash/version and reject conflicting existing account markers. Network work remains outside the existing short admitted storage transaction.

The reader can use valid evidence for that exact source version as own-account proof, independent of sender lookup success. Replayed raw bytes/version may retain an earlier matching proof without renewing acquired_at; changed source bytes/version require a new proof. Missing or conflicting historical evidence remains unknown until natural authorized acquisition actually returns that message. This is not permission to backfill all received history from a database-wide guess. Local-history name adoption must retain the original proven account key; known-but-unproven names need explicit repair eligibility and cannot be stranded by an unknown-name-only scan.


## Current-source ownership and old-record recovery

List and detail ingestion capture `acquired_at` immediately after the adapter returns and before optional name preparation. This is the observation of the complete adapter response, not the transport time of each page. The helper then binds only normalized records from that response; normal storage retains exact raw bytes and source clocks. Bounded replay and natural history must use the same producer when their existing admitted requests actually return a source record. Selecting old records for name work or observation is never acquisition and cannot mint this proof.

An otherwise identical record with two valid matching acquisition envelopes that differ only in a later `acquired_at` is a duplicate: retain the original canonical bytes and `updated_at`. A changed name, source version, raw payload, account or other record field remains an ordinary update; invalid proofs and explicit null are not silently ignored. The retained clock is an earlier valid response observation, not proof of the message's first-ever ingestion.

This recovery path matters for legacy received private messages with an exact native sender name but no stored own-account evidence. Such a row correctly needs no sender-name request. Its missing ownership must instead be repaired by the normal authorized source reacquisition path; requiring a redundant sender lookup would mix two different contracts. Outside current collection overlap, existing historical traversal determines the opportunity. No claim of a fixed historical recovery deadline is made without a measured traversal bound.

If equivalent-source reconciliation retains earlier raw bytes, it also retains
the earlier acquisition-proof member, including absence. It cannot transplant a
new exact-byte proof from the discarded representation. Byte-identical actual
source acquisition may add proof through the normal guarded merge.

Explicit replay review keeps exact digests and committed proof bytes. Its v4
structural comparison can normalize only validated current acquisition time and
the exact-source hash dependency, within a separate validated-proof domain; the
complete source/reference proof still applies. Invalid, foreign, duplicate or
unknown canonical data is not normalized. Legacy approval remains byte exact:
only an exactly approved prior proof, or an exactly approved proposal without
new proof, can be retained. A replay never invents an earlier request time.

The optional v4 `acquisition_exact` digest additionally supports byte-identical
source payloads containing legal numbers outside the conservative structural
parser's domain. It replaces only the validated current acquired_at value span,
binding every other canonical byte, raw byte and effective record field. The
original exact digest remains unchanged and independently checked. Old v4
proofs without this optional field remain readable; a pre-acquisition approval
does not authorize adding ownership proof and must be previewed again.

## Persisted completeness observations

Migration 017 records historical results of the actual local `messages` pipeline. A successful sync tail, including an empty successful cycle, may observe at most 20 new and 20 historical records per admitted 60-second opportunity. The same account/maintenance fences protect short local commits. There are no remote calls or long transactions. Source CAS prevents attaching a reading to changed source bytes; a failed optional observer never rolls back acquired messages. Oversized or unreadable candidates are counted as deferred, and historical scanning continues fairly.

The observation key includes source, record, observer account and contract version, with an epoch derived from exact raw bytes plus external version. `first_missing_observed_at_ms`, `first_ready_observed_at_ms` and `last_observed_at_ms` describe actual observations only. They do not attest the first true missing or complete instant. The observer account is execution context, not ownership proof for a record. A source-version change starts a new observed epoch; same-version repeated observation preserves its clocks; an observed ready-to-incomplete transition increments a regression counter. An unobserved A→B→A change cannot be detected.

The reader always evaluates current source and identity evidence again. Ledger state cannot make a current row ready. Quality exposes compatible observed clocks separately from true first-missing/completion clocks, which remain unknown when not established. Multiple incompatible observers or stale epochs are unknown rather than merged. The same statement reads the selected page and its optional observation data. `messages` itself remains strictly read-only.

## Latency boundary and acceptance envelope

The fixed optional background name tail remains four CLI calls and ten seconds per 60-second account admission. Inline names consult the same exact persisted route failures after positive local/cache reuse and before issuing optional requests. Each list/detail preparation has one shared deadline of at most five seconds, including route reads; it does not reset the deadline per actor. Blocked probes remain the background coordinator's low-priority recovery work. Skipping a denied route is not a fresh request, failure, permission observation or successful recovery. Different typed actors and independent chat fallbacks retain their own admissibility.

An idle discovery or empty successful sync may scan/enroll bounded old debt, but
does not reserve the remote 60-second opportunity when no work is eligible.
Only an actual selected task atomically reserves cadence together with its
rotation and claim. A concurrent winner or stale task rolls back all three;
new records never bypass an already consumed opportunity. This fixes the public
discover-then-sent path without increasing API budgets or disabling historical
empty-cycle recovery.

The synthetic worker gate uses an external publisher and actual CLI JSON/text observations with 15 source versions: two fresh, one locally known donor, and twelve unresolved old applications. All remain in the denominator; the three accessible identities must have exact expected names and `ready`, and the twelve others must remain explicitly accounted for. Its one-group, two-fresh, available-upstream, normal-response envelope demonstrates a source-to-readable minute-scale example, not a measured production percentile. The separate twelve-denied-plus-one-fresh two-batch test proves already isolated identities cause no repeated inline requests. Arbitrary cold identity rates, unbounded member pagination, worker sleep or missing upstream visibility do not have a finite guarantee from those samples.

The seconds/minutes objective is a design requirement for normal load. The numerical p95/alert thresholds in `name-latency-policy.md` are proposals, not approved promises. Report source wait, collection, preparation, durable queue wait, and actual readable observation separately. A fast helper or a successful sync is not end-to-end completeness. Real data acceptance must list each remaining exception category and its recovery route or evidenced external limitation; an unclassified error must stay unclassified.


Observed timing reductions use the complete evaluated page as their denominator.
A first-missing observation may belong to a currently ready row; its age is not
continuous waiting time. Likewise, a first-ready observation can predate a later
regression. True first-missing and complete-publication clocks remain separately
unknown. A saved observation is sampled evidence, never a second classifier.


## Bounded local sender evidence at read time

An exact resolved task is not the only local authority. For a verified message
account, an unknown or nonempty-but-unproven sender may reuse compatible direct
adopted evidence from stored messages in the same read snapshot. Donors require
their own matching account, high confidence, exact typed actor and consistent
native/canonical identity. Contact/self/application authority is global to that
account and actor; member/bot authority additionally requires the exact chat.
`local_history` copies cannot seed another generation. Clear/conflict or differing
credible names prevents reuse. Native valid names and already authoritative
adoptions remain unchanged. The returned evidence is ephemeral: no read writes
a name, refreshes a lookup time or manufactures acquisition proof.

The indexed lookup uses at most 100 candidate actors, 1000 candidate rows per
actor, 1000 returned donor rows across the page, 8 MiB total donor JSON and 1 MiB
per donor. A truncated or oversized actor set is explicitly incomplete and
cannot select an arbitrary first name. These limits bound optional reading, not
the number of stored or displayed messages. Existing persistent authority repair
remains the recovery route; both its enrollment/application and ingestion's local
reuse include nonempty unproven labels. The original private screenshot records
are a required real-CLI regression check for this case.

## Exact failure diagnostics and content verification

Failed inline name lookups retain only a finite diagnostic descriptor: version,
operation, kind, numeric code or null, and execution stage. Request admission,
local budget exhaustion, transport failure and an actual API error are distinct;
arbitrary exception text is never persisted. No-query replay can retain an
exactly bound diagnostic without creating name adoption or account proof.

An application-info permission response is evidence only about that route. The
current-attempt observation may additionally retain a finite `route_failures`
envelope with version, attempt digest, target digest, account key and exactly two
ordered outcomes: application_info and chat_bots. Each distinguishes failed,
unresolved, not_requested and unknown. The consumer recomputes the exact typed
actor/account/chat target and validates current acquisition proof. Only two
explicit permission_denied/210508 response errors yield review_permissions for
the missing sender. Empty results, timeout, unknown errors or an unattempted
fallback remain recoverable/unknown, not permission proof. No valid alternative
name is demoted. A failed contact lookup alone likewise cannot declare all
member fallback routes blocked.

Legacy route-table evidence uses the same SQLite read snapshot, not a second
lookup. Candidates are bounded to 32 proved account keys, 1024 rows per account
and 2048 payloads per page. Overflow, ambiguous identity, invalid schema or an
incomplete candidate group supplies no permission conclusion. The reader
recomputes both opaque route keys and checks current blocked admission, precise
code and timestamps. A newer exact producer observation with a recoverable or
unattempted fallback prevents older stored denials from overriding it. This
explains existing failures without fabricating a new observation, account proof
or name; it does not prove permanent invisibility from every possible authority.
Conversely, a strictly later validated route response showing success or a
nonblocked failure withdraws the old inline paired-denial conclusion. A missing
route, equal timestamp, generation change or recovery claim alone is not such a
response. Freshness arbitration applies before component-state reduction.

For legacy records without renderer metadata, nonempty stored text is not proof
of complete content. The read path must verify the source representation and
the type-specific rendering, including unresolved references. Valid legacy
content remains readable; malformed or contradictory content cannot count as
ready merely because its stored body contains text. This adds no new content
format support and never changes stored source bytes or body.

For older non-native shapes, when raw msg_type and message_type keys are both
absent and no source_api/raw_api provenance key exists, an explicit canonical
text/post type may drive the same strict renderer. Its JSON, references and
exact body comparison still apply. Explicit null/empty/conflicting raw types or
a native provenance marker cannot be rescued by this compatibility rule.

This legacy check does not replace existing renderer metadata or expand support
for content types. It reuses the bounded source renderer when such metadata is
absent, keeps native encoded JSON distinct from direct-text legacy shapes, and
requires the complete rendered text to match the stored body before accepting
that fallback as complete. JSON and quality use this same decision.
