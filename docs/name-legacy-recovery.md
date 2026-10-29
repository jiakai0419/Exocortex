# Reviewed recovery of legacy name debt

Old generic task failures can carry a 24-hour retry time through migration even
when no exact route result was saved. That absence does not prove a request was
never denied. The recovery policy must shorten recoverable waiting without
reopening a known denied target or increasing the existing remote allowance.

## Admission and scheduling

A private, read-only `.name-recovery-review.json` sidecar binds a local database
file and account. It explicitly lists exact application actors as either `hold`
or `retry_unknown`; unlisted actors receive no accelerated legacy admission.
The file is a local request policy, never name authority or an API response.
Its schema and file checks reject duplicate/unknown fields, foreign accounts,
database substitution, non-private files and concurrent replacement. Holds do
not expire. Positive review expires 24 hours after its original review time.
Missing review preserves ordinary scheduling. An invalid or changed review
excludes application-name work from this optional tail, retaining all existing
task and route evidence; unrelated human-name and recipient work can still run.
The failure is local policy unavailability, never an API denial. Preparing a
candidate file is not installing it.

For an explicitly reviewed application, an unclaimed generic failed/unresolved
task with no scheduler failure episode or recorded block becomes eligible at
the earlier of its existing retry time and five minutes after its last attempt.
Future or invalid attempt clocks are never accelerated. This is a derived due
time, not a reset of persisted retry history; migration and restart cannot renew
the window. Exact route permission/command denials, exhausted routes and invalid
route state disqualify accelerated work. A denied primary cannot gain an earlier
fallback attempt through this policy.

Migration 018 adds a local discovery cursor and a zero-default original-deadline
field, without changing existing retry history. An accelerated claim retains its
original deadline durably. A crash before result publication therefore cannot
turn it into an ordinary five-minute request after review expires or disappears.
Resumption before the original deadline still requires positive review and route
admission; a no-request deferral keeps that guard. Discovery scans at most 64 reviewed tasks by stable task key.
An entirely rejected page advances through a guarded local cursor transaction,
so a prefix of denied routes cannot hide a recoverable task forever. A page
with eligible work retains its cursor until its oldest eligible candidate is
actually selected; fresh traffic cannot move the cursor past that waiting work.
That candidate joins the historical tier of the existing every-third-turn fair
selection. The cursor advances atomically with its actual claim. New generic task failures are capped at five
minutes when no permission/command denial applies; explicit route retry times
and shared cooldowns remain mandatory at execution. Three failed attempts still
isolate the episode. A generic timeout never becomes a permission statement.

The account remains limited to one admitted remote turn per 60 seconds, four
CLI calls and ten seconds, including the final account check. No new lease,
timer, worker or quota is introduced. Task claim, cadence and rotation retain
one guarded transaction. Derived eligibility is included in the predecessor
checks; the reviewed file is checked again before each affected application
commit/request and any reviewed-scan commit. It is not an admission dependency
for unrelated human-name or recipient work.
Network work remains outside transactions. A conflicting task/route/file/account
or a backward clock prevents requests or discards the attempted result.

The five-minute threshold bounds eligibility, not success or a saturated queue's
wall time. Existing fairness gives a conditional service bound in admitted
turns; upstream visibility, worker health, cooldown and finite population remain
necessary for a wall-time claim. Actual messages JSON/text must verify correct
readability and retain unresolved records in the denominator.

## Deployment boundary

Before enabling acceleration, the integration owner must review existing local
denial evidence and materialize holds for every known exact denied actor in the
reviewed population. Legacy route absence is not an adequate exclusion check.
Do not convert a hold into fabricated route-response data or readiness evidence.
The candidate alone makes no claim that historical denials were already stored
in production. No task in this development route modifies production settings,
permissions, the database, or the running worker.

The existing general 24-hour recovery policy outside this reviewed path is a
separate behavior. A loaded hold excludes its exact application from this tail,
including sibling routes; this change does not claim to govern other ingestion
or independently authorized request paths.
