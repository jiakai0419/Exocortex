# One deadline through resource production

This local change closes the preparation gap in `enrichResources`. The baseline
counterexample uses actual snapshots and producer code with a modeled 4-second
preparation cost and a 3-second grant. It preserves the original failure: three
scripted requests and local publication occur after the original deadline. It is
not evidence of a production wall-clock violation or a failed worker guardian.

## Internal interface

`createResourceCommandBudget({maxSeconds}, {monotonicClock,
startedMonotonicMs, remainingTimeMs})` creates the same privately branded budget
accepted by the existing session and media validators. Its resource policy keeps
the existing zero internal reserve; it does not borrow the history cleanup
reservation, add grace, change CLI/self quotas, or alter the outer guardian. The
existing history constructor and its reservations remain unchanged. An inherited
start must belong to the same local clock and can never be later than creation.

`enrichResources(options, {executionBudget})` accepts only that trusted brand. A
direct caller without an inherited budget creates one at function entry, before
any snapshot/cache/staging work. The worker integration must construct it from its
original command origin and pass that identical object. A relative remainder
passed after preparation is not an acceptable substitute. The integration owner
alone updates `resource-work.mjs`.

Every snapshot dispatch takes a fresh `sqliteReadOptions` timeout. Session/API and
commit admission use `commandBudget`; cache reads, image/JPEG validation,
publication, pending reads/retention/reclamation use `executionBudget`. The helper
chain checks before new subprocesses and file publication, and preserves typed
budget exceptions rather than misreporting corrupt media or remote permission.
No budget check can preempt arbitrary synchronous JavaScript/filesystem work;
operation admission and subprocess timeout remain the supported bounds.

## Stopping and local effects

A stop does not prove zero effects. Confirmed publication remains confirmed; a
lost/late acknowledgement remains unknown. Pending preservation may use only the
original budget's permitted cleanup remainder. If unavailable, no new snapshot,
helper or mutation is started: candidates report `not_retained` (or `unknown`
after a started retention), with the finite stop cause. Existing claim recovery
remains responsible for work that the wrapper cannot acknowledge before expiry.
Already-owned descriptors and private staging are cleaned without new admission.

## Finite gates

Retain baseline output and rerun the same 0/4000ms preparation controls against
the new producer with the original deadline. Add real snapshot timeout checks,
cached-JPEG no-start, publication/retention deadline controls, valid cleanup
remainder, lost acknowledgement, forged budget rejection and session late grant
controls. All fixtures and transport responses are fictional. Full repository
verification belongs to integration after the independent patches are combined.


## Implemented result contract

Preparation stops before session creation return the exact selected target fields,
`state: blocked`, `reason: batch_stopped`, and a finite selection failure. The
non-null zero-call request receipt keeps the original option quotas and the
branded clock's observed elapsed/stop. Only integration can accept that receipt
against its identical already-stopped budget; a lookalike result alone authorizes
nothing. Ordinary cached/unsupported zero-session results retain a null receipt.
The same preparation projection covers parent-directory resolution and staging
creation before a session exists. Resolution and creation have separate budget
checks. Ordinary local staging failures do not become budget or permission facts.
`resourceStorePath` itself only resolves path strings; it performs no filesystem
read or subprocess operation before the first readiness check.

A publication call entered without a confirmed return carries
`publication_state: unknown`; an available return marks it confirmed. A later
stop preserves confirmed state/counters. Pending work reports `not_retained` if
no retention starts, and `unknown` if entered retention does not return a receipt.
Neither label proves a rollback. The task's existing claim and recovery semantics
are unchanged. Store catches preserve budget errors only with an actual branded
budget, retaining the old behavior of unbudgeted callers.

## Validation failure at the deadline

The resource result and the command stop are independent observations. A trusted
local validation rejection already established from a response, file descriptor,
file identity, or decoded image remains the resource's finite diagnostic if the
original deadline expires at that same boundary. The command budget receipt still
records `time_budget` (or `clock_unavailable`); neither fact authorizes another
request, a closing-account check, publication, retention, or result writeback
after expiry. A report may therefore carry `download_file_invalid` together with
`request_budget.stop_reason: time_budget` and `persisted: false`. That means the
known failure was returned, not that it was stored. Existing claim recovery remains
unchanged.

A pure budget stop before a validator decides is not evidence of invalid media.
Keep typed budget exceptions intact, and never infer corruption or permission
denial from elapsed time or error text. Regression controls use real private
files, descriptor stats and a real extra hardlink, with only the monotonic clock
modeled: valid/invalid file crossed with available/expired budget. The cutoff
control must show no closing request, publication, pending retention or new
database write; normal validation and ordinary failure controls remain unchanged.
