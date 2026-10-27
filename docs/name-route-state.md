# Durable name lookup route state

This pure helper implements the latency route's failure isolation contract under
the shared message-completeness design v0.1. It does not create schema, issue
requests, read credentials or decide whether a name/identity is valid. The
coordinator owns validated task witnesses, account admission, request budgets,
cooldowns, durable lookup, generation CAS and response validation.

## Interface and identity scope

`nameRouteDescriptor(task, operation)` returns
`{ source_id, account_key, route_key, operation }`, or null for invalid inputs.
Its SHA-256 key binds source, account, task kind, explicit namespace, exact actor,
operation and authority scope. It reads existing task fields and never infers
namespace from an ID prefix.

| Task / operation | Namespace | Failure-isolation authority scope |
| --- | --- | --- |
| sender / contact_search | open_id | same account and actor, across chats |
| sender / application_info | app_id | same account and actor, across chats |
| sender / chat_members | open_id | same account, actor and chat |
| sender / chat_bots | app_id | same account, actor and chat |
| chat / other | empty namespace/actor | same account and chat |

An application's failure therefore cannot block another application or its
independent bot fallback. A chat member/bot failure cannot block another chat.
These keys isolate failures only; they do not authorize positive evidence reuse.

`classifyNameRouteFailure(error, expectedOperation)` accepts a string or Error
message only when it is a bounded, complete `lark-cli failed: kind=...` safe
descriptor. Allowed tokens match the transport producer: finite kind/operation,
numeric code/retry_after_ms/timeout_ms/retries, finite retry-after source,
spawn_code, exhaustion flags and transport reasons. Duplicate or unknown keys,
prose, raw JSON, malformed tokens or conflicting operation are unclassified.
The helper then calls the existing `classifyLarkFailure` and returns only
`{ kind, code, retryAfterMs }`; no error text is retained. Legacy safe
`kind=unknown code=210508` retains the classifier's exact denial interpretation.
Generic failed/unresolved/private error text never implies permission denial.

## State transitions and persistence

`nextNameRouteState(route, previousRow, event, { nowMs, cooldownUntilMs })`
returns `{ changed, state, reason, row }`. Invalid route, clock or stored state
throws a fixed safe error before producing a replacement. `previousRow` may be
null. `event` is one of:

- `success`: the coordinator has validated the actual remote response. Clear a
  nonterminal failure episode, without interpreting name resolution success.
- `failure`, with `error`: one actual failed lookup, classified as above. This
  increments consecutive failure count once, independently of actual CLI spawns.
- `deferred`: no failed upstream lookup occurred (budget, lease, cooldown,
  cancellation or already blocked route). Return unchanged; create no row and
  consume no failure count.
- `recover`: the coordinator has independently authorized recovery of this exact
  route. Clear terminal state explicitly. A new message, restart, evidence expiry or ordinary task claim is never recovery.
  The coordinator may authorize a due, low-priority bounded recovery probe; only
  its actual request outcome is persisted (see name-latency-policy.md).

Permission denial and command-unavailable set `blocked=1`. Other actual failures
retry after at least 5 seconds, then 30 seconds, with retry-after and existing
cooldown taking precedence. Their third consecutive failure yields `exhausted`
with reason `failure_limit`, distinct from permission denial. Blocked/exhausted
state is unchanged by later ordinary events until explicit recovery. Successful
member pages clear prior nonterminal failures; page count and request count do
not contribute to failure count.

The route's suggested retry deadline cannot shorten the coordinator's existing
five-minute task retry, 60-second account gate, shared cooldown or request/time
ceiling. The coordinator takes the maximum of all applicable admission bounds.

Rows use exactly the planned migration-016 columns:
`source_id, account_key, route_key, operation, failure_kind, failure_code,
failures, last_attempt_at_ms, retry_at_ms, blocked, generation`.
The two failure fields are nullable; clean rows use null/null/0. The pure helper produces terminal rows with retry_at_ms=0. The runtime stores
a separate due-probe deadline (24 hours for denial/command unavailable, five
minutes for exhausted generic failure). Ordinary request eligibility still
excludes both `blocked=1` and `failures>=3`; a timestamp alone cannot reopen them.
Reason/state are derived, so no new status column is required. Every changed
row advances generation; deferred or terminal-preserving events do not.

The coordinator must compare the exact previous row/generation and route in its
short commit, preserve shared transport cooldown checks immediately before real
requests, and count actual subprocess attempts separately. `success` here means transport response acceptance, not a valid adopted name.
The existing exact identity producer must independently validate authority.
Blocked routes require the explicit due-probe recovery path before a call.

Tests use synthetic task/row data and the real transport with a fake spawn;
they do not inspect production data, call an API or modify shared files.
The final coordinator, migration, CAS and command/worker regression evidence
is delivered with this combined isolated route. Independent review of the frozen
main integration remains a release gate.

## Inline list and detail admission

Current list/detail acquisition also consumes this isolation state before
optional name requests. `prepareInlineNameOptions` uses the command's admitted
self account and the batch's explicit typed sender/partner identities to build
at most 400 exact route descriptors. It reads only those route metadata rows in
one read-only query, bounded to 1.5 seconds and the remaining optional budget.
It neither reads message history for this decision nor writes route state.

The resolver's optional `nameRouteAdmission({operation, actor_id, namespace,
chat_id})` hook runs after positive source/seed/cache reuse and before a remote
request. Global contact/application requests use an empty chat selector in the
hook; their precomputed descriptor still comes from an exact batch identity.
Member/bot requests retain the exact chat. A contact batch includes only admitted
targets; a member/bot page cannot adopt names for excluded targets. The complete
original message/alias inputs remain available for identity-conflict checks.
Callers without the hook retain their existing behavior.

Valid blocked/exhausted routes stay excluded even after their probe time is due.
Only the existing background recovery path can reopen them. A temporary future
retry deadline also excludes the route; an absent row permits the ordinary
lookup. Invalid, duplicated or unavailable metadata defers optional requests
without inventing denial, failure, an attempt observation, or a name clear.
Unselected routes beyond the finite metadata bound are likewise deferred, while
positive cached/native names remain usable. Other actors, accounts, operations
and independently scoped member/bot routes are not quarantined by association.

List enrichment has one five-second optional remote-name deadline per batch.
Detail enrichment takes the smaller of five seconds and its remaining existing
detail deadline. Route metadata read time consumes this same name allowance;
it cannot add another request/retry budget. Existing bounded local-name reuse
still precedes remote preparation. Source acquisition and durable detail debt
do not depend on optional name success. A first inline failure is still handled
by the existing background state producer; inline reads never renew or reset
terminal state, retries or recovery generations.
