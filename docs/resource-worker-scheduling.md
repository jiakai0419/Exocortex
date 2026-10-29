# Resources in the existing worker idle allowance

Isolated design baseline: 53326e1761fd162d316541d99194289f18489c2a. Main remains
the only integrator. This route will not change production, issue real API
requests, increase an API allowance, add a pause system, or replace the existing
resource/identity validators. Fixtures and upstream responses are authored.

The worker already shares one bounded idle allowance between history and remote
sampling. Add exact known-record image-resource work as a third participant.
Keep the existing total twelve CLI attempts, six self attempts and configured
idle time cap. Reserve each unit before it runs; refund only a verified complete
receipt. Invalid receipts and exhausted/rolled-back clocks stop that idle slice.
Foreground collection always proceeds before optional work and between slices.

Service contract: in any three consecutive idle slices with healthy forward
cycles, sufficient metadata/unit budget, trusted first-admission receipts and an
observed start of each selected first lane, every continuously eligible lane
obtains at least one first-service opportunity.
Persist service age/rotation across restarts; new arrivals and failed attempts
cannot reset older lanes' age. This is a conditional opportunity bound, not a
source-to-ready bound or proof that a denied/slow resource can become complete.
Actual source-to-readable observations retain unfinished messages in denominator.

The resource lane discovers only bounded known image records with exact source,
version, resource key and account evidence. It persists deduplicated tasks and
bounded scan progress; claim/result commits use generation/source/account fences.
Serve a newly required resource promptly while keeping historical tasks moving.
One selected resource is a complete acquisition unit with its existing opening
profile, download, closing profile and publication checks. Permanent denial is
isolated for that exact account/resource; new traffic or an unrelated name change
must not reopen it. Transient busy/budget failures defer without resetting prior
completed evidence or issuing extra requests in the same allowance.

Current producer constraints, not optional shortcuts:
- `enrichResources` supports exact IDs and bounded CLI/remote seconds, returns a
  request receipt, and accepts dependency injection. Its CLI has no scheduler
  queue or durable service-age interface today; add a narrow known-record job
  wrapper, not a parallel acquisition implementation.
- A resource unit reserves at least three CLI and two self calls. Valid already-
  available data can use zero calls; originally closed pending data avoids a new
  download but still requires both current self observations. Refund only actual
  validated counts. No per-unit independent fresh allowance is added.
- Downloaded bytes without their original closing account observation are
  quarantined and cannot safely satisfy “never download again.” They require a
  fresh acquisition under the current contract. The non-duplicate guarantee is
  restricted to valid available or originally closed pending evidence; do not
  relax identity evidence to satisfy a test.
- The remote deadline does not cap all local publication/decode work. The worker
  must give the resource child an enclosing remaining-time bound using its
  existing guarded-process boundary, count actual elapsed cleanup conservatively,
  and stop the slice on uncertain termination. No unbounded maintenance tail or
  speculative budget refund is permitted. OS/host failure remains an explicit
  limit, not a proved unconditional latency bound.

Proposed narrow interfaces and ownership will be recorded before changes to
shared modules. Tests must drive real worker/CLI/resource paths with synthetic
source rows and responses, including continuous identity traffic, fairness,
restart, busy continuation, no duplicate available/closed-pending download,
denial isolation, source/account/CAS drift, budget and clock failure. Existing
status/messages presentation is outside scope.

## Worker interfaces and whole-child admission

The worker imports the read-only `resourceWorkAvailable(db, deps)` hint from
`src/maintenance/resource-work.mjs` and starts one complete unit through
`maintenance resources --max-cli-attempts 3 --max-self-attempts 2` with the current
remaining seconds. A resource receipt must carry `known_record_resources/v1`,
finite safe counters, and the exact granted request limits. `runStep` projects
only that safe resource vocabulary, never IDs, paths, names, raw responses or
arbitrary errors. The existing history event remains the enclosing idle receipt;
no extra forward cycle step or presentation redesign is introduced.

A resource child's guardian work timeout is clipped to the live remaining idle
allowance minus the existing 2,000-ms outer cleanup allowance. Its remote seconds
are also clipped to that work budget. History children invoked inside the shared
slice receive the same enclosing remaining-time limit. Insufficient remainder,
clock rollback, failed cleanup or an untrusted receipt stops the slice; actual
elapsed time includes the child, local tail and cleanup. A slice with history or
resources retains the existing 25-second cap; a
sampler-only slice retains its prior 55-second cap, both further clipped by
the configured idle interval. Eligibility-hint reads are charged from the same
start instant. This slice is an admission envelope under the existing guardian's
OS assumptions, not a promise
that cleanup failures or host suspension can never overrun it.

`idle-fair-state.mjs` stores only per-account lane service sequence in migration
020. A strict local confirmed account/database snapshot and a short ordinary
probe commit lease protect the first-admission CAS. Busy admission leaves state
unchanged; a successful claim advances before the child starts, even if that
child later fails. Its CAS deadline reserves at least six seconds for a resource
unit
(four seconds for the wrapper, plus two cleanup seconds). The producer needs
at least three whole seconds for its two fixed inter-request gaps; the extra
wrapper second avoids ordinary preparation/flooring immediately reducing that
to two. Preparation can take longer, so the wrapper must recheck before its own
claim and before acquisition, safely deferring with no API if less remains.
History/sample keep their existing smaller admission thresholds. A committed
claim whose result is unknown or arrives too late is
not counted as actual service: the slice stops, retains its already committed
sequence, and never invents a child attempt. Sample/history/resources order by
persisted last committed-admission
sequence, with that fixed order breaking ties. New arrivals never reset stored
age. The local metadata claim does not invent a remote self observation or add a
CLI call. Real resource acquisition still performs its opening and closing self
checks. Missing/untrusted fair state fails closed for optional work.

Synthetic `runCycle` injection does not implicitly query the real resource queue
or fairness database. Tests must explicitly inject `runResources` (and optionally
`hasResourceWork`, `readIdleFairState`, `claimIdleLane`) to enable that lane; normal
production execution uses the actual queue, CAS and guarded CLI. Injected-memory
fairness validates orchestration only; persistence tests use authored SQLite.

The three-slice statement concerns consecutive successful admission intervals;
it must not be applied by removing intervening failed/unknown admissions from a
denominator. A committed metadata sequence is not evidence that a child ran.
Late or uncertain commits remain unknown admission outcomes. The wall-time
service bound additionally depends on foreground-cycle duration, application
sleep, upstream visibility and available capacity. It is not a 60/120-second
source-to-readable SLO, and does not prove any production percentile.

Default queue/history availability reads share a two-second local hint budget
clipped to the same slice. Resource eligibility is checked before the potentially
multi-query history hint, and neither defaults to its own independent 30-second
read timeout. Hint time, fair-state reads/claim, job work, inter-job gaps and
cleanup all consume the same elapsed allowance. An unknown hint does not invent
availability or a free timeout.

Final focused author validation: 30/30 worker-idle/history cases and 100/100
existing worker/core/sample cases pass; the independent persisted-state suite
passes 24/24. These include real guarded-child timeout and actual request-session
fixed-gap tests with synthetic inputs. They do not replace the separately owned
real worker/CLI resource-chain acceptance or production latency observations.
