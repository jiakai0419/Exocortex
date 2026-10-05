# Remote sample process lifetime

This isolated candidate changes per-attempt supervision, not scheduling. Production
activation and actual OS lifecycle acceptance remain a separate review gate.

## Alternatives and decision

| Approach | Identity and completion properties | Decision |
| --- | --- | --- |
| Ignore EPERM after worker exit | Cannot distinguish a zombie-only group from live descendants that could not be signalled | Reject |
| Reap the leader before killing its numeric group | Releases the identity that protects against reuse | Reject |
| Kill only the worker PID | Does not clean inherited API-lock descriptors in descendants | Reject |
| Keep a group leader alive and use a private completion channel | Preserves group identity and separates job completion from process cleanup | Select |

The old watcher was registered after starting a possibly short-lived worker. The
new control pipes exist before the group leader starts, so a fast completion is
buffered rather than depending on a later process-exit subscription. No kqueue or
waitid capability is needed for the new producer. Historical diagnostic stage
names remain readable for compatibility.

Python documents that `start_new_session` invokes `setsid` before executing the
child ([subprocess](https://docs.python.org/3/library/subprocess.html#subprocess.Popen));
Apple documents the resulting process-group leader identity
([setsid](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html)).
A zombie-only group returning EPERM is a historical candidate mechanism in
[published XNU source](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/kern/kern_sig.c),
not an established cause on the target host: exact-version official source was
not obtained. This design neither depends on that diagnosis nor reclassifies an
observed permission error as successful cleanup.

## Protocol and ownership

The external guardian starts one short-lived Python anchor with
`start_new_session=True`. The anchor is the group leader and does not start work
until a valid GO frame arrives. Its private status pipe sends READY, then exactly
one DONE with the worker exit code or ERROR with a finite stage and errno. Each frame is at most 256 bytes. Frames
are bounded JSON lines; malformed, duplicate, oversized or out-of-order frames
fail closed. The pipes are created before spawn, are nonblocking, and are never
passed to the worker or its CLI descendants.

The worker shares the anchor's process group. The anchor can reap the worker
without releasing the group's leader identity. It stays alive after completion.
The guardian never polls or reaps the anchor before its one group-termination
attempt. Successful completion requires the worker's confirmed zero exit,
valid protocol, successful group termination and an anchor reap bounded to one second. After successful reap, the private status pipe must be empty and at EOF. The
anchor's expected SIGKILL is cleanup evidence, not the worker's exit code.

One absolute monotonic deadline covers startup, handshake and work. Output is
limited to 64 KiB, and control frames have a separate small bound. Caller exit,
signal, deadline and protocol failure all enter the same single cleanup path.
Cleanup failures remain separate from the first primary failure. EPERM is never
retried, ignored or converted to proof that cleanup succeeded.

The guardian is the only process permitted to terminate the group. The anchor
does not silently take over after a denied kill. If the guardian itself is killed
or crashes, the anchor can detect pipe closure/parent loss and terminate itself
within its finite lifetime, but this does not prove descendant cleanup. This
explicit limitation avoids an implicit second kill attempt. Normal caller death
is different: the surviving guardian observes its caller and performs cleanup.

## Cache publication

Worker completion is not sufficient to publish positive diagnostic evidence.
The existing nonblocking flock moves outside the guardian and remains held
through publication. It is scoped to the shared cache destination within the
log directory, so different database identities cannot concurrently replace the
same cache. There is no second lock or scheduler. The wrapper execs its current
Python interpreter; it does not assume `execv` searches PATH.

After validating the inherited lock, the guardian writes a durable unavailable
`attempting` marker before it creates pipes or starts the anchor. The worker
writes the existing bounded private cache format to one attempt-specific UUID
stage, which status never reads. Its internal completion code is 0 only after a
complete stage write, 3 for a deliberate busy/not-due skip without a stage, and
2 for preparation failure. Code 3 is recognized only in cache mode; it does not
publish a stage. A stage missing after code 0 is a publication failure. Thus a
stage left behind after its writer's fsync failure cannot become evidence.

All control/capture cleanup, successful group kill and bounded reap precede
publication. The stage and target must be private, owned regular files with one
link, bounded size and stable identities; paths use no-follow operations. A
capture-mode result is written and flushed before publication; its consumer
must also require successful process exit. A later commit failure exits 2 and
is safely projected as `guardian_result`, since the output channel cannot be
rewound to add a second diagnostic JSON value.

The final rename is the cache commit. Stage/directory synchronization and a
last caller/deadline/stop check happen before it, followed only by immediate
process exit. This cache is deliberately ephemeral: a power loss may lose the
new result, but the prior durable unavailable marker prevents old healthy
content from being revived. Schedule state retains its existing durable write
policy. A failed attempt never performs a parent-side write after releasing
the lock. If interpreter startup, lock validation, or marker creation itself fails,
the existing file may remain readable until its original TTL; no timestamp is
renewed and no worker/API call begins. A process unable to write the marker
cannot truthfully promise immediate invalidation. Failure cleanup may remove
only that attempt's unique stage; denied
file operations are not retried or repaired automatically.

The cache contract introduces no API request or business-record write. It does
not change sampling, schedule intervals, account binding or status presentation.

## Minimal counterexamples and provenance

| Counterexample | Origin | Required behavior |
| --- | --- | --- |
| Worker exits before a process watcher is attached | Existing watcher design | Precreated READY/GO/DONE pipes preserve completion |
| Fast worker leaves a zombie-only group, or a live descendant remains | Existing cleanup ambiguity | Retain live anchor; never reinterpret EPERM as success |
| Worker publishes healthy before later cleanup fails | Existing publication order | Stage only; guardian commits after cleanup |
| Old parent fails after a newer attempt commits | Existing parent failure writes | No lock-free parent invalidation |
| Different database keys share one cache destination | Existing per-database lock scope | One destination-scoped existing lock |
| Outer lock wrapper receives `python3` for `execv` | Introduced while moving the lock outward | Exec the already-running interpreter |
| Stage rename succeeds but the writer's fsync then fails | Exposed by new deferred publication | Preparation failure is a nonzero terminal result |
| Pipe/anchor startup fails before the worker begins | Introduced by removing parent invalidation during lock move | Durable marker under lock before startup |
| Output flush or deadline fails near final commit | New deferred-publication boundary | All failure checks precede final rename |
| Duplicate terminal frame arrives in a separate read | New completion protocol | Successful cleanup must finish with empty status EOF |

## Acceptance boundary

Only static checks and OS-mocked state-machine tests are authorized in this
iteration. They cover very fast worker exit with code 0 and 7, retained live
descendants, startup/completion ordering, control EOF and malformed frames,
caller exit, shared deadlines, output bounds and cleanup failures. Fixtures are
invented; no real trace, host paths or business identifiers belong in Git.

Actual process groups, signal delivery and lock release remain unverified until
independent review authorizes a bounded synthetic acceptance run. Do not infer
runtime acceptance from the mocks or from source analysis on another kernel
version. The minimum future acceptance matrix is:

1. Fast no-descendant worker exit 0 and 7: preserve result, finite cleanup, no
   residual group, no EPERM suppression.
2. Worker exits while a synthetic descendant retains the API-lock descriptor:
   group cleanup removes the descendant and the lock becomes available.
3. Caller exits, requests stop, or hits the shared deadline during startup and
   work: one group termination attempt, finite reap, unavailable cache.
4. Seed a private healthy synthetic cache, then fail startup, stage preparation,
   cleanup, and final publication: old positive evidence is never renewed.
5. Contend two attempts (including different database identities) for one cache:
   one lock owner, no old completion overwriting a newer committed result.

Each case must use temporary synthetic files and identities, no remote API,
production service or business database. Observe only those test-owned PIDs and
files. Stop at the first unexpected error without retries or changes to
permissions or execution context. Guardian crash/SIGKILL is a documented
unsupported cleanup guarantee, not a passing case in this matrix.
