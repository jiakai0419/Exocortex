# Activity evidence

This design extends the existing Node worker, its bounded local JSONL log and read-only status snapshot. It adds no service, database table, polling loop, or remote request. Activity answers what a verified local process is doing now; health, historical success, catch-up and remote freshness remain separate questions.

## Implementation boundary

| Existing boundary | Previous gap | Implemented change |
| --- | --- | --- |
| Worker cycle/step events | Written after completion; cannot identify the current step, cycle gap or scheduled wait | Append a small activity event at cycle/step transitions and before the interval wait |
| Service activity | Treats an unexpired reservation as active work; falls back to completed history for idle | Evaluate current phase, process identity and deadlines; retain unknown when evidence is unavailable |
| Sync-lock snapshot | Owner already contains PID and process-start time, but public projection discards it | Read-only strict owner inspection while projecting the same snapshot; expose only an additive safe owner-state enum |
| Worker restart | Cycle numbers restart and old events survive | Bind activity to a worker instance, process-start evidence and database; compare the observed process identity |
| Database-only sync report and check | `running` rows and locks were treated as current work | Return unknown activity with explicit database-only evidence; legacy `health: syncing` is unverified without a phase |
| Terminal/JSON | Existing activity status has `syncing`, `idle`, `unknown` | Preserve this compatibility field; add exact `state` (`syncing`, `waiting`, `stopped`, `unknown`) and optional phase/cycle/update evidence |

## Evidence and transitions

The worker emits `lark_im_worker_activity` alongside existing history events. Each event contains a format version, random per-process instance ID, PID, OS process-start timestamp, hashed database identity (canonical path, device, inode and birth time; never mtime), cycle number, an allowlisted phase/step, `updated_at`, and `valid_until`. No message text, scope ID, username, command line, credential or private path is included. Each genuine phase update reads the current database file identity; a missing, inaccessible or non-file database has no usable identity and remains unknown. This lets initialization acquire its identity on a later real transition. Symlink aliases normalize to the same file; replacing the database at the same path changes the binding. Status reads file identity before and after its database/log/process observations; any change or unavailable identity invalidates current Activity for that sample. The process-start timestamp must be observed successfully; PID existence alone is insufficient. Start-time matching is at the OS reporting resolution, which is explicitly separate from PID equality.

The worker reports cycle entry and the short gap before/between steps, then the step immediately before its existing synchronous subprocess call. A step remains current only until its configured hard subprocess timeout plus a small scheduling allowance. The gap has a short fixed deadline. After a cycle completes, the worker reports the scheduled interval wait with its next-run deadline. Normal exit emits `stopped`; a crash cannot write that event. There is no fabricated heartbeat while JavaScript is blocked in a subprocess: the phase timestamp and finite operation deadline state exactly what was observed. A process that remains alive after its phase deadline yields unknown.

Status reads the latest activity evidence from the bounded current log and validates its shape, time interval, database identity, instance, process-start identity and process liveness. A running launchd worker must match the evidence PID. A phase written inside the OS start-time one-second bucket remains unknown, because a same-second PID reuse cannot be excluded. A malformed or incomplete log line invalidates phase evidence instead of falling back to an older fresh phase. Process collection starts with at most 32 activity PIDs. Ancestor discovery shares that same total 32-PID budget and follows at most three PPID edges. At most two additional directed OS reads discover the intermediate nodes, then one read rechecks every node of expanded paths, including both endpoints. Each command retains its two-second timeout and output bound; at most four process queries are made. Omitted nodes and exhausted budgets remain unknown. Clock regressions, malformed/future timestamps, expired phases, unavailable process inspection and contradictory identity all yield unknown. Log rotation can make phase evidence unavailable; old successful cycles never substitute for it. Process inspection is bounded and does not print command lines or mutate/recover locks.

The log reader, latest-instance selector and event evaluator share one required-field schema. A JSON object with the activity type but missing version, role, instance, parent, process, database, phase, cycle/step or time fields is damaged evidence, even when it parses successfully; it cannot become a separate anonymous instance that leaves an older phase usable. Explicit `null` remains valid for unavailable process/database identity and for absent parent/cycle/step values. Such an identity cannot prove activity, but initialization can replace it with a later complete observation. Worker roles accept cycle, step, between-steps, waiting and stopped phases; sync-command roles accept sync and stopped. Schema validation handles field types and finite intervals; the evaluator separately handles observation time, expiry and OS identity.

Independent foreground sync commands append their own start, actual scope-transition and stop events to the same private JSONL log without altering command JSON stdout. A standalone command has only a five-second **observation freshness** window, not a fabricated hard operation timeout. Long synchronous operations therefore become unknown until the next genuine transition; continuous foreground SYNCING is not promised. Worker children carry the parent instance and log directory through the subprocess environment. A direct child must match that worker PPID; a guarded child must have a verified chain `sync → anchor → guardian → worker`. The instance declaration alone cannot authenticate either relation. Missing/conflicting parent identity cannot turn a worker child into an independent foreground override. Parent classification keeps process identity separate from liveness. Two valid process-start observations establish the same or a different instance; a missing start on either side is unknown. An OS state of paused, uninspectable, absent or dead does not itself establish a different identity. If a live child's observed PPID still names such a parent, the observations may be non-atomic: they cannot establish an independent invocation. Explicit `parent_instance` evidence always keeps the command classified as a child.

For an inferred historical parent role, the identity matrix is:

| Observed parent liveness | Same valid start | Missing start evidence | Clearly different valid starts |
| --- | --- | --- | --- |
| Alive | Retain possible worker association | Retain possible association | Exclude that old instance |
| Unknown, including OS paused state | Retain possible worker association | Retain possible association | Exclude that old instance |
| Dead or absent while child still names its PPID | Retain association; observations conflict | Retain possible association | Exclude that old instance |

Excluding an old identity does not prove that a phase is active; a positive phase still separately requires a live process, the same start identity and freshness. It also cannot erase an explicit parent-instance declaration. Unknown evidence is never treated as confirmed absence.

After bounded OS sampling reveals child ancestor PIDs, status takes the latest legal worker identity **per instance** from the already-read bounded log and retains only identities for those ancestors. Terminal phases and phases bound to another database still supply this limited parent-role evidence; they cannot prove activity on the current database. Multiple instances sharing one PID form a finite set of starts, including explicit unknown values. Any same or unknown candidate preserves the possible association; only when every candidate is clearly different may historical association be excluded. A later observation replaces older evidence within its own instance only. This retained log metadata does not consume the active-instance budget. Only ancestors needed for the bounded process paths are queried; unrelated historical worker PIDs are never scanned. A parent omitted from those samples remains unknown. The worker's actual hard subprocess timeout bounds its step phase; lease renewal never extends a phase.

Guarded ownership and independent activity have separate evidence requirements. Every expanded path must contain live nodes with known, ordered process starts; the final observation must preserve each node’s PID, PPID and start from its first observation. All start-time buckets must have ended before the **initial** OS query begins, so a PID reused during discovery cannot match merely because both starts fall within one reporting second. Missing or exited intermediates, changed identities or edges, cycles, paths over three edges, denied inspection and budget exhaustion never authenticate a chain. Two agreeing OS observations remain observations, not an atomic process snapshot. Deadlines are evaluated again after collection.

The child’s initial phase can be written in its first start-time bucket. That record may supply a parent-instance declaration once its recorded process start matches the later verified ancestry; it does **not** prove current activity. Only the separately validated worker phase does so, with its original start-bucket and freshness checks. Consequently a long step can become verifiably worker-owned on a later status call without a new child heartbeat. Sampling during any chain member’s first bucket remains unknown.

An absent parent-instance declaration cannot make a guarded child independent. A foreground candidate needs a complete, verified path to PID 1 with no unrefuted worker ancestor, plus its own valid phase and start-bucket evidence. If the path cannot reach that boundary within the bound, status reports unknown rather than guessing independence; deeply nested foreground shells may therefore remain unverified. A clearly reused historical worker PID only removes that old role: the current ancestor still must be live, have a known start and fit the verified path before foreground activity is established.

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

`check --wait` accepts completion only from the currently verified worker instance and database file identity. Step and cycle records carry additive `version: 1`, `instance_id` and `database_key` fields; each step also carries its zero-based `step_index`. The instance must match a current phase whose PID and process start have been verified. A shared cycle number, nearby timestamps or adjacent log lines cannot establish ownership. Multiple unresolved current instances for the service PID prevent binding, including instances associated with another database. This service check uses the latest phase for each instance of that PID from the same bounded log and the same OS observation; it does not change the database-scoped activity classifier. Verified old processes and stopped instances do not block a unique current instance.

Service-instance selection separates disproving an old process identity from proving current work. For a structurally valid event, two clearly different valid process-start timestamps exclude that old instance before inspecting its database identity or phase. This also applies to a legal `database_key: null` event emitted before its database existed. A missing database identity cannot undo an independently established PID reuse. The precedence is:

| Event shape | Event and observed process starts | Database identity | Service-instance selection |
| --- | --- | --- | --- |
| Damaged | Any, including apparently different | Any | Retain uncertainty; damaged fields cannot prove an old instance |
| Valid | Both valid and clearly different | Target, other, or unavailable | Exclude the refuted old instance |
| Valid | Same or either unavailable | Unavailable | Retain an unresolved possible instance |
| Valid | Same or either unavailable | Another database | Apply existing phase rules without discarding the instance merely for its database; current or unresolved instances prevent a unique target match |
| Valid | Same | Target | Still require a live, current phase and a complete bound cycle |

Excluding a refuted instance never establishes a successful cycle by itself. The surviving target still needs every existing database, process, phase and completion check. This precedence is confined to service-instance selection; global Activity classification and its conservative damaged-evidence handling remain unchanged.

A successful completion requires the six ordinary steps, with the optional retention step last, each exactly once and in order. Every step must have literal boolean `ok: true`, exit code zero, no partial result, and valid ordered times; the matching cycle must also have literal `ok: true`, the exact step count and no failed steps. Foreign database or instance events cannot fill missing steps, replace a failed target cycle or alter its unfinished state. Legacy records without these bindings remain readable history and cannot satisfy a wait. If the database is missing at cycle start or its file identity changes during that cycle, completion remains unverified until a later complete, consistently bound cycle.

Waiting and runtime statistics use one strict parser for step and completion times. It accepts real calendar timestamps with an explicit timezone, including valid offset equivalents, and rejects nonexistent dates, missing timezones and numeric coercions. A damaged completion or step timestamp cannot satisfy `check --wait`, even when JavaScript could normalize it into an otherwise plausible instant. This shared parsing rule leaves their different completion and duration requirements intact; it introduces no log format or producer change.

The public `status` Activity object includes finite `source`, `evidence`, `phase` and `reason` fields in both default and detailed JSON. A verified worker has source `worker` and evidence `verified_worker_phase`; a verified independent invocation has source `foreground` and evidence `recent_foreground_phase`. Waiting retains the worker source. Confirmed stopped activity uses source `none`; unknown activity keeps source and phase `unknown` with evidence `unavailable`.

Reasons identify unavailable sync status, changed database identity, incomplete phase evidence, worker/child conflicts, unverified parents, unavailable current phases or owner observations, and unavailable service state. The text view uses a fixed short explanation for each reason. Unknown categories use `activity_evidence_unavailable`. Neither projection nor text interprets the internal `detail` string or exposes process IDs, instances, database fingerprints, owner identities, paths or raw errors. These explanations do not strengthen the existing activity decision rules.

The shared sync report used by `status --detail` and `check` has a coherent database snapshot but does not collect worker phases. Its additive `current_activity` therefore explicitly says `state: unknown`, `evidence: database_only`, and distinguishes `unverified_sync_history` from `phase_not_collected`. A running row or lock makes its health unknown rather than syncing. `check` preserves that uncertainty, returns `ok: false` for this unknown state and never calls a legacy database-only `health: syncing` current work. Local readiness without outstanding running history remains a data-health result, not an activity claim.

Service status has additional bounded phase and OS observations and can consequently establish syncing/waiting where database-only diagnostics cannot. It re-evaluates the existing historical health function without treating running counts as current work. A verified phase can explain database-only unknown history, but failed-only history, initial or unsuccessful scopes, incomplete detail debt and source-coverage limitations remain independent health problems. All three entry points share the rule that reservations and historical running rows never prove current activity.

## Testable invariants and synthetic matrix

State-matrix clocks, identities, database names, events and locks are invented. The process-topology regression creates its own direct and guarded children, inspects only their OS-assigned PIDs, starts and PPIDs, and reads its own synthetic JSONL. Injected observation times test both sides of the start bucket without relying on runner launch speed. Tests never read operational logs, processes or databases.

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
| Worker waiting with a live child phase or missing child-parent binding, including a guardian chain, and no verified independent work | Unknown, never promote the child to independent foreground |
| Direct child or stable three-edge guardian chain with matching worker instance | Worker phase proves activity; the child declaration alone never does |
| Changed start/PPID, missing intermediate, cycle, overlong chain or exhausted process budget | Unknown; every expanded path is rechecked at both endpoints and all intermediates |
| Child phase emitted during its first second, unchanged at later status | Unknown while a chain node remains in its first bucket; later verified ownership can support the current worker phase without a new child heartbeat |
| Verified independent foreground plus fresh/expired orphan or current worker contradiction | Syncing from the independent phase; unrelated states remain unexplained |
| Historical worker PID reused as an independent command’s parent | Every relevant old identity must be clearly different; current worker PPID or explicit parent binding still prevents child promotion |
| Parent paused, uninspected or dead while child still reports its PPID | Same or unknown identity retains association; even a refuted old identity cannot establish a live complete foreground path |
| Terminal or other-database parent phase omitted from active candidates | Minimal matching-PPID identity evidence survives as a classification constraint, without claiming active work |
| Multiple worker instances sharing a PID | Any unrefuted same/unknown identity retains association; append order only replaces evidence within one instance |
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
| Legacy running row with no lease; expired reservation; live/dead owner | The sync report and check remain unverified; check does not pass; service requires independent phase evidence |
| Public JSON compatibility | Existing fields keep meanings; optional new state/evidence contains no identifiers or paths |

Run focused worker, activity, service and terminal tests, then the repository build, typecheck, syntax, full suite and generated-file consistency checks. This local candidate changes no production process, log, database or service configuration. Optional phase writes never interrupt business synchronization. A failed append cannot reliably retract an earlier observation through that same failed log channel; its existing finite validity window remains the upper bound, so the display is an observation rather than an atomic process trace. A later authorized restart is required before an existing worker can emit the new phase events; legacy logs remain readable but cannot prove a current phase.
