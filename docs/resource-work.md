# Known image resource work

`maintenance resources --db <explicit database> --max-cli-attempts 3
--max-self-attempts 2 --max-seconds 30 --format json` performs at most one exact
known-image acquisition unit. This is a writing maintenance command: it updates
its own queue metadata and may publish a private resource sidecar. It never
rewrites message/source/name fields, enlarges permissions, or runs discovery API
requests. `--resource-dir` selects the same store used by `messages`. The
existing explicit `maintenance enrich --target resources` route remains
available for exact selected records and local preview.

The runtime exports `resourceWorkAvailable(db,deps)` and
`executeResourceWork(options,deps)` from `src/maintenance/resource-work.mjs`.
Availability is a cheap bounded read-only hint; it grants no lock or authority
and may be true when only local scanning is due. It does not initialize or
migrate the database. The command requires migration 019 already installed.

## Discovery and durable selection

Migration 019 defines `lark_im_resource_work` and `lark_im_resource_scan`.
Each scan inspects the newest 20 known source records and 20 records from an
ascending, fixed historical ID horizon. There is no direction, received-time
or current-name mask. The historical cursor advances across all inspected
records, including text, invalid evidence and oversized records. New arrivals
cannot extend that sweep's fixed horizon. Existing queued work may run between
scans; a new source head or a 60-second local scan deadline permits another
scan. Discovery is not proof of coverage of unseen upstream messages.

Record source fields have a combined 128 KiB automatic-work limit, measured in
SQL before returning raw/canonical/body bytes. The actual source-row query
rechecks that limit in the same read, so growth between the ID page and source
read cannot bypass it. At most 40 records enter that bounded projection; the
command also rejects an injected/read projection above 8 MiB. Larger records
are left for explicit diagnosis/manual work, without blocking the page cursor
or making a completeness claim.

`resourceWorkIdentity` reuses `projectionAccount`, `renderMediaProjection`,
`makeMediaResourceBinding`, and `makeMediaPendingSourceFence`. Work is enrolled
only under matching local database account admission. The stable work key
hashes source, account, external message ID, resource type/key and user
authority. It excludes canonical names, source version and chat routing: those
changes do not grant a new permission for the same resource endpoint. Full
source/version/hash/chat/database binding and exact original row fields remain
separate publication and claim/result fences.

At most two newest eligible selections precede an oldest eligible selection.
That streak is durable. Failed attempts and new arrivals do not reset old
enqueue age. This is a queue opportunity rule, not a source-to-ready time bound;
the worker separately controls service among resource/history/sample lanes.

Every enrollment, claim and result transaction takes the existing normal probe
API lease first, then checks `captureLarkWriteAdmission.assertCurrent` and its
SQL admission fence. It never bypasses sync intent or cooldown policy. A claim
uses source and task generation CAS, a random token and the existing process
owner identity. Result writes require that exact token/generation and original
source. A queued image that has become text, lost its account evidence or
otherwise no longer matches is marked `source_changed` only while both task CAS
and the exact observed current source still hold. A source row outside the
bounded payload set requires the corresponding absence/size predicate under
the same transaction. A restored eligible source can be enrolled normally even
when its fence equals the original task fence. Same-binding restoration preserves
attempt/failure/deferral counts and cannot revive an exhausted attempt budget.
It cannot remain an endlessly
selected head or be permanently hidden by an earlier changed-source observation.
Source changes after acquisition also cannot receive a successful stale queue
result. The `processed`, `available` and `blocked` task counters are published
only after that task's guarded result transaction commits. A producer sidecar
may already exist if the later queue CAS fails; failure does not delete it or
claim a successful queue result.

## One existing producer and unchanged total budget

The wrapper calls the existing `enrichResources` once with one exact ID. There
is no duplicate downloader, image validator, pending reader or publication path.
Both current self observations, ordinary request gaps, shared cooldowns,
source fences and publication admission remain in that producer.

The grant accepts 3–12 CLI attempts, exactly 2 self attempts, and 1–30 seconds.
The normal worker reserves one 3-CLI/2-self unit within its existing shared
allowance. Local preparation consumes the command's monotonic deadline; the
producer receives only remaining whole remote seconds. Before both claim and
producer entry, fewer than three remaining remote seconds means `time_budget`
with no API request. A three-second input grant can therefore be insufficient
after nonzero preparation; the worker's admission threshold should leave room
for preparation and its existing child-cleanup allowance. No extra allowance
is created. The enclosing worker guardian remains responsible for the entire
child, including local publication/decode and cleanup; the producer's remote
deadline alone is not a whole-command bound.

The safe `known_record_resources/v1` result has finite `outcome`,
`processed/available/deferred/blocked` counters and `request_budget`. The budget
reports the original granted maxima, actual CLI/self counts, total observed
monotonic command elapsed time and a finite stop reason. Internally reduced
producer seconds are validated before reporting the original outer grant.
Known local-only outcomes provide an explicit zero-call receipt. A malformed or
unavailable producer receipt has `complete:false` and unknown counts, so the
worker must not refund it. No IDs, account keys, paths, raw errors or payloads
enter this result or its worker projection.

## Denial, deferral and recovery

Permanent resource denial requires the exact failed download's validated
transport execution receipt, a supported numeric remote code, and a successful
closing self observation matching the original opening and queue account. That
closing observation uses the unused third CLI / second self reservation in
the same session. There is no retry of the denied download and no new session.
Opening/closing profile failures, plain local `permission denied` text,
changed identity, missing receipts and closing admission/budget failure cannot
become a confirmed resource denial. Confirmed denial remains isolated across
canonical name updates, source-version changes and chat-routing corrections of
the same endpoint; there is no implicit retry merely because time expires.

Other completed transient failures defer with bounded backoff and exhaust
after three such failures. A unit may claim at most eight times for the same
binding; unrelated traffic/name changes do not reset this counter. A changed
real source binding may start new non-denial work. Invalid local resource
evidence remains blocked rather than being overwritten automatically.

Once the request session latches busy, cooldown or budget stop, the wrapper
does not take a later lease to bypass that stop and commit a result. The durable
claim remains until its **120-second** expiry and the original process owner
is positively dead. Expiry alone, an alive owner or unknown liveness never
permits recovery. At most two expired claims are examined per invocation.
Migration 019's durable `recovery_after_work_key` cursor traverses expired claims
in work-key order with one bounded wrap. Even an alive or unknown owner advances
that cursor under account admission and scan-generation CAS, without renewing
or changing its claim. It therefore cannot indefinitely hide later dead owners.
A recovery update also requires the observed task generation, token, owner and
expiry to remain unchanged. Recovery preserves attempt count and terminates the
eighth interrupted unit. Cursor advancement and any recoveries commit together;
a stopped command cannot advance the cursor outside the normal lease.
This interrupted-job recovery delay is explicitly not a seconds-level ready
guarantee. Normal successful, blocked and unstopped transient results finish
their claim immediately under the ordinary result lease.

Already available evidence costs zero requests. Valid originally closed
pending evidence uses both current self checks but no second download.
Quarantine without the original closing observation cannot safely satisfy that
guarantee: it must follow the existing fresh-acquisition contract. Tests keep
these cases separate; no pending bytes are promoted by a later self check.

A terminal available task is not automatically reopened if someone later
deletes or damages its cache while the source binding is unchanged. This is an
explicit recovery limit. Use the existing exact manual preview/diagnosis and,
when evidence is genuinely missing and normal validation permits it, explicit
resource apply. Invalid existing evidence still fails closed; no unsafe cache
repair, permission change or automatic re-download is introduced here.

Synthetic tests cover real queue SQL and the existing producer/transport,
remote denial versus local text and account drift, source/claim/result changes,
large pages, obsolete queue heads, continuous arrivals, zero-cost available,
closed pending and quarantine restart, owner liveness, eight interrupted claims,
unknown receipts, monotonic rollback and insufficient preparation budget.
Fixtures contain newly authored messages/accounts/PNG bytes only. Real worker
CLI/guardian/flock integration is a separate acceptance layer.
