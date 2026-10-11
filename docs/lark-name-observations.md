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

### Route evidence and stopping rules

An exact verification also returns `lookups`, at most two route observations in
request order (contact/member or application/exact bot). Each route retains its
own `status`, `reason`, source and observation time. A successful empty contact
response is `unresolved/empty_result`; it does not prove missing permission,
stale cache, or absence of the person. An exact member result can still be
`resolved` and produce `same` when its API name differs from a client label.
Neither result establishes which private client naming preference was used.

Reasons distinguish `exact_id_match`, `empty_result`, `target_not_returned`,
`missing_name`, `conflicting_identity`, `conflicting_names`,
`malformed_response`, `request_failed`, `budget_exhausted` (no request made), and bounded pagination stops
(`page_limit`, `missing_page_token`, `pagination_cycle`). Fresh member observations
include `pages_observed`; only unresolved targets receive a pagination stop.
Each observation is the latest evidence for that route, not a complete profile
or request log. A cache hit retains the original successful observation time.
No returned error text, raw profile or unrelated member is included.
An unmatched contact target with `has_more` is also a `page_limit` stop; the
one-request contact bound does not claim the remaining results were searched.

Explicit app actors never use the person-contact route, even when contradictory
source metadata labels an ID as `open_id`. Member IDs must match the requested
namespace; contradictory explicit `open_id` values are rejected. Bot mappings
check every explicit app-ID alias before adopting a name; duplicate entries
with missing or conflicting names cannot become success by filtering away the
contradictory entry. The legacy medium-confidence unique-bot fallback applies
only to an unbound bot, never a bot explicitly belonging to a different app;
it remains unavailable to exact verification.

Names returned by accessible APIs remain valid even when they look like a
default or numeric nickname. Source-name precedence is unchanged. Display names,
English names, aliases and client group nicknames are not interchangeable:
unsupported or absent fields cannot be synthesized, and screenshot text cannot
establish an identity mapping. A remaining client/API mismatch is a documented
source limitation until another exact identity-bound source is available.

### Available fields and remaining API limits

- [Chat member GET](https://open.feishu.cn/document/server-docs/group/chat-member/get)
  provides a typed member ID and `name`; it filters bots. It does not declare
  English names, personal aliases or group nicknames. An exact hit ends the
  lookup; more pages are not a source of alternative names for that member.
- [Contact user GET](https://open.feishu.cn/document/server-docs/contact-v3/user/get)
  distinguishes default `name`, English `en_name` and personal `nickname`.
  A personal alias is not evidence of a group nickname or a private remark.
- [Basic user batch](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/contact-v3/user/basic_batch)
  is a possible future explicit probe, not a new automatic fallback. It accepts
  at most ten IDs and requires `contact:user.basic_profile:readonly`, although
  its contract says it is not restricted by the contact data visibility range.
  Its returned `user_id` follows the requested `user_id_type`; that field name
  alone does not establish a different namespace. `i18n_name` variants do not
  establish which name the client selected. Account-specific access and results
  still require an admitted, bounded request before making any repair claim.

The installed CLI metadata describes `im.chat.members.bots` with `bot_id` and
`bot_name`. A bot's open ID is not an application's app ID. Existing support for
explicit app-ID aliases only applies when such evidence is actually returned;
the ordinary two-field bot response cannot provide an exact app mapping.
No verified route here provides another person's client group nickname or the
current user's private remark. This is a limit of the verified sources, not a
claim that no platform API could ever expose additional fields.

Reviewed names preview/apply is deliberately narrower: its complete canonical
proposal remains hash-bound. It omits new volatile lookup timestamps and removes
timing or verification metadata belonging to a replaced name. The resulting
reviewed name has unknown observation time; a fresh apply still refetches and
checks the entire approved proposal. This does not relax proposal matching or
extend approval expiry. Explicit read-only verification can provide a current
report separately without changing the review protocol.
