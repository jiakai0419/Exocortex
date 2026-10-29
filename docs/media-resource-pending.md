# Explicit resource continuation

An exact `maintenance enrich --target resources --apply` invocation can finish
its download while the closing account check or commit lease is blocked by sync.
Discarding verified bytes forces another download into the same short idle
window. The limited continuation below preserves those bytes without publishing
them.

Only bytes that completed the existing response, private-file and image
validators under a verified starting account are eligible. Retention is
restricted to local `sync_busy`, `cli_budget`, `self_budget` or `time_budget`
stops. A remote denial, transport failure, account conflict, changed source or
failed file safety check does not create continuation evidence. Unsupported
formats never create it.

Pending bytes live under `<resource-store>/pending-v1/`, a namespace that the
ordinary available-resource reader never opens. There are exactly 20 possible
private slot directories, each with at most one 16 MiB payload and a manifest. A
private, nonblocking flock serializes only synchronous slot writes, cleanup and
reuse. It uses its own file in this namespace, never the API lease, and the OS
releases it on process death. Exclusive slot creation bounds admission;
immutable generation and inode receipts prevent stale cleanup from deleting a
reused slot. Each pending file uses exclusive create, write and fsync under that
local mutation lock; the manifest is written last. Unlike available-resource
publication, pending writes do not use a hardlink/unlink step that could leave
two links after a crash. A partial slot cannot become pending or available
evidence. Pending expiry is one hour from initial retention and is never
extended by retry/read. The creation time and current read observation are
retained. Both expiry and backward wall-clock movement are checked again before
publication and retention, so crossing the TTL during an account check cannot
publish or re-age the old downloaded bytes. An explicit apply may reclaim
expired valid slots or expired unfinished slots; reads and previews never
reclaim, write or issue requests. Unknown/unsafe files are not followed or
accepted. Capacity and invalid evidence fail closed locally. Cleanup captures
the directory and complete known file set before evaluating expiry and checks
those exact identities again before each unlink. Incomplete first-claim writes
may contain only claim.json and age by filesystem timestamps; an invalid claim
alongside a payload or manifest is not a valid crash phase and remains fail-
closed. Once a valid claim exists, partial payload or manifest writes can expire
normally. Unknown filenames, symlinks, external hardlinks and file safety
failures are never reclaimed automatically. The ordinary available-store
publication crash behavior is unchanged: invalid objects fail closed, without
implicit repair.

The manifest has a separate schema, original normalized database/source/account/
message/version/key binding, a digest of the exact source fields (including row
ID), content hash, MIME, original opening and closing observation times, and
fixed creation/expiry times. A missing original closing observation is recorded
as null and is quarantined. A later self profile is not that missing original
observation. Reuse requires an exact match and freshly validates private
ownership/mode/link count, stable file identity, hash, length, format and the
current database identity. Conflicting duplicate evidence is rejected; bytes and
expiry are never silently replaced.

Only evidence with its original successful closing observation may be reused by
a later explicit invocation for the same selected record. Quarantined bytes are
never reused: the normal fresh download path is still required and successful
publication removes the exact old quarantine. If that new actual fetch has its
own successful closing observation but commit is busy again, it may replace the
old quarantine using its exact receipt and a new generation. This is a new
download operation with new timestamps, never a refreshed old continuation. No
claim of atomic token binding is made; this retains the existing before/after
account-observation contract. An operation with reusable pending bytes still
performs both normal starting and closing account checks. Only after the
unchanged source fence and ordinary shared commit lease pass may it publish the
available manifest. No available manifest is published early or revoked later.
Messages never treats pending as ready or exposes its local file path.
Successfully consumed evidence may be removed using its exact receipt; failed
cleanup cannot undo a correctly admitted available resource and is reported
locally.

The public maintenance result keeps `publication_not_attempted` for an
uncommitted resource and indicates whether pending bytes were retained or
reused. This sidecar namespace does not itself schedule work, retry, add
permission or expand budgets. The separate [known-resource queue](resource-work.md)
may invoke the same producer, retaining every original-closing requirement.
Source changes do not borrow old bytes. A missing/expired
pending entry may follow the normal exact download path in a fresh explicit
operation; invalid evidence must not silently fall back to another download.

Verification covers separate CLI processes: closing-check busy requires a new
fetch, while commit busy with original closing=true resumes without a second
resource request. Pending-only messages remain incomplete. An extra pending
namespace does not change an already-available resource or neighboring messages.
Also cover all source/account/DB/version/key fences, expiry, capacity races,
replacing files, unsafe permissions/links, unsupported content, remote denial
and untouched neighboring message/source bytes. Tests use only newly authored
image bytes and fictional accounts/messages.
