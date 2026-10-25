# Lark names: reading and bounded recovery

This contract describes the candidate implementation and synthetic acceptance.
It does not claim production deployment or access to names withheld by upstream
permissions. All committed test data is authored from scratch.

## Names and identities

`first_seen_scope_id` records ingestion provenance. A sent-first message can
belong to a chat whose exact `lark.im` chat scope already has a title. `messages`
reads only its selected page's exact scope IDs and account/chat name evidence;
it performs no network request, migration or write. It retains the existing
JSON structure, text layout, sorting, filters, body and message timestamps.

An ordinary scope name fills an unknown title. It does not replace an adopted
canonical title. Borrowed raw/native/scope values require consistent message,
source and chat identities, unambiguous JSON and compatible chat modes. An
invalid newly consulted source must not erase an already adopted canonical
title. A valid explicit clear blocks fallback. Null, missing, blank or failed
lookups are unknown, not clears. A nonempty numeric-looking **string** is a
valid name; a JSON number is not a name.

Sparse discovery omits unknown titles from merge patches, preserving existing
known titles. Explicit scope enrichment locates records by source/container,
including sent-first messages, rather than requiring first-seen membership.

Independent official current titles are bound to source, account and exact chat.
Only `im.chats.get` success with a group/topic mode and valid name produces an
observation. Its own observation time is used; discovery activity and scope
update times are not title clocks. This current observation may replace an old
display title. Empty responses and failures preserve the previous observation.
Explicit clears and account, identity or type conflicts cannot be bypassed.

The chat work applies only an account marker to bounded exact message rows.
The title observation remains separate from historical canonical titles and
message content. The marker follows the same container through ingestion only
when existing and incoming account declarations agree. Incoming raw data cannot
establish a marker. A legacy single sent actor does not establish ownership of
all received history; current exact API work supplies the independent evidence.

Marker inheritance preserves unrelated canonical JSON text, including unknown
numeric tokens and whitespace. Absent and already matching markers are no-ops;
adding an inherited marker appends only that root member. The rare path that
must remove or replace a conflicting/invalid incoming marker accepts at most
8 KiB of UTF-8 JSON and scans at most 8,192 bytes. It splices only the owned
member rather than reserializing the object. Larger edits fail before any
record mutation, leaving the original row for a later supported repair; they
do not fall back to a lossy JSON rewrite. Duplicate incoming root markers,
including Unicode-escaped equivalent keys, likewise fail closed. This small
edit limit does not restrict absent/matching-marker or append-only fast paths.

Sender work fills unknown names using exact typed identity. Contact/member
evidence applies to open IDs; application API and a bot response explicitly
carrying the matching app ID apply to app IDs. A sole bot in a chat is not proof
of an app's identity; ordinary ingestion, explicit maintenance and background
work share that rule. Historical `chat_bot_unique` displays remain visible while
being reverified, but are not exact evidence or donors for other messages. They
are enrolled as persistent verification debt even when nonempty. Only fresh
exact evidence replaces them; failure preserves the display and leaves a retry.
Historical rows without a verifiable typed actor namespace cannot enter this
automatic identity repair; an app-looking ID prefix is not sufficient proof.
Existing names, local display mappings, system messages,
explicit clears and conflicting accounts are not degraded by retries.

Chat partners retain explicit open/user/union namespaces through normalization,
name inheritance and maintenance. User/union values are not sent to open-ID
contact lookup. Same bytes in different namespaces do not identify the same
person. The official p2p relationship evidence contract remains open-ID-only;
legacy display compatibility does not manufacture a relationship or bulk-rewrite
historical malformed partner projections.

## Persistent work and resource limits

Migration 015 adds `lark_im_name_tasks`, an account scan cursor and indexed record
access paths. Tasks are distinct sender/chat validators, not arbitrary jobs.
The existing recipient state and relationship validator remain unchanged.

After a successful sync command, including a successful empty cycle, one
optional tail can run under the existing sync API lease. The public sync summary
and worker/status vocabulary remain unchanged. Because a worker cycle contains
several commands, an account-wide persisted CAS gate admits at most one name
opportunity per 60 seconds. This is a time-based bound, not a claim that a long
worker cycle can run only one opportunity.

Each admitted opportunity shares **four request attempts and a ten-second request/query budget** across
sender, chat and recipient work. The persisted role rotates across processes.
Recipient work receives only the remaining budget. For sender/chat results, the
command's existing admitted self observation precedes lookup and a fresh matching
profile is required afterward; that last profile consumes the same request
budget. Requests disable retries and use the shared lease/cooldown.
Existing admission checks and short SQLite commit/lock cleanup retain their own
bounded storage operations; ten seconds is not a hard process-wall-clock limit.

Candidate scans use 40 newest and 40 historical rows, a fixed historical horizon,
indexed IDs and bounded payload materialization. Due work is selected separately
per role so a large sender queue cannot hide chat tasks. Scan, task claim and
result transactions are short; requests run outside transactions. Each result
checks account admission, exact predecessor rows, scope constraints, claim token,
generation, previous evidence and projection cursor. Any record CAS conflict
rolls back the result transaction, leaving a retryable claim. Claims expire after
five minutes. Failures back off to at most 24 hours rather than becoming permanent
negative caches.

Each sender/chat task has a separate fixed projection horizon and a durable
capacity-debt flag. Evidence expiry, successful refresh and capacity retries do
not rewind an unfinished projection cursor. New arrivals extend the next round,
not the active horizon. Oversized rows are recorded as debt while later normal
rows continue; only a completed round restarts at the beginning to revisit them.
Batch exhaustion advances only through the inspected prefix. Payload capacity is
checked again at materialization; a row that grew concurrently becomes retryable
debt without permitting an oversized read. Progress and debt commit atomically
with evidence and the exact record updates.

The task's saved exact record is the first witness candidate. If it has changed
or vanished, an independent bounded historical cursor searches a fixed horizon
across opportunities. Newer oversized or invalid records cannot permanently
hide an older valid witness. An exhausted witness page remains retryable and
does not imply that the identity itself is invalid. Witness progress uses the
same task-generation and account fences as projection progress.

Sender work deduplicates typed actor/chat targets and updates at most 20 records
and 2 MiB of payload per application page. Member lookup retains its page token
across processes, advances at most two member pages per opportunity and periodically
rechecks contact lookup after five minutes. A walk is bounded to 256 pages and
24 hours, then remains retryable. Response item limits are independent of the
requested page size. Exact positive sender evidence expires after 24 hours;
finished application horizons can be revisited for earlier conflicts.

Chat work likewise applies at most 20 records/2 MiB, retains progress, and refreshes
successful official titles at a finite 24-hour interval. New messages can use
the existing observation without a new title request per message. Neither role
creates/enables a received collection scope. Disabled, sent-only and scope-less
chats therefore remain eligible under the same source/account admission.

Capacity limits, missing verified account evidence, permission failures and
unresolvable typed identities remain explicit internal debt. They do not imply
that upstream has no name, that content coverage failed, or that a guessed name
is acceptable. Existing public status is not repurposed as a name-completeness
claim.

## Acceptance

`chat-title-contract.test.mjs` exercises real offline reads, strict borrowed
evidence, numeric strings, clears, existing-name preservation and rendering.
`name-sync.test.mjs` covers cadence, budget, historical progress, current titles,
disabled/scope-less chats and account/concurrent-update fences.
`sender-name-work.test.mjs` exercises persistent member paging, permission
recovery, typed evidence, bounded record application and non-name byte preservation.

`name-sync-command.integration.test.mjs` runs independent real CLI processes,
SQLite, account admission, transport and real private flock, with only the remote
executable replaced by authored responses. An old received actor first fails
name lookup; after its content window has moved away, unrelated new traffic and
empty successful cycles still recover its name. No new message from that actor
is needed. Every non-name canonical value and other record column is preserved.
The fixture also rejects a busy lease and a different account.

Typed partner and account-marker merge tests use the real ingestion store as well
as pure merge counterexamples. Full verification additionally runs the existing
recipient, maintenance, content, status, CLI and storage suites.
