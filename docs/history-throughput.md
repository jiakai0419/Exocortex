# Historical review throughput

The worker processes a bounded sequential batch after forward sync and due
retention. Its maximum is 12 CLI attempts, 12 selected records and 25 seconds of
remote work. Every selected record independently verifies identity and has its
own four-attempt limit. One session owns the whole batch's deadline, request gaps,
cooldowns and attempt count. A slow or paginated source therefore yields fewer
records; the configured maximum is not a promised throughput.

The configured interval is an idle allowance. Monotonic elapsed history time
uses that allowance instead of being added to another full sleep. Local commits
can exceed the remote deadline; their overrun remains visible as forward delay.
A due asynchronous sample replaces that cycle's history batch, receives the full
idle allowance and limits remote work to the interval minus five seconds, capped
at 55 seconds. The final cycle of a finite worker completes history without
starting a sample that shutdown would immediately cancel. `idle_history/v2`
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

Successful accepted/equivalent observations can create one verification ticket
for their local generation. Repeated duplicates of that generation do not
refresh it. The writer never deletes a finding. Only the independent sampler can
settle each retained version, deletion, type or static-body dimension with its
existing positive proof and version floor.

With routable old targets, the sampler selects up to three exact historical
windows plus one hot and one fair recent route. It reserves final identity and
local validation time before admitting a route. Short idle budgets restrict
recent routes to one page, report truncation, and rotate which domain runs first
so slow APIs cannot always exclude history or recent work. No history retains
the existing five-recent-route selection. The total remains at most 12 direct
calls with an unleased one-second gap and no in-run retries.

After successful sampling, still-unattempted generation tickets may schedule a
follow-up no sooner than 60 seconds. Existing due times, failures, busy backoff,
cooldowns and account guards retain precedence. An actual API attempt consumes
the ticket's rapid-revisit eligibility; a denied lease does not. Targets inside
the ordinary recent window retain ordinary recent sampling rather than gaining
an out-of-window historical claim.

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
self-profile is unknown. Application budgets and CLI attempts are not an
independent HTTP quota. Shared 429 cooldowns remain authoritative.

## Verification

`tests/history-throughput-benchmark.mjs` runs both revisions with the same
synthetic content, API latency and request gap through their real worker,
history writer, SQLite CAS and sampler. Virtual API/worker time is distinct from
real SQLite review-fence time. It reports first debt touch, local acceptance,
independent closure, unique initial-horizon coverage, attempt throughput and
paired next-forward-start intervals. An asynchronous completion model represents
the diagnostic child; it is not production latency evidence.

Include balanced scopes and a long scope among many one-row scopes. Never infer
full-history scan time from repeated-record attempts/minute. Focused tests cover
restart/CAS, bad-target backoff, generation tickets, continuing arrivals, short
budgets, clock adjustments, 429 propagation and actual temporary kernel locks.
All fixtures are synthetic; no real message content or private evidence belongs
in Git. Build and the complete verifier remain release requirements.
