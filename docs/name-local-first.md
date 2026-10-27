# Bounded local sender preparation

Candidate only, based on the shared message-completeness design. This change is
owned by the latency route in its isolated checkout. It does not change request
ceilings, permissions, schema, messages/status layout, or the shared completeness
decision. All fixtures are authored synthetic data.

Ordinary list preparation and detail recovery currently perform remote name
lookup before consulting authoritative stored sender names. The candidate moves
the existing history reader ahead of that optional work. It uses the existing
record normalizer and history validator, not a new identity resolver.

For at most 100 messages, a self-only preview produces exact record identities.
The existing bounded history reader checks typed identity, source/account,
authority scope, conflicts and explicit clears. Exact local hits with no pending
typed personal partner are omitted from the name resolver's input. Original raw
messages are never decorated with a borrowed `sender.name`. Missing partners
continue through the existing resolver. Local history is still `local_history`,
retaining its authority source and original observation time; it does not become
a new contact observation or fresh API result.

Every positive donor must itself carry `sender_name_account_key` equal to the
verified current source binding. A database-wide binding does not upgrade an
unmarked legacy name. The adopted name still requires exact typed actor/native
identity, the accepted official source and high confidence; the preserved
account marker is copied with the name and original authority/time. Legacy rows
without that marker remain eligible for remote resolution. This adopts the
existing account-bound projection contract, not a new evidence schema.
`source=contact` plus a nonempty name is insufficient. This reader does not
independently require the latest diagnostic to be `resolved/exact_id_match`,
because a later failed lookup must coexist with already adopted evidence. The
main route owns any stronger adopted-evidence schema and task-only read proof.

Donor admission also checks compatible chat and latest verification account
markers. A later failed lookup does not erase compatible adopted authority, and
its diagnostic is not fabricated or copied as a fresh lookup. Applicable
verification conflicts and canonical/native clear markers
remain negative evidence, even when another older row contains an accepted
name. Scoped evidence cannot poison another chat; global official evidence
retains its original scope. Both preflight and the after-lookup fallback reject
names matching any verified alias supplied for that sender in the whole batch.
This includes valid pending partner aliases already recognized by the resolver.

The lookup input is closed over typed identities another selected message or
partner will query. Those local hits remain in the resolver input to preserve its alias
union and export fresh conflicts. Without this closure, a partner lookup could
observe a contradiction for a filtered sender without returning that sender's
diagnostic. Mixed batches may therefore retain some known-sender lookups;
all-known independent batches still avoid naming calls.

Final preparation uses the original messages, normalizer, window/cursor filter,
direction classification and stable order. A matching local hit may fill only
an unknown sender projection. Fresh resolved values, explicit clears, conflicting
identity/account or a relevant fresh conflict are not overwritten. Remote
observations from another selected message must not let a local hit hide an
exact conflict for the same typed identity/authority scope. This costs one
additional bounded preflight normalization; it avoids changing raw/body/hash or
reimplementing the normal projection.

Batches above the local-preflight cap retain the existing remote-then-history
fallback. They are not partially sampled into an apparent whole-batch result.
The local query retains its own 4.5-second/1.5-second-per-query bounds and the
existing donor/actor limits. When remote work is needed, the remaining local
allowance rechecks history afterward, so a clear, conflict or account change
committed during the lookup cannot be hidden by the preflight snapshot. A spent remote deadline does not suppress that
bounded local read. Detail lookup still uses the remaining original detail/name
request deadline; no extra remote time or attempts are granted. All tasks in a
detail retry scope share one local allowance, including any after-lookup recheck.
Local snapshots
remain subject to the sync command's existing account and transaction fences.

Acceptance exercises the real sync runner and temporary SQLite: persisted local
contact/application authority with zero name calls, typed/scoped/account/clear
counterexamples, a missing partner that still needs lookup, original raw/body/
hash/source times and stable order, and detail recovery after its remote name
allowance is exhausted. This is preparation coverage, not production latency
or complete-publication evidence.

Implemented in `prepareLocalSenderNames` and the normal list/detail preparation
paths. `sync-command`, the resolver, storage and migrations are unchanged by this
subchange. The real `messages --format json` and text regression compares exact
synthetic human/application names after sync, while requiring only the message
list request and no naming request. The spent-detail-budget case also runs the
real retry/store path. The five local preparation/history/detail/namespace test
files pass 79 tests, including missing-account legacy rejection and account
marker preservation. Typecheck and targeted syntax checks also pass. Full
integration/release verification remains owned by the main
task. Existing explicit-clear regression still exercises failed optional remote
lookups and proves the clear is preserved; it is not mislabeled a local-name hit.

## Known but unproven sender repair

`senderNeedsAuthorityRepair(target, accountKey)` is a shared pure predicate for
enrollment and resolved-evidence application. Callers retain their existing
exact record/task/admission gates. A canonical nonempty sender without a native
name still needs repair unless its authority is allowed for the typed namespace,
confidence is high, and its own adopted account key matches the admitted account.
`local_history` uses its original authority source. A chat account marker alone
does not prove sender adoption. Failed latest diagnostics do not invalidate
otherwise accepted adoption; explicit clear, identity/account conflict or invalid
target never authorize this repair.

Any valid native exact sender name suppresses remote repair. A differing old
canonical name versus that native name remains a source-priority/conflict case
for the main reader; this predicate does not overwrite it or invent a separate
repair envelope. The predicate neither creates acquisition-account evidence nor
treats acquisition proof as sender-name adoption proof. The main route owns
source-account acquisition binding and its response observation timestamps.
