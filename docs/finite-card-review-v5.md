# Finite static card review schema v5

The finite card renderer can produce complete version-4 panels, forms and
Markdown structures. The previous review constructor generated their exact
display, but its validator accepted only renderer version 3. This rejected the
constructor's own proposal before publication. The new review schema addresses
that compatibility mismatch without changing an approval's authority.

Only a newly generated replay review whose before or after display contains a
version-4 card uses `exocortex_private_maintenance_review/v5`. Other new reviews
keep their existing schema. A v5 review must contain at least one version-4
card. Its card entries retain exactly `text`, `status`, `reason`, `version` and
`omitted_actions`; only complete (`rendered`, null reason) versions 3 and 4 are
accepted. Unknown versions, partial cards, extra fields and media capabilities
are rejected. The pure review renderer has no verified resource context, so
image-bearing cards remain ineligible rather than treating a reference as an
available file.

V5 inherits v4 observation proofs, scope/text policies, exact targets, account
and source binding, opaque raw/body digests, proposal reconstruction, snapshot
checks, CAS, TTL, byte limits and API/time budgets. Those checks are not relaxed.
Its disclosure accurately states that source-declared static control values
and options may be shown, placeholders are hints, callback payloads and URL
credentials are omitted, and action definitions do not prove execution or
business approval.

Existing v1-v4 approvals retain their exact schema, disclosure and comparison
rules. They do not accept renderer version 4 and are never automatically
upgraded. Applying a v5 approval reconstructs and compares that same v5 proposal;
changing schema, display, callback payload, source, target, account or expiry
does not authorize a different write. Ordinary history, which does not use a
review artifact, keeps its existing transaction and admission path.

Validation uses independently invented SQLite records and mocked API boundaries
for genuine dry-run/apply round trips and negative controls. No production
request, permission change or production write is part of this change.
