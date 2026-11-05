# CI observation and resource deadline boundaries

Design v0.2, implemented test-only observation. Base 184a1b790794c50f16b82882d6cf0437443e1855.
Two CI failures must remain failures until their mechanisms are identified. The
name-worker test only reported that its proposed two-second commit-to-complete
JSON/text observation was exceeded. It did not emit the actual interval before
its assertion, and the temporary fixture was then deleted. Total test duration
cannot reconstruct that interval or establish product latency. The resource
guardian test returned before a synthetic tail-entry marker existed under its
300ms whole-child deadline. That alone does not distinguish child startup
expiry from a guardian or cleanup defect. No new source/API permissions apply.

Observe finite source/available/discovery/preparation/commit/reader stages with
real monotonic I/O. Keep first observations, full unresolved population, complete
identity/content and actual JSON/text assertions. Audit work must be distinguished
from the time taken by each public read without subtracting real delays from the
end-to-end upper bound. Emit diagnostics before assertions/cleanup. Do not alter
2s/120s checks or rerun until green without evidence and an explicit reviewed
replacement contract. No production SLO is inferred from these fixtures.

For the guardian, separately test startup expiry and success-looking output
followed by an unfinished local tail. Preserve absolute command/remaining budgets,
cleanup reserve and rejection of an incomplete child even when JSON parses. Any
fixture redesign must prove both phases, keep original failures and demonstrate
that unsafe acceptance would fail; do not change runtime budgets merely to make
a precondition likely. Root owns integration; separate owners investigate the
name worker and guardian test paths without concurrent shared-module edits.

No candidate release is authorized by this document. Exact184 remains frozen and
remote; production remainsf706. Changes, if necessary, need newSHA, complete local
verification and release review. All inputs are newly authored; no real data,
process inspection, network API, native rebuild or production change occurs.

## Implemented verification changes

The name-worker test now records the snapshot and source-audit prefix, each
actual JSON/text command, JSON parsing and the first-visible timestamps. It emits
these finite synthetic diagnostics before timing assertions and puts numeric
intervals in assertion failures. The original order, commit timestamp, 2-second
post-commit bound, 120-second source bound, worker timeout and all source/identity,
content, order and read-only assertions are unchanged. No component is subtracted.
A separately injected 2100 ms audit delay still failed the original 2-second gate
and retained diagnostics. Local successful samples do not explain the original
CI failure: its exact interval was not retained. This is preparation for a future
instrumented CI run, not a claimed repair of that unknown latency cause.

The resource test distinguishes exhausted admission, delayed anchor startup and
an entered local tail. Its tail fixture uses shell builtins followed by sleep,
so unrelated Node cold startup does not consume the short fixture allowance.
The real guardian and monotonic clock remain unchanged. Internal work allowance
is at most 300 ms, starting after the guardian's Python initialization; anchor
startup and the worker spend that allowance. The outer timeout remains at most
2300 ms, including interpreter startup and the 2000 ms cleanup reserve. Tests
require failure, the specific deadline diagnostic and successful cleanup; the
tail case additionally requires exact success-looking stdout and its marker.
No retry, clock freeze, widened timeout or hidden precondition is introduced.
The original CI marker failure lacks enough evidence to identify its exact phase.
Arbitrary host suspension can still expire admission before any tail is entered.

Both changes touch tests only; product code, generated output, migrations and
native artifacts remain identical to the approved base. The four local protected
process prerequisites remain unverified here. Their success in the original
6482/6484 CI result is separate evidence and must not turn a later partial local
run into an all-green result. Production writer inspection was separately denied
before execution and is not retried or replaced by an indirect process query.
A new candidate requires its own release approval and complete CI. Neither
production SLO nor fixed production resource/name gaps are closed by this work.

## Follow-up after exact779 CI

The exact779 run41399995316 completed6502 tests:6501passed,1failed,zero
skips/cancellations. Its sole failure was the slow-tail entry marker, before the
fixture reported captured output or guardian diagnostics. The502ms case duration
does not identify the failed stage or prove the internal300ms grant was exceeded.
The four previously protected local process cases passed in this same CI run;
that does not turn the failed run into a release gate pass. Production was not
stopped or migrated. Original logs remain private release evidence.

Verification design: execute the entire resource-worker-idle.test.mjs file once
in its own concurrency1 phase before the remaining concurrency4 files, within
one complete verify invocation. The disjoint union must equal the discovered
complete test set. Either phase failure stops verification with a nonzero exit;
there is no retry, skip or name-pattern filtering. npm test retains its existing
general parallel entry; the release gate uses verify. This removes concurrent
files created by this verification suite, not arbitrary host contention, and is
not proof of the historical CI cause.

Before its first assertion, each real guardian fixture emits only finite synthetic
phase facts: grant, outer timeout, elapsed interval, marker presence, captured
byte lengths, expected-JSON match, process status/signal/error and sanitized
guardian diagnostics. No clock, deadline,300/2300/3000ms threshold, cleanup rule,
marker or JSON prerequisite changes. A missing tail marker remains failure; a
new candidate requires complete verification and separate publication approval.

Implemented bounded validation: the two affected files passed36/36 in one
serial invocation after a new nested-test control was corrected to remove the
parent Node test-runner context from its child environment. Its initial35/36
failure remains recorded; the corrected control requires no launch error or
signal,exit1 and the authored failure text, rather than accepting any failure.
Both real guardian cases retained299ms granted work and2299ms outer backstop in
this sample. The tail marker and exact JSON were observed before a deadline with
successful cleanup. This local sample does not explain the CI marker failure.
The complete fixed-revision verification and independent review remain required.

## Exact866 failure: bounded phase diagnosis

The exact866 first CI run41992842765 failed the unchanged real-tail prerequisite:
the serial file reported35/36, and the remaining suite was not run. Its guardian
returned `deadline` without a cleanup error, but there was no worker stdout or
tail marker. This does not identify whether the deadline expired before READY,
between READY/GO and worker startup, or after worker entry. The normal fixture
never wrote its old anchor marker, so that marker's absence is not startup
evidence. The original log and earlier failures remain failures; a successful
local run cannot reconstruct them or identify a runner/CPU cause.

Before further execution, add a test-only bounded stage ledger to the same
generated guardian and anchor source. Match every injection point exactly once
and bind both originals by SHA256. Observe imports complete, deadline creation,
anchor spawn, READY/GO, worker spawn, capture, cleanup and envelope publication.
The shell records entry/output/tail using builtins with no invented timestamp.
Each Python process records its own monotonic and CPU clocks; do not subtract
Node performance.now from Python timestamps. Keep the finite observer files
separate from the actual stdout/envelope. Missing or malformed events remain
unknown, never inferred from duration or replaced by synthetic success.

The real300ms work cap,2000ms cleanup reserve,2300ms outer bound and3000ms
overall assertion stay unchanged, as do all original marker/JSON/deadline
assertions. Observation cost is charged to the existing clocks. No prestarted
helper, clock reset, enlarged grant, retry, or skipped prerequisite is allowed.
Only authored finite controls may deliberately pause at identified boundaries;
their results demonstrate mechanisms, not the historical cause. Recorder and
assertion negative controls must reject missing/forged observations. Product,
production data, permissions and the failed release remain untouched.

The first instrumented results select any subsequent correction. If they do not
reproduce the unforced failure, report that limit and retain the diagnostic
candidate for independent review; do not call the historical cause repaired.

Implementation remains four test/document files, with no product change. A
failed fixture retains its raw ledgers, final executed guardian/anchor sources,
source hashes, raw outer stdout/stderr and an evidence manifest. Successful
fixtures are cleaned only when no unexplained outer stderr needs retaining.
The parser requires phase-specific fields and causal predecessors; a valid
partial ledger is only a list of observations, never a completion verdict.
Normal anchor-marker now reports null because that old marker was never wired
there. Cleanup-null is described as no reported error, while separate events
prove only the actual owned-group syscall return and anchor wait return.

The first instrumented run passed53/53: normal tail entry/output were observed;
authored400ms pauses distinguished GO-to-spawn and worker-entry-to-output gaps.
Those controls are not historical reproductions. Independent pre-review found
retention and missing-field holes; after correcting them, the first expanded
run passed107/107, including original guardian lifecycle and verify inventory
regressions. Original missing-tail and exact-JSON assertions are preserved in
one shared function with negative controls. A success-looking mock envelope
with cleanup failure is rejected through the actual wrapper and runStep.
P2 claims only no observed spawn return, plus same-guardian timing proves its
group kill returned before the authored400ms pause could finish.

The expanded local run retained an outer Apple Python warning about confstr
failing to find DARWIN_USER_TEMP_DIR and falling back to/tmp. It was110bytes;
the first run retained only its length, so matching content is not presumed.
Original CI had0 outer stderr bytes. This local warning is not an explanation
of that CI failure. The unforced historical failure was not reproduced, and
its precise expired stage remains unknown. Complete fixed-SHA regression and
independent review are still required; no new release is authorized here.
