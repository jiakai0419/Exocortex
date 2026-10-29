# Name latency and scheduling candidate

Base `5631504`. This isolated patch changes the actual name coordinator and local
preparation paths. It does not change production, service configuration, request
ceilings, permissions, or message/status layout. Main owns completeness,
read-time identity evaluation and final integration. All fixtures are synthetic.

## Runtime ownership and interfaces

This route owns `name-sync.mjs`, `name-history.mjs`, `sync-runner.mjs`, the narrow
`sender-name-work.mjs` adopted-authority repair gate, new pure
policy/route/timing helpers, migration 016 and their tests. Existing
`commitEnrichmentUpdates` carries the scheduler's CAS writes; there is no new
shared storage function. Existing sender lookup/pagination and recipient lookup/projection algorithms
remain the producers. Main must combine this patch with its
exact local read evidence and completeness evaluator before release acceptance.

Local preparation runs before remote people-context preparation in both actual
sync paths. Its bounded donor lookup requires the admitted account, exact typed
actor, compatible record/raw identity and absence of clear/conflict. An adopted
name's authority and observation are distinct from its latest lookup result.
Legacy donor labels lacking explicit same-account adopted authority are not
promoted to current proof. See `name-local-first.md` for limits and field rules.
The shared `senderNeedsAuthorityRepair` predicate is used by both enrollment
and evidence application: a nonempty canonical label without its own same-account
high-confidence typed authority remains repairable. Native exact names suppress
remote repair; explicit clear/conflict/foreign markers remain fences.
No network is needed for already valid local names. Unresolved names and relevant
partner/member conflict checks retain remote preparation.

`selectNameWork(candidates,state,{nowMs,resource,cooldowns})` accepts at most 128
validated descriptors and returns an immutable selection plus next sequence/slot.
Two turns favor fresh incomplete records (newest required record first), then
continuation, then history; every third chooses globally least served eligible
work. New entries start at the current sequence, so continuing arrivals cannot
jump ahead of history in the fair lane. The runtime retrieves independent oldest,
fresh and due-quarantine lanes. Known group-title refresh is historical work.
Recipient work joins the same selector only with eligible sent witnesses or
persisted due/changed relationship work. It reserves its turn, then uses its
existing independently fenced claim. No atomicity across both claims is implied.

Task claim and account rotation commit together with predecessor generation,
progress, evidence, service age, account, exact witness and scope fences. Selected
invalid/scope-conflict/missing-witness work also advances rotation and service
age under CAS; otherwise old conflicts could hold a fair slot forever. Result
commit includes record projection, task result and exact route predecessors in
one short transaction. Any changed predecessor rolls back that result. A lost
result retains its claim until existing expiry and does not advance a saved page.
Existing fixed horizons, page validation and continuation tokens are preserved.

The runtime retains the existing 60-second account admission, four actual CLI
calls and ten-second optional name-tail budget (including its queries and final
self-profile check). It rechecks remaining monotonic time after route-state reads
and immediately before a request. This cap describes this optional tail, not all
inline enrichment, ingestion, worker subprocesses or upstream HTTP fanout.
The policy's optional cooldown-aware selection is not wired to a shared cooldown
snapshot; actual transport lease/cooldown enforcement remains mandatory. No
request capacity, frequency or login permission has been increased.

## Failure isolation and recovery

Migration 016 adds scheduler sequence/slot/service and enqueue fields, a separate
three-failure episode count and finite blocked reason. Legacy enqueue time zero
means unknown; legacy generic failure counts are not reclassified as permission.
New traffic never resets failed backoff, a claim, route denial or failure episode.

`nameRouteDescriptor` isolates contact/application failures by account and typed
actor across chats; member/bot failures also bind exact chat. Metadata routes bind
exact chat. One application denial cannot suppress another application or its
independent exact bot fallback. Only applicable routes determine terminal state:
private human work does not wait for a nonexistent member fallback. Safe typed
transport descriptors are captured before resolver errors collapse to unresolved.
Private prose never becomes a permission classification or persisted error text.

A real transport success clears a nonterminal route failure; it does not establish
name authority. Exact producer validation must still produce adopted evidence.
Actual nondeferred generic task failure has a maximum five-minute retry delay;
precise permission/command blocks keep their separate recovery policy. Legacy
24-hour generic debt can receive an earlier derived opportunity only through the
[explicit local review protocol](name-legacy-recovery.md); absent route evidence
is not permission to reopen a historically denied target.
Three failed task attempts or three consecutive route failures isolate the episode
from fresh/continuation lanes. Unknown failure remains distinct from permission.
Successful pagination counts as progress, not a failed lookup. Budget, shared
cooldown and already blocked routes do not consume failed-lookup counts.

Confirmed permission/command denial receives a low-priority recovery opportunity
after 24 hours. Exhausted generic failures receive one after five minutes, still
in the historical lane. These are finite probes within the unchanged shared
budget, not permission changes. A due selected quarantined task can recover only
its due exact route temporarily; only an actual request outcome commits that
transition. Unattempted sibling routes keep their block. Failed probes return to
quarantine. New rows or a process restart alone cannot recover a route. No minute
readiness is promised for an external denial without new successful authority.

The pure `planNameWorkRetry` helper models typed failure decisions with 5/30-second
minimum route delays. Those are not runtime task wake intervals: task backoff,
account admission, lease/cooldown and the quarantine policy above still apply.
`name-route-state.md` specifies stored fields and the coordinator/helper boundary.

## Latency evidence and proposed objectives

`message-latency.mjs` measures explicitly observed source occurrence, collection,
identity readiness and complete publication bound to the exact source version,
identity generation and completeness version. It rejects malformed evidence,
negative time, inconsistent accumulated wall/monotonic drift and incomplete
clocks. It preserves source precision as an interval and unknown stages as unknown.
It does not add production milestone instrumentation. `records.updated_at`, task
resolution and module execution time are not first full publication clocks.

For an awake healthy worker, upstream-readable records and existing permissions,
propose p95 collection within 90 seconds, preparation within 30 seconds and full
publication within 5 seconds after readiness; propose p95 full source-to-readable
within 120 seconds, unresolved exception at 180 and critical at 300 seconds.
These are review proposals, not approved SLOs, settings or measured production
achievements. Percentiles are not additive. Independent review may choose stricter
60/120-second thresholds. Worker sleep, upstream invisibility, clock uncertainty,
permission denial and program queue wait must be reported separately.

A conditional fairness bound is `3*N*ceil(P/m)` admitted completed turns for an
always eligible target, total enrolled population at most N and guaranteed page
progress at least m. N includes delayed/claimed/blocked tasks that can later become
eligible. Oldest eligible work must be visible to the fair query. The maximum two
member pages per turn is not a guaranteed minimum: budget or API failure may make
m zero. Convert turns to seconds only with an independently guaranteed maximum
admission-completion interval. Arbitrary backlog, sleep, upstream failure and
saturated capacity have no finite bound from this policy.

## Acceptance and remaining limits

Tests exercise real `syncNames`, SQLite/CAS, process restarts, typed denial,
fallback isolation, backlog priority, conflict fairness, private-route recovery,
budget consumption, pagination replay, and actual sync/messages JSON and text.
The command backlog test begins after local commit; its <=120-second result is
only that suffix. The worker test runs actual `runWorker`/cycle/guarded CLI children
and synthetic upstream, and separately observes source generation, acquisition,
prepared identity and first complete JSON/text. See `name-worker-acceptance.md`.
Neither synthetic test is a production SLO measurement.

Not delivered by this route: cross-actor persistent member-page batching; durable
production first-readiness/publication timestamps; faster worker wake or larger
budgets; broad source-acquisition scheduling redesign; main's readiness/quality
JSON schema. Existing stable resolver deduplication and bounded local donor lookup
reduce duplicate requests, but no new cross-actor network cache is claimed.
Final integration must run the independent matrix and real local read-only
acceptance against the exact frozen combined candidate, then obtain any separate
release authorization. Production/private evidence must never enter fixtures.

The v0.2 acquisition helper is main-owned and will be connected by main at current
source-response record submission. This patch does not copy it. Record response
observation time before optional preparation; exact per-network-page timing needs
an adapter-side in-memory observation, not a reconstructed normalization clock.
