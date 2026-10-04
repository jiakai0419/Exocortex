# Activity evidence

This design extends the existing Node worker, its bounded local JSONL log and read-only status snapshot. It adds no service, database table, polling loop, or remote request. Activity answers what a verified local process is doing now; health, historical success, catch-up and remote freshness remain separate questions.

## Implementation boundary

| Existing boundary | Previous gap | Implemented change |
| --- | --- | --- |
| Worker cycle/step events | Written after completion; cannot identify the current step, cycle gap or scheduled wait | Append a small activity event at cycle/step transitions and before the interval wait |
| Service activity | Treats an unexpired reservation as active work; falls back to completed history for idle | Evaluate current phase, process identity and deadlines; retain unknown when evidence is unavailable |
| Sync-lock snapshot | Owner already contains PID and process-start time, but public projection discards it | Read-only strict owner inspection while projecting the same snapshot; expose only an additive safe owner-state enum |
| Worker restart | Cycle numbers restart and old events survive | Bind activity to a worker instance, process-start evidence and database; compare the observed process identity |
| Database-only status and doctor | `running` rows and locks were treated as current work | Return unknown activity with explicit database-only evidence; legacy `health: syncing` is unverified without a phase |
| Terminal/JSON | Existing activity status has `syncing`, `idle`, `unknown` | Preserve this compatibility field; add exact `state` (`syncing`, `waiting`, `stopped`, `unknown`) and optional phase/cycle/update evidence |

## Evidence and transitions

The worker emits `lark_im_worker_activity` alongside existing history events. Each event contains a format version, random per-process instance ID, PID, OS process-start timestamp, hashed database identity (canonical path, device, inode and birth time; never mtime), cycle number, an allowlisted phase/step, `updated_at`, and `valid_until`. No message text, scope ID, username, command line, credential or private path is included. Each genuine phase update reads the current database file identity; a missing, inaccessible or non-file database has no usable identity and remains unknown. This lets initialization acquire its identity on a later real transition. Symlink aliases normalize to the same file; replacing the database at the same path changes the binding. Status reads file identity before and after its database/log/process observations; any change or unavailable identity invalidates current Activity for that sample. The process-start timestamp must be observed successfully; PID existence alone is insufficient. Start-time matching is at the OS reporting resolution, which is explicitly separate from PID equality.

The worker reports cycle entry and the short gap before/between steps, then the step immediately before its existing synchronous subprocess call. A step remains current only until its configured hard subprocess timeout plus a small scheduling allowance. The gap has a short fixed deadline. After a cycle completes, the worker reports the scheduled interval wait with its next-run deadline. Normal exit emits `stopped`; a crash cannot write that event. There is no fabricated heartbeat while JavaScript is blocked in a subprocess: the phase timestamp and finite operation deadline state exactly what was observed. A process that remains alive after its phase deadline yields unknown.

Status reads the latest activity evidence from the bounded current log and validates its shape, time interval, database identity, instance, process-start identity and process liveness. A running launchd worker must match the evidence PID. A phase written inside the OS start-time one-second bucket remains unknown, because a same-second PID reuse cannot be excluded. A malformed or incomplete log line invalidates phase evidence instead of falling back to an older fresh phase. At most 32 unique processes are inspected in one OS command with a two-second timeout; omitted instances remain unknown. Clock regressions, malformed/future timestamps, expired phases, unavailable process inspection and contradictory identity all yield unknown. Log rotation can make phase evidence unavailable; old successful cycles never substitute for it. Process inspection is bounded and does not print command lines or mutate/recover locks.

The log reader, latest-instance selector and event evaluator share one required-field schema. A JSON object with the activity type but missing version, role, instance, parent, process, database, phase, cycle/step or time fields is damaged evidence, even when it parses successfully; it cannot become a separate anonymous instance that leaves an older phase usable. Explicit `null` remains valid for unavailable process/database identity and for absent parent/cycle/step values. Such an identity cannot prove activity, but initialization can replace it with a later complete observation. Worker roles accept cycle, step, between-steps, waiting and stopped phases; sync-command roles accept sync and stopped. Schema validation handles field types and finite intervals; the evaluator separately handles observation time, expiry and OS identity.

Independent foreground sync commands append their own start, actual scope-transition and stop events to the same private JSONL log without altering command JSON stdout. A standalone command has only a five-second **observation freshness** window, not a fabricated hard operation timeout. Long synchronous operations therefore become unknown until the next genuine transition; continuous foreground SYNCING is not promised. Worker children carry the parent instance and log directory through the subprocess environment, and OS PPID must match that parent. Missing/conflicting parent identity cannot turn a worker child into an independent foreground override. Parent classification uses explicit parent-instance evidence and the currently observed worker process identity plus OS PPID. A historical worker PID alone does not retain that role after PID reuse. The worker's actual hard subprocess timeout bounds its step phase; lease renewal never extends a phase.

The existing lock owner is inspected strictly as secondary evidence, using the same coherent database snapshot. Public locks add only `owner_state` and `owner_observed_at`; they never expose PID, owner string or paths. A lease, including one owned by a live process, cannot establish syncing without a phase. Any unidentified/live possible owner prevents an overall waiting/stopped claim when no current phase explains it. Expired reservations do not prove that the process stopped. Process observations are later observations, not atomically co-sampled database facts.

Decision order:

1. Global log-schema and database-identity integrity must hold before any positive activity claim.
2. Classify all sync processes before deciding. A fresh independently verified foreground phase proves `syncing` for this database, even if another worker or child is contradictory or orphaned. This proves the independent operation only; it does not explain or validate the other process. An anomalous child never enters the independent set.
3. Without such independent evidence, conflicting worker/child evidence remains unknown; otherwise a verified worker executing a cycle/step means `syncing`.
4. A verified worker in its declared interval, with no contradictory active foreground work, means `waiting`.
5. A definitely stopped background service and no live/unknown scope owner or phase means `stopped`; unfinished historical events do not resurrect a dead process.
6. Missing, stale or contradictory evidence means `unknown`, with a short reason. An unknown launchd result cannot become a green waiting state.

A recently observed, verified independent foreground phase may be syncing while the background service is stopped. A running service without phase evidence is unknown, even when its last cycle succeeded. A crashed process with an unexpired reservation is not syncing. Expired reservations remain diagnostics; they never extend the activity deadline. Existing `status: idle` is emitted only as the compatibility representation of the precise waiting/stopped state, never as an inference from historical completion.

## Consistency between diagnostic entry points

`sync-status` has a coherent database snapshot but does not collect worker phases. Its additive `current_activity` therefore explicitly says `state: unknown`, `evidence: database_only`, and distinguishes `unverified_sync_history` from `phase_not_collected`. A running row or lock makes its health unknown rather than syncing. `doctor` preserves that uncertainty, returns `ok: false` for this unknown state and never calls a legacy database-only `health: syncing` current work. Local readiness without outstanding running history remains a data-health result, not an activity claim.

Service status has additional bounded phase and OS observations and can consequently establish syncing/waiting where database-only diagnostics cannot. It re-evaluates the existing historical health function without treating running counts as current work. A verified phase can explain database-only unknown history, but failed-only history, initial or unsuccessful scopes, incomplete detail debt and source-coverage limitations remain independent health problems. All three entry points share the rule that reservations and historical running rows never prove current activity.

## Testable invariants and synthetic matrix

All clocks, PIDs, start times, database names, events and locks in tests are newly invented. Tests never read operational logs, processes or databases.

| Situation | Required result |
| --- | --- |
| Live matched worker, fresh cycle gap, no lock | Syncing throughout the gap |
| Live matched worker, fresh step, no lock | Syncing with current cycle/step |
| Live matched worker, fresh declared interval | Waiting; phase update and finite validity remain explicit |
| Fresh event but dead process | Never syncing/waiting |
| Same PID with different OS start time, or an event inside the same second start bucket | Never syncing/waiting |
| New launchd PID with old instance event or reset cycle number | Unknown until matching new phase arrives |
| Live process, expired/future/invalid phase | Unknown, not automatically waiting |
| Failed/denied process inspection | Unknown, not alive-by-default |
| Stopped launchd, fresh phase with matched live independent foreground process | Syncing without pretending launchd runs |
| Fresh lease with matched live owner but no phase | Unknown, never syncing |
| Independent foreground phase older than five seconds | Unknown until a real transition is recorded |
| Worker waiting with a live child phase or missing child-parent binding, and no verified independent work | Unknown, never promote the child to independent foreground |
| Verified independent foreground plus fresh/expired orphan or current worker contradiction | Syncing from the independent phase; unrelated states remain unexplained |
| Historical worker PID reused as an independent command’s parent | Old worker identity does not misclassify the new parent; current worker PPID still prevents child promotion |
| Required activity field missing in a syntactically valid JSON tail | Global evidence is incomplete; report and CLI must not fall back to an older phase |
| Explicit unknown identity followed by a later complete phase | Unknown initially; a later genuine observation can establish activity |
| Stopped launchd, freshly verified dead leftover owner | Stopped with independent stale-lock warning |
| Expired lease with live/uninspectable owner | Unknown, never proof of stopped |
| Unexpired lease without identity or unavailable owner inspection | Unknown, not syncing |
| Completed or 33-day-old unfinished history only | Never current activity evidence |
| Phase/lease crosses its deadline during diagnostic collection | Evaluate against the final observation clock |
| Same-path file replacement, symlink alias, missing file, and replacement during diagnostic sampling | Old phases cannot prove work on the replacement; aliases agree; unavailable or changing identity is unknown |
| Other database, malformed activity, rotated/truncated evidence | No positive current-state claim |
| Worker returns/throws during a cycle | Final stopped event; failures remain historical health evidence |
| Legacy running row with no lease; expired reservation; live/dead owner | Status and doctor remain unverified, doctor does not return true; service requires independent phase evidence |
| Public JSON compatibility | Existing fields keep meanings; optional new state/evidence contains no identifiers or paths |

Run focused worker, activity, service and terminal tests, then the repository build, typecheck, syntax, full suite and generated-file consistency checks. This local candidate changes no production process, log, database or service configuration. Optional phase writes never interrupt business synchronization. A failed append cannot reliably retract an earlier observation through that same failed log channel; its existing finite validity window remains the upper bound, so the display is an observation rather than an atomic process trace. A later authorized restart is required before an existing worker can emit the new phase events; legacy logs remain readable but cannot prove a current phase.
