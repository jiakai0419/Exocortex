# SQL profiler observation boundary

## Follow-up to 2020285: primary path and bounded evidence

The structural primary profiler again delegates exactly one TextIO.read call.
It inherits that stream's encoding, errors and newline semantics. The separate
CHUNK_PROFILER is a byte/EOF calibration using read1 and strict UTF-8 decoding;
only declared calibration controls select it. Passing calibration never proves
that the original primary read path passed or explains the original 6be stall.
Neither path changes 30 seconds, 4 MiB, SQL consumption, opcode/prepare/result
limits, original cohorts or database assertions. Product SQL and guardians stay
unchanged.

Method-dispatch controls distinguish one delegated TextIO.read from read1,
including an original-read exception, valid/split multi-byte UTF-8, declared
Latin-1, surrogateescape, CRLF and malformed input. An original-read exception
must fail both direct and nested primary execution before SQLite. Calibration
keeps its own explicit label and EOF/invalid-byte controls. Callback and timer
errors in the delayed-EOF control enter the existing first-error/owned-child
kill-and-close path; they cannot escape as uncaught EventEmitter exceptions.

Unexpected primary transport/status/JSON/complete-report failures retain only
bounded authored evidence: exact serialized input when within the cap, the
profiler script, and pre-attempt copies of the fixture DB and existing WAL/SHM.
These are file captures, not an asserted consistent SQLite backup or replayable
transaction state. Unknown completion or commit remains unknown. No extra
attempt, process inventory, failed-child probing or automatic replay is added.
Expected-negative controls do not consume the unexpected-failure allowance.
The retention limit is four fixture captures and eight MiB per capture, with a
fixed file allowlist and finite metadata; oversized/missing/failed evidence is
explicitly unavailable, never silently presented as exact. This does not cover
arbitrary later test assertions after a valid report was returned, nor a
status-zero outer driver's JSON parse failure. The actual nested Python profiler
has the same explicit transport/parse/incomplete-report capture as direct calls.

Startup fingerprints are limited to the explicit command/argv shape (inline
driver source represented by its hash, not mistaken for a Python argv), Node
version/platform/architecture and executable-path hash, actual Python's own
version/executable-path hash/stdin encoding/errors/UTF-8 mode, and the presence,
length and hash of a fixed preload/encoding environment allowlist. No environment
value, credential, preload file or runtime-private directory is read or emitted.
These observations describe a new attempt, not the uncaptured old environment.
Retention or observer errors cannot replace the original spawn/status/parse
failure. Successful runs clean their temporary evidence normally.

The original 6be stdin-stage timeout remains unexplained. The prior independent
14/17 and corrected valid-receipt 3/3 retain separate denominators. Current
production images, app names and minute-scale completion remain separate open
outcomes. This test-only change is local, with no release authorization.

## Earlier observation contract (historical context)


Design v0.2, implemented observation and finite controls. Base129ac2c164de3937213dbb5a7b12f90f78b7c1a6.
The original full-run timeout remains a failed, unexplained observation. Its only
child trace was startup: it does not establish import completion, stdin EOF,
JSON decoding, connection, SQL preparation or execution. One later success is
not a diagnosis or a replacement pass. Do not change product SQL or transport.

Apply the independently reviewed test-only phase patch. Preserve the original
30-second child timeout,4MiB output cap,500k prepare cap,opcode/result budgets,
[1,12,100]cohort,complete-program and source-DB-byte assertions. The child clock
keeps its original start; add module import,one delegated stdin.read and JSON
parse boundaries. Parent observations retain actual input bytes/hash, one
serialization, real spawn start/return, status/signal and known/unknown output
length. Emit evidence before original failure assertions. Child internal clocks
must not be substituted for complete parent spawn time. No rawSQL in telemetry.

Add finite authored controls for boundary attribution and fail-closed behavior:
normal phases,import delay,delayed EOF,invalid JSON,child exit,missing executable,
output overflow and a success-looking result followed by an actual30-second
transport timeout. No shortened-budget control is called a30-second proof.
Any test injection applies only to disposable synthetic scripts or private
observer callbacks; standard cost measurements use unchanged defaults and do
not skip assertions. No process inventory,API,production data/service/native
build or permission change. All failure and non-reproduction records remain.

Only observability and its regression controls are in scope. Root owns shared
implementation; independent review checks budgets and evidence claims. Frozen129
stays unchanged. New code must be fully verified and independently reviewed,
and any new CI/push/deployment requires separate approval. The production writer
ps check remains denied pending the user's specific response.

## Implemented evidence contract

The shared original cost helper still defaults to real spawnSync,python3,one
JSON.stringify and the original options. Only its private fourth argument can
capture events or replace the spawn adapter for declared controls. Before/after
metadata is written before original failure assertions; a synchronous throw
emits an unknown execution outcome then rethrows the same object. ENOENT is
separately exercised through an actual nonexistent executable. Absent output is
null, while observed empty output is0bytes. No output shape is promoted to a
successful SQL result; original report consumption and DB checks remain.

Sixteen authored controls cover ordinary phase order,pre-clock/import waits,
delayed EOF,malformed stdin,exit7,ENOENT,synchronous throw,actual output overflow,
actual30-second timeout after a successful child report,signal-only termination,
empty/malformed stdout,parsed null and valid transport output near4MiB. The
asynchronous delayed-EOF case proves read/EOF boundaries only,not a reproduction
of the original spawnSync failure. Its output collection and watchdog are also
bounded. The real30-second control remains for the complete frozen verification,
not replaced by the earlier independent1-second calibration.

The child capture cap remains4MiB. Parent JSON escaping can make diagnostic text
larger; do not describe that cap as a limit on serialized parent log lines.
Child normal trace count stays512 and includes no SQL. Parent observer time ends
at spawn return,excluding the after-log and assertion/cleanup costs. Child trace
time excludes interpreter initialization and imports preceding its original
clock. Stage intervals can contain scheduler or I/O waiting; none uniquely
identifies the original cause. Nested measuredRun keeps its existing parent
transport and90-second wrapper; its child inherits the new profiler trace only.

No product,generated files,migration,native artifact,dependency,service or account
changes. Prior129full failure6481/6486 and original184CI6482/6484 are immutable
historical results. Any later pass is new evidence and cannot rewrite them.

Observation sink failures cannot overwrite an original thrown value,returned
child error,status failure or JSON parsing failure. After a successful transport
and parse,an observation failure itself still fails verification. Two additional
unit controls exercise that precedence; they are not OS fault injections. EOF
control arms its declared250ms delay only after both read_start and the parent's
write callback have been observed. On error it kills only its owned child and
waits for close before fixture cleanup; watchdog firing is an explicit failure,
even if a zero-status close is delivered concurrently. The30-second control
captures the real result through one transparent spawn call and independently
parses and checks its successful SQL report after the original helper rejects
the timeout. No additional child execution is hidden in that verification.
