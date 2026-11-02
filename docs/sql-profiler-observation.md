# SQL profiler observation boundary

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
