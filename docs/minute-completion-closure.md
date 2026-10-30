# Bounded resource discovery and whole-command history time

Implemented contract v0.2, base `f70690473df591b0e4035fd7d3bc108131726173`. This is an
isolated local candidate. Production, account permissions and real data are not
modified. Main owns integration and any later release; no real target IDs or
private evidence become fixtures. Source dates and acceptance observation dates
are separate; one natural new message cannot establish an overall SLO.

## Confirmed failures and required behavior

Resource discovery currently advances twenty *all-message* rows per admitted
scan. Sparse images behind thousands of text rows wait hundreds of scans before
queue enrollment. The newest-twenty shortcut does not cover slightly older
messages after continued arrival. The replacement must bound local payload and
API work while indexing potential image rows rather than traversing unrelated
text. It must use the same exact source/account/resource validation before any
queue insert, preserve known denials and claims, and cover old and new images.
No target-specific ID, queue reset, manual cache promotion or larger API budget
is permitted. Candidate selection is not proof of a valid resource or identity.

The new short shared-idle process deadline starts before CLI startup/selection;
history's request clock starts afterward and allows local commit work beyond
that clock. A result printed near the process cutoff can still be terminated.
History therefore needs one whole-command remaining-time contract beginning
before initial selection, with a bounded safe completion interval and the
existing guardian cleanup reservation. Local reads and transactions must use
the actual remainder, preserve transaction/CAS/lease guarantees, and stop admitting
new work soon enough to return a truthful bounded receipt. A timeout or unknown
exit never becomes success merely because stdout parses. Total idle time,
twelve CLI attempts, six self calls, spacing and cleanup remain unchanged.

## Ownership and shared interface

- Main: this document, `resource-work.mjs`, a narrow index migration if needed,
  resource discovery/deep-history tests, and `worker.mjs` final wiring/policy.
- History route: `history.mjs`, `request-session.mjs`, narrowly necessary history
  helpers and `history-whole-command-*` tests. It proposes a command-time context
  consumed by history before any selector. Main wires an internal worker/CLI
  boundary if required; no independently added public option or second scheduler.
- Independent local review: inspect candidate selection/index and deadline
  contract without modifying main/history owned modules. Existing external
  production observers remain read-only; their samples are not synthetic tests.

Before implementation the history interface is refined below. Shared changes
are coordinated explicitly; no concurrent edits to the worker or storage API.

## Candidate design and acceptance gates

Use an indexed conservative image-type predicate over existing canonical/raw
native declarations, including supported legacy envelopes. Only bounded row IDs
and sizes are discovered; existing `resourceWorkIdentity` remains authoritative.
Latest image candidates and fixed-horizon older image candidates share the
existing bounded page size and source-fenced enrollment transaction. Preserve
existing durable progress and fair two-fresh/one-old selection across process
restart, source changes and continuous arrivals. An index is maintained by the
ordinary record write, so new candidate rows need no per-message manual task.
No generic message renderer, status or identity policy is changed.

Unrelated detail partial must not indefinitely suppress safe resource-local
discovery. Any adjustment to the shared-idle admission gate must continue to
block uncertain process termination, account conflicts and shared transport
cooldown, and keep the same common budget. The distinction is documented and
tested before wiring; not all failures grant optional work.

Acceptance includes authored 5k+ and larger sparse-history populations, images
outside newest20, invalid/oversized/conflicting-type rows, updated older rows,
continuous new images, unknown/permanent denial isolation, a bounded query-plan
and write-cost check, migration from existing nonzero cursor/claims, restarts,
and actual messages JSON/text after normal worker acquisition. No filtered
message denominator or renderer change can manufacture completion.

History tests include slow startup/initial selector, per-query remaining timeout,
remote budget exhaustion, slow commit/release/result publication, deadline
boundary, cleanup failures and interrupted/restarted work. Verify real guarded
worker/CLI paths under authored data; do not pass by freezing real clocks or
loosening prior assertions. Full build/typecheck/generated/tests and private
real fixed-sample messages parity precede freeze and independent review.

The bounded guarantee is conditional on authorized visible resources, successful
account/lease admission, and the stated source/debt workload. Report elapsed
source-to-readable samples with all unfinished records retained; synthetic
component times are not production p95. Preserve actual first failures.

## History whole-command interface (history owner, v0.1)

`createHistoryCommandBudget({ maxSeconds }, { monotonicClock?, remainingTimeMs?, startedMonotonicMs? })`
creates the local command clock before the first history selector. A trusted
worker/CLI adapter may provide the current outer remainder; a parent process's
`performance.now()` absolute value is never reused in a child. Every observation
uses the smaller of the original local grant and that current outer remainder.
The provider cannot expand the admitted command allowance. There is no new
public flag, independently trusted environment value, or request-budget reset.

The internal object exposes `assertReady()`, `timeoutMs(capMs = 30000)`,
`remainingMs()`, `runCleanup(fn)`, `assertOutputReady()`, and `summary()`.
History accepts it as `deps.historyCommandBudget`; absent an injected object,
it creates the same clock immediately on entry after validating its grant.
All selection/account/debt reads receive a query wrapper that obtains a fresh
remaining timeout before each child process and checks the clock afterward.
The request session uses this same clock and remainder, including initial
selection time in its elapsed receipt. It retains all existing CLI/self counts,
spacing, transport classifications, lease and cooldown rules.

Work, cleanup and output share the original deadline. Work admission leaves a
bounded completion interval within that grant; the interval is not additional
runtime and not the only protection. Every read, preflight, request, transaction
and release also receives the actual current remainder. Work exhaustion does
not authorize another network request or an unfenced write. A transaction whose
child times out is unknown/failed, never assumed rolled back or committed solely
from stdout. Existing source/account/task CAS and audit receipts stay authoritative.

`BoundedReplayOptions.executionBudget` is opt-in and structurally consumes
`timeoutMs`, `assertReady`, and `runCleanup`. The storage read/preflight,
maintenance-lock acquisition, SQLite transaction and owner-qualified release
share it. `sqliteQuery`/`sqliteExec` add an optional budget argument;
`acquireMaintenanceLock` accepts it in options and `releaseMaintenanceLock` as
an optional final argument. Existing callers without a budget preserve behavior.
Cleanup uses its reserved remainder in `finally`; failed release remains an
error and does not delete any other owner's lock or silently declare success.

The CLI owner checks `assertOutputReady()` around result serialization/publication
using the same object. A finite `command_budget` receipt contains only version,
max_ms, elapsed_ms, stop_reason and complete. `complete` describes budget
accounting, never durable source completeness or successful process exit. The
worker continues to require a trustworthy finished child/guardian result; a
parseable near-deadline stdout summary is not accepted as success.

The smallest relevant tests cover initial-selection cost before any API,
per-query and per-request timeout contraction, clock rollback/invalid parent
remainder, bounded transaction interruption with unchanged CAS, owner-qualified
release from the reserved interval, output expiry, and no-budget storage
compatibility. Tests use only newly authored rows and private coordination roots.

## Forward-detail idle admission (independent admission owner, v0.1)

`idleAdmission(steps)` is a pure decision, independent of cycle health. Its
result is `{ mode, why }`: `all/healthy_forward` preserves the existing healthy
three-lane policy; `resources_only/saved_list_detail_backoff` admits resources
alone; `none` is accompanied by `missing_forward_receipts`,
`untrusted_forward_failure`, or `transport_not_clean`. It does not mark a partial
cycle healthy, change adaptive/status semantics, grant extra requests, or reset
history/sample service ages. The root worker owns lane wiring and the existing
25-second / twelve-CLI / six-self common budget.

The narrow exception is minted only by the list producer after its fenced list
commit and successful scope-lock release. This list contains no new detail
roots, has no source-observation conflict, and leaves a positive bounded count
of existing detail debt. The separate retry performs zero detail attempts and
reports exactly `details_not_due`. One metadata-only read (500 ms cap, no raw
payload) also verifies all remaining debt has prior attempts and a future retry
time; an empty due selection alone is not backoff proof. No actual failed detail attempt, exhausted
budget, unknown skip, source/account change, failure-persistence error, or
lock-release error earns this proof. Current account admission and the saved
scope identity must still agree. The producer emits only the finite
`idle_detail_backoff` proof; raw content, identity lists and error text are not
part of it. A persisted `LarkDetailIncomplete` label by itself is insufficient.

Before lossy compaction, a finite `idle_evidence` observation is constructed
from the actual command summary. All failing runs must carry the narrow proof;
other runs must be successful, and there must be no additional unknown failed
or skipped work. The partial exception additionally requires complete, valid
transport counters for every forward step: no retries, rate limits, timeouts,
exhaustion, unknown Retry-After or active/unknown cooldown. Missing, malformed,
or discarded operation evidence is not equivalent to zero. At admission the
finished process must have the expected exit code, no guardian failure and no
unclassified stderr. The resource command still performs its own current
account/lease/cooldown admission; this observation is not an authority bypass.

For `none`, the root should return an explicit zero-work history event from
`beforeHistory`, because returning null currently falls through `||` to the old
history child. This is an intentional conservative optional-work gate, not a
new retry. If legacy fallback is retained for compatibility, it must remain
separate from shared resource admission and must not be described as blocked.
The narrow fix itself requires no extra history or sampling invocation.

Synthetic gates cover real list-producer output, exact zero-attempt/backoff
proof, failed commit/release/source changes, mixed failed runs, malformed or
missing transport, nonzero retry/rate/timeout/exhaustion, unknown operations,
process/guardian/late-output rejection, finite compaction and unchanged cycle
health. Worker wiring separately proves resources-only lane starts and unchanged
common budgets. No production coordination root or upstream request is used.

A completed SQLite child (exit zero, no signal/error, parsed exact audit receipt)
keeps its known committed effects if the work cutoff is observed afterward.
The next operation is denied, but returning those effects and owner cleanup use
the remaining completion interval. A successful commit followed by failed owner
cleanup produces `ok: false`, `commit_state: "committed"` and
`cleanup_state: "failed"`, retains only validated effects, and ends the batch.
An uncertain child outcome never earns that receipt from partial stdout. Existing
transaction audit/CAS evidence remains available for recovery; the command does
not automatically retry an unknown transaction. A finite negative inherited
remainder means ordinary time exhaustion, whereas nonfinite or backward clocks
mean `clock_unavailable`. Neither creates a new grant.

The optional `startedMonotonicMs` is a validated earlier origin in that same
local clock domain, used by the CLI to include actual invocation startup in
both `elapsed_ms` and the work deadline. Future or nonfinite origins fail closed.
It is never a parent process absolute timestamp. Merely shortening the trusted
remainder does not invent elapsed time; a separate explicit invocation origin
accounts for startup in the receipt.


## Integrated behavior and remaining limits

Migration 021 adds only the conservative image-candidate partial index on
`records(source_id,id)`. Its five independent type declarations are combined by
OR, with invalid JSON guarded by CASE. It does not choose a winning type, attach
account proof or authorize a download. The existing source/account/media validator
still rejects conflicts, invalid keys, oversized rows and unproved identities.
All selector entry points use the same index and predicate. Page size, payload
limits, queue capacity, denial isolation and newest/newest/oldest task order stay
unchanged. Existing numeric scan horizons and cursor values remain valid; no
migration resets them. Updates behind a cursor are revisited by the fixed-horizon
sweep and periodic scan. Dense image or false-positive populations still require
bounded continuation; unrelated text no longer consumes those candidate pages.

The executable CLI uses process uptime with origin zero, including its static
imports. An embedded `runCli` call instead starts a fresh invocation origin.
The history budget uses this same-process origin for both remaining time and
elapsed receipts; a cross-process absolute monotonic value is never accepted.
The worker retains its enclosing timeout and two-second guardian cleanup reserve,
and additionally leaves one second *inside* that timeout for history handoff.
Immediately before launch, runStep recomputes both guardian timeout and the
actual history --max-seconds argument after intervening local/activity work.
The child argument can only shrink; insufficient complete seconds start no child.
Every local operation, request and cleanup still checks its own current remainder;
the margin does not replace enforcement. Serialization and stdout are checked
before and after. A late successful write leaves one JSON document, an explicit
stderr diagnostic and a failed exit, so partial stdout cannot authorize success.

Known successful transaction effects remain available even if later cleanup
fails. The history domain preserves its immutable acquisition budget and returns
a separate reporting snapshot; later elapsed-time observations cannot alter a
replay identity or its idempotency hash. Unknown transaction/process outcomes stay
unknown and are never retried as if known uncommitted. No command-expired business
checkpoint is written merely to manufacture a completed receipt. The existing
next invocation reads durable progress and its own current fences.

On failed forward work, `none` returns an explicit zero-work event, preventing
legacy fallback from silently starting a second history path. An already known
history-operation cooldown retains its accurate deferred classification and
retry time, with no child or additional rate-limit count. Only the narrowly proved
old-detail-backoff case admits resources alone. Other lanes retain their age;
ordinary healthy slices retain all three lanes. The forward cycle stays partial.

The default resource directory remains `resolve(db) + '.resources'` to preserve
existing references and pending recovery. The Git rule `*.resources/` now covers
all default database names and nesting, including manifests, quarantine and
pending state. It does not undo already tracked data or prevent `git add -f`;
release checks must still inspect staged paths and newly reachable blobs. Explicit
resource directory overrides require their own private-location exclusion.

The synthetic acceptance includes 5,500 unrelated rows with gapped IDs, six image
candidates whose four fixed targets rank 3–6 newest, exact worker/CLI acquisition,
all fixed targets in JSON/text before and after readiness, continuing new text,
and process restarts. Invalid candidate prefixes preserve bounded progress. The
index's actual write plans and migration were compared on authored populations
up to 100,000 rows; no projection-chain amplification was observed. These are
finite local controls, not production source-to-ready percentiles.

The index migration scans the source table and holds its transaction write lock.
A future approved deployment must use the repository's consistent backup and
writer-free migration process, verify the index and 021 marker before starting,
and preserve the existing qualified rollback conditions. Old f706 initialization
retains the extra index and its write cost. Never drop the index while leaving
its applied migration marker. No production migration or service change is part
of this isolated implementation.

Forward acquisition is still a separate latency stage: the worker serializes
its existing six forward commands; a received batch uses its initial endpoint,
and each scope may perform old detail recovery before the next scope. Existing
fair attempt order is not a successful-acquisition time guarantee. Source time,
first API visibility, retained acquisition proof, original INSERT and first
observed complete CLI output are distinct events. Without per-page visibility
and selection evidence, a source-to-acquisition delay remains unattributed;
neither a fast local INSERT nor successful resource discovery proves that stage
has been fixed. This change does not increase budgets, change the stability
window or claim a universal seconds/minutes SLO.
