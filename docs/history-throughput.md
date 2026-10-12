# Historical review throughput

The worker uses idle time after forward sync and due retention. History and
independent sampling share at most 12 CLI attempts, 6 self-profile attempts and
25 seconds of remote-work admission, further bounded by the configured interval
minus five seconds. These are application limits, not official HTTP quotas.
Each job receives only the remaining budget; a validated completion receipt is
required before unused capacity can pass to another job.

History prefetches at most six known IDs with one native mget, bracketed by fresh
identity reads. The pool freezes each row's source context and observation
generation before acquisition. Each subsequent transaction re-runs the original
live selector; an out-of-pool, consumed or changed selection ends that group.
The pool does not grant turns or simulate scheduler progress. Every row retains
its original snapshot and CAS, and a second confirmation requires another real
acquisition. Single rows and merge details retain the original four-attempt
route. Unusable message batches may be discarded in favor of a fresh bounded
original-route acquisition; account changes, cooldowns and deadline failures
cannot be bypassed. Missing items never prove deletion.

The configured interval is an idle allowance. Monotonic elapsed history time
uses that allowance instead of being added to another full sleep. Local commits
can exceed the remote deadline; their overrun remains visible as forward delay.
Due jobs run serially, at most once each per idle period. Waiting age decides
which gets the first opportunity; a writer that made no progress retains its
age. Sampling runs with its full admitted budget, so old list routes are not
silently reduced to fund history. Its measured remainder may then fund history,
with a one-second handoff gap. After history, a sampler without its full budget
waits for its next opportunity. Unknown consumption or a shared stop condition
ends the idle slice. With no history work, ordinary sampling retains its original
window, at most 55 seconds. Guardian cleanup and an already-started local commit
can outlast remote admission; this is not a hard 25-second subprocess guarantee.
The final cycle of a finite worker completes history. `idle_history/v2`
receipts put retention before history; legacy and `bounded_history/v1` receipts
remain readable.

## Selection and durable boundaries

Private independent findings are scheduling hints, not source content. At most
200 hints map to native existing rows through account/database salts and bounded
metadata queries. Invalid state falls back to ordinary scanning. Account, source,
scope policy, record snapshot, acquisition and observation generation still fence
the original writer transaction. Disabled sources/scopes stay disabled.

Migration 013 adds separate debt, scheduler and scan-round state. Two priority
acquisitions alternate with a background opportunity. Failed targets back off;
old retry work keeps its position when new findings arrive. Priority commits
never advance the ordinary scope cursor or claim a completed sweep. Both lanes
atomically commit their record effects, scheduler CAS and idempotent receipt.

Each enabled scope finishes its existing fixed horizon once per background
round. A completed small scope waits while larger scopes finish. Enrollment time
prevents new scopes from indefinitely preceding old work. Hot-discovery metadata
does not restart a round; enable or material policy changes do. An inventory
above the local bound explicitly falls back to the original fair selector.
Joining an existing cursor first covers its remaining tail, not every row since
deployment. A completed sweep is an attempted traversal, including finite fetch
failures; it does not certify successful repair or remote completeness.

## Independent verification

Successful accepted/equivalent observations can create one verification ticket.
An existing ticket is renewed by an accepted source change or a new debt, not
local metadata churn. Commit-entry and SQL time order the ticket after a sample
that completed during acquisition. The writer never deletes a finding. Only the independent sampler can
settle each retained version, deletion, type or static-body dimension with its
existing positive proof and version floor.

For uniquely located native text/post rows, the independent sampler can acquire
up to five retained targets with its own mget. Dynamic cards, merge roots and
unlocatable targets keep the original bounded-window route. The oldest target
keeps its fair position; one hot and one fair recent route remain. A mixed report
counts targeted IDs separately from list pages/chats. Batch omissions leave
debt unresolved and do not establish list completeness or a verified writer
generation. The original consistent SQLite snapshot proves only its compared
dimensions. The sampler reserves final identity and
local validation time before admitting a route. Short idle budgets restrict
recent routes to one page, report truncation, and rotate which domain runs first
so slow APIs cannot always exclude history or recent work. No history retains
the existing five-recent-route selection. The total remains at most 12 direct
calls with an unleased one-second gap and no in-run retries.

After successful sampling, still-unattempted generation tickets may schedule a
follow-up no sooner than 60 seconds. A healthy later due time can also be advanced
by a newly committed eligible ticket, with the same fixed 60-second floor and
locked publication revalidation. Failures, busy backoff,
cooldowns and account guards retain precedence. An actual API attempt consumes
the ticket's rapid-revisit eligibility; a denied lease does not. A retained
finding inside the ordinary 24-hour window may use the same bounded exact route
only with a current accepted ticket, matching account/database, source/scope
policy, debt fingerprint and record generation, and no pending candidate or
history error. Its entire three-second route must end before or at the rounded
ten-minute stability boundary. Unobserved recent records gain no new scan path.
Reports explicitly mark these mixed retained-target visits as
`history.scope: known_verification`; older reports still require every exact
window to precede the ordinary window. No cache TTL or debt age is extended.

The final read-only SQLite transaction reads ticket metadata with comparison
records. A request that started before the ticket's accepted commit cannot
settle that ticket, even if its response and the local record have equal source
versions when comparison finishes. Unknown or changed ticket evidence retains
the finding. Retained attempt timestamps use the actual request start rather
than comparison completion. These times order local acquisitions, not remote
server commits. The proof is limited to that SQLite snapshot; it does not
certify a writer generation accepted afterward.

Ordinary pages may overlap an exact revisit. The collector deduplicates the full
salted identity only when version, type, explicit deletion and normalized body
evidence agree, and uses the exact request's acquisition time. Conflicting
responses fail the sample and retain debt; transport-only fields do not create
duplicate comparisons. Two of the existing four phases put the static batch
ahead of an old multi-page route so neither route class can always consume the
other's budget. Ordinary hot/fair rotation and foreground sync priority remain.

## Foreground priority and limits

A kernel-held shared sync-intent gate announces sync waiters; later probes need
an exclusive gate before attempting the API lock. This blocks later history
requests and commits from overtaking announced waiters. It does not preempt an
active request/transaction, guarantee FIFO among sync callers, coordinate other
clients, or turn the five-second sync acquisition deadline into a latency SLO.
Both lock files are private, validated and never unlinked for stale recovery.

[Message list](https://open.feishu.cn/document/server-docs/im-v1/message/list)
and [detail](https://open.feishu.cn/document/server-docs/im-v1/message/get)
documentation lists 1000/minute and 50/second. The numerical special limit for
self-profile is unknown. The official CLI's
[fixed mget implementation](https://github.com/larksuite/cli/blob/bba13cfe0f09a5abda796411ca4c54ee303cf007/shortcuts/im/im_messages_mget.go)
supports user/bot identities and the native raw-card route, but no mget-specific
numerical rate or user-card representation equivalence is assumed. Only strict
native item evidence is admitted. Token refresh, redirects and connection retries
can make underlying HTTP counts differ from CLI attempts. Shared 429 cooldowns
remain authoritative, including mget's existing message-search operation bucket.

## Verification

`tests/history-throughput-benchmark.mjs` runs both revisions with the same
synthetic content, API latency and request gap through their real worker,
history writer, SQLite CAS and sampler. Virtual API/worker time is distinct from
real SQLite review-fence time. It reports first debt touch, local acceptance,
independent closure, unique initial-horizon coverage, attempt throughput and
paired next-forward-start intervals. The old revision uses its asynchronous
completion model; `--serial-idle true` uses the new serial admission path. Neither
models actual guardian/publication-token costs or competing processes. These are
static auxiliary experiments, not production latency or continuous-arrival proof.
Real-wall synthetic component and publication tests must accompany them.

Include balanced scopes and a long scope among many one-row scopes. Never infer
full-history scan time from repeated-record attempts/minute. Focused tests cover
restart/CAS, bad-target backoff, generation tickets, continuing arrivals, short
budgets, clock adjustments, 429 propagation and actual temporary kernel locks.
All fixtures are synthetic; no real message content or private evidence belongs
in Git. Build and the complete verifier remain release requirements.
