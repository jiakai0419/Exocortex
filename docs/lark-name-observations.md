# Sender name observations

A stored nonempty name is an adopted display value, not proof that it still
matches the current client display. Numeric-looking nicknames remain valid.
Names are rejected only for empty values, explicit identity echoes, or conflicting
identity/name evidence. Application results pass this check before positive
caching and before deciding whether an exact chat-bot fallback is needed.

`sender_name`, `sender_name_source`, `sender_name_confidence`, and the optional
`sender_name_observed_at` describe the adopted value. The time is the original
lookup observation, not message creation, synchronization, cache reuse, or
migration time. Older records and direct source names without a separate lookup
time keep that time unknown. Local-history reuse may carry its original evidence
time; it does not create a new observation.

`sender_name_verification` is one bounded latest lookup result, independent of the
adopted value. It contains `status` (`resolved`, `conflict`, `failed`, or
`unresolved`), source, observation/attempt time, whether it came from cache, and,
when available, the resolved name and an account hash. A failure time is not a
successful verification time. A cached result carries the original observation
time and `cached: true`. Absence means no recorded verification, not success.

Normal existing synchronization lookups may update this slot while retaining an
older adopted name on failure or conflict. They may adopt a new authoritative
name at the same message version without changing raw message data, its hash, or
source version. Latest-result inheritance requires the same actor, namespace,
chat, account marker and adopted value/source; it does not follow a changed identity. This is diagnostic
metadata, so a new lookup result can update a row even when its adopted name is
unchanged.

The existing positive cache remains resolver-local, at most 1000 entries, with a
five-minute TTL. Latest route results and each people-context observation map are
also capped at 1000 entries. They do not become an unbounded profile history.

## Explicit verification boundary

`createLarkImAdapter(...).verifySenderName(message, adoptedName, selfProfile,
options)` is a read-only internal adapter operation for one explicitly identified
sender. The caller supplies the same admitted request-session runner and current
account profile used for its other lookups; supplying a profile alone does not
establish database authorization. It does not write a record or scan a database.

The result reports `same`, `changed`, `conflict`, `failed`, or `unresolved`, retains
the adopted name separately, and includes the lookup observation. A returned
candidate is evidence for that exact source identity, not a claim about the
client's current visual state. Missing or conflicting native identity makes no
request. The operation bypasses positive name caches and has a 15-second total
deadline, no retries, and at most one contact request plus two member pages, or
one application request plus one bot-list request. Unique unbound bot inference
cannot resolve an explicit verification.

This adds no CLI, scheduled name refresh, global people table, or network activity
to `messages`. Existing names-only repair still selects unknown names and does
not silently become a refresh of all known names. Successful unreviewed maintenance lookups
record their own observation time; a name recovered only from stored message
data clears unrelated old timing instead of inventing a fresh API observation.
An unresolved names-only target still makes no proposal or metadata write. Callers must retain their
existing account, request lease, scope and total API-budget checks.

Reviewed names preview/apply is deliberately narrower: its complete canonical
proposal remains hash-bound. It omits new volatile lookup timestamps and removes
timing or verification metadata belonging to a replaced name. The resulting
reviewed name has unknown observation time; a fresh apply still refetches and
checks the entire approved proposal. This does not relax proposal matching or
extend approval expiry. Explicit read-only verification can provide a current
report separately without changing the review protocol.
