# Known-record history routing

History routes a stored native Lark message through the enabled discovered
received scope whose `chat_id` exactly matches the record's `container_id`.
`first_seen_scope_id` records ingestion provenance; it is not the routing key.
In particular, a message first collected by `sent_by_me` remains eligible after
its chat is discovered. Its original provenance stays unchanged when history
accepts newer evidence or a separately confirmed equal-version observation.

Selection still requires an enabled source and received scope, the configured
initial baseline, a numeric version, native source provenance, and a valid scope
identity. History retains its one-record fixed-horizon sweep, request limit and
fair scope rotation. Rows arriving after the selected horizon wait for the next
sweep. A change in an existing sweep's membership does not reset progress;
newly eligible lower IDs are visited on the next sweep.

The active received scope supplies the fetch route and account-admission fence.
The complete stored record, including first-seen provenance, remains bound by
the existing review and observation-generation guards. The commit also retains
the source configuration, enabled scope/configuration, history checkpoint,
account and database identity checks. No cursor is advanced by history. The
record writer already preserves first-seen provenance on updates; no alternate
writer or weaker CAS is needed.

Migration `011` adds `records_history_container_id` on
`records(source_id, container_id, id)`. Both the fixed-horizon maximum and the
next-record lookup explicitly use this index. The time-ordered container index
remains available for baseline eligibility and normal time-window queries.
Without the ID-ordered index, routing by container would scan and sort a chat's
history for every selected row; a full sweep could become quadratic. The
bounded-work regression measures the actual selector queries against thousands
of fully synthetic rows, including the maximum-ID query rather than only the
final one-row read. Filtering ineligible rows can still require walking those
rows; this index is not a claim of constant work for arbitrarily sparse data.

After this candidate receives deployment approval, upgrade through the existing
`node bin/exocortex.mjs maintenance init --db "$DB"` transactional initializer
as a separate coordinated deployment step before starting the new history code.
The candidate work does not execute that command on production. This index-only
schema migration changes no table columns or
stored records, observation slots, queue descriptors, or checkpoints. Existing
checkpoints continue rather than resetting a sweep. History itself stays
read-only during selection and does not migrate an older database; without the
required index it refuses the query. Index construction is a local write and
must follow the ordinary deployment coordination, never a competing live repair.

Keep the migration and index on rollback. The added index is compatible with
older SQL, but an older history selector again excludes sent-first records; that
is a known coverage regression. Index compatibility does not establish writer
compatibility with other retained observation or remote-debt state. Preserve the
current database and evidence, and follow the unified rollback contract rather
than restoring an older database or deleting debt to force acceptance.

Representation rules are unchanged: coordinated mention alias changes require
the complete typed-reference proof, calendar and unknown source fields remain
significant, and absence never proves deletion. Manual exclusions constrain a
directed repair only; this routing rule adds no permanent hold to normal sync
or history.

History still covers stored records only. A first-seen merge root with no stored
record is handled by the [pending detail confirmation contract](pending-detail-confirmation-contract.md).
Two history attempts still find no eligible target; two qualified independent
complete detail acquisitions can now resolve that separate debt. The first only
stores a candidate and retains incomplete coverage, while the second can create
the record and finish the real detail receipt atomically.
