# Storage and entrypoint contracts

This describes the current Node candidate, not production acceptance. [Operations](operations.md) covers commands and maintenance; [Node reliability fixes](node-reliability-fixes.md) retains the original counterexamples. All test sources, identities, messages and databases are invented.

## Transactions and leases

Normal sync, discovery and detail completion share `runFenceGuardSql` and a **20-minute hard lease**. The fence executes inside the same `BEGIN IMMEDIATE` transaction as records, statistics, scope state and cursor effects. It checks the running run, source/scope identity, owner and acquisition timestamp, the transaction's SQLite clock, unchanged cursor, and enabled source/scope. An earlier JavaScript check is only an early exit; it cannot replace this guard.

Creating a run and acquiring its lock also require an enabled source/scope. A persisted initial baseline does not authorize a disabled source. Normal sync and bounded replay therefore share the same enable/disable boundary. If disable happens after fetch, writes fail atomically. `failRun` can close an otherwise valid owned run after disable, without saving records or advancing the cursor. Replaced owners, expired hard leases and changed cursors still reject it.

Lark list/detail transactions additionally check chat identity, progress generation, the list anchor and root fingerprint/version. They compose the common fence and record writer inside one transaction. Incomplete list pagination writes no progress. A complete list can save ordinary records and durable detail debt together, but missing detail content still blocks the full-content cursor. See [the list/detail contract](node-reliability-fixes.md#incomplete-details-and-bounded-progress).

The soft lock expiry, hard lease and process liveness are different evidence. None proves current activity; [Activity evidence](activity-evidence.md) requires a current phase and process identity. Maintenance enrichment uses a separate short lease, acquired only after remote lookups. Its shared helper checks owner, expiry and absence of sync locks inside the local write transaction, then performs CAS updates, counts effects and releases the owned lock. Dry runs and zero-change runs do not acquire that lock.

## Module ownership

The stable compatibility entrypoint remains `scripts/lib/ingestion-store.mjs`. Implementation modules depend on the small modules below, never back on the public facade.

| Module under `src/storage/sqlite` | Responsibility |
| --- | --- |
| `ingestion-store.ts` | Public facade, initialization/baseline and generic run lifecycle |
| `ingestion-types.ts` | Shared internal record, scope and result types |
| `sqlite-executor.ts` | Quoting, JSON, private file permissions and one SQLite subprocess implementation; exec/query select output form |
| `sync-locks.ts` | Acquisition, recovery and maintenance owner/lease handling |
| `sync-run-fence.ts` | Common hard lease, run fence and cursor predicates |
| `record-storage.ts` | Batch normalization, version/identity checks, record SQL and effect counts |
| `lark-ingestion.ts` | Lark raw-root normalization, fingerprints, list/detail progress, generation checks and bounded replay transactions |
| `lark-name-projection.ts` | Lark-specific name inheritance and trusted alias checks |

SQL fragment helpers do not open nested transactions. Their caller composes guards and effects in a single write transaction. Generic runs for a second source neither read Lark progress tables nor inject Lark chat/list metadata. Name projection merging applies only when both source and record type are the Lark message type. This is a finite dispatch boundary, not a plugin framework.

SQLite reads through the write store retain its existing private-path behavior. Read-only diagnostics use `readonly-query.mjs`; consolidating subprocess code does not turn those reads into write-store calls.

## Source versions

An adapter must declare whether a remote value is ordered. `encodeSourceVersion({ revision })` accepts an exact nonnegative integer as a decimal string, bigint or safe integer and returns canonical decimal text. `encodeSourceVersion({ token })` encodes an opaque string as `opaque:` followed by its JSON string representation. Numeric-looking tokens, whitespace and the empty token remain opaque and distinct. Preserve the original remote value in raw source content.

For compatibility, existing decimal `external_version` values remain ordered revisions; other stored strings are opaque. Revisions compare at arbitrary precision, without floating-point conversion. An older revision or a missing version cannot replace a known newer version. Equal versions can improve projections; bounded Lark replay retains its stricter newer-revision rule.

Different opaque tokens have no intrinsic order. Without an explicit predecessor, a different token cannot replace an existing one. For a source with an authoritative fetch, the adapter may first observe the stored version, then fetch the source, and supply the ephemeral `expected_external_version` hint:

| Hint | Guard in the same write transaction |
| --- | --- |
| Omitted | No predecessor assertion; ordinary version rules apply |
| `null` | No existing versioned record for this source and external identity |
| Stored version string | An existing record must still have exactly that stored version |

A matching string hint can authorize an unordered-token replacement only when both versions are nonnumeric. It cannot authorize numeric regression, erase a known version, change the record type, or move a record across sources. Failed CAS aborts the surrounding batch, including run/cursor/progress effects. The hint is not persisted in the record, canonical projection or raw payload. CAS proves absence of an intervening local replacement, not the ordering or freshness of remote tokens.

Ordinary writes without a CAS hint retain version-protected `record_type` replacement: equal or newer revisions, equal opaque tokens, and unversioned replacements can reclassify a record. Older revisions or different opaque tokens still cannot replace it. Batch normalization applies the same version selection without treating record type as globally immutable.

Explicit CAS candidates cannot repurpose a record's type. A batch with any CAS hint rejects conflicting types or predecessor hints for the same identity, so normalization cannot discard a CAS assertion. Different unordered versions in one batch are also rejected. Source plus external identity remains the database uniqueness key; adapters must choose external identities that are unique within their source. The record's first-seen scope must belong to that source. Type and predecessor guards for explicit CAS, and source/scope ownership for all writes, are checked inside the write transaction.

## Queries and entrypoints

`messages` and Lark lag/quality queries explicitly require both `source_id = 'lark.im'` and `record_type = 'lark.im.message'`. A different source or a different record type cannot be rendered as a Lark message or satisfy a sampled message lookup. Generic `sync-status` record totals intentionally aggregate all sources; those totals are not Lark message counts.

Transport, adapter detail classification and runner batch stopping use the same finite failure kinds. Exhausted transient failures include API internal-error codes 2200/1663 with their expected API envelope/message. Permission failures during detail retrieval become durable detail debt; they do not disable an otherwise readable scope. Only the list operation's supported permission evidence can disable that scope.

Service status aggregates recent failed runs with the same classifier and exposes only enum names and counts. Recognized permission evidence, including code 210508 and the supported permission messages, is `permission_denied`. Empty evidence and unrecognized public kinds remain `unknown` unless another supported signal establishes a classification. Known rate-limit, timeout, internal-error and scope-denial evidence retains its classification priority over fallback permission prose. Neither the JSON summary nor the terminal summary includes the original error text.

Shared classification does not combine time budgets: a CLI subprocess defaults to 120 seconds, a request including retries to 180 seconds, a list window shares its own 180-second budget, and a queued detail attempt has at most 30 seconds. Only exhaustion of the list window's time budget permits bounded prefix shrinkage; internal errors and detail failures cannot trigger that path. Optional naming and single-chat metadata calls use a separate shared five-second request budget. The enrichment commands use the same transport with retries disabled and keep their existing workflow limits.

Contact/member/application/bot lookup rules belong to the existing name resolver. Record enrichment consumes those rules and maps optional private observations into its existing diagnostics; scope enrichment consumes the adapter's single-chat metadata response. The two workflows retain distinct candidate selection and CAS updates. An explicit application probe bypasses its positive cache, while failed refresh remains unknown and retryable. See [identity and projection](card-and-identity-projection.md) for the complete evidence contract.

Worker and service use one default/validation module with an explicit persistence whitelist. Adaptive options can be installed in the long-running service; `--once`, `--max-cycles` and a diagnostic database override cannot enter its plist. Steps, cycles and `wait-ok` use the same injected observation clock in tests and the system clock by default. Service rollback and diagnostic exit semantics are documented in [Operations](operations.md).

Normal message preparation converts each message once. Equal-time/equal-ID candidates retain the previous received-before-sent ordering and stable order within each group, so a same-version duplicate still selects the same final record. The cursor probe recomputes count and order after filtering self messages. Filtered records retain their original page positions; the original-page summary and paging probes still describe the complete upstream page. Test fixture helpers share setup and read-only assertions, while individual synthetic counterexamples remain in their own suites.

## Verification boundaries

Regression suites include `ingestion-contracts.test.mjs`, `ingestion-source-contracts.test.mjs`, detail storage and replay, transport/adapter/runner, doctor child exits, service rollback, maintenance boundaries, worker options and cursor probes. They retain negative cases for rollback, stale owners, disable races, opaque CAS conflicts, numeric regression, incomplete content, error privacy and independent foreground work.

The full test command limits concurrent test files to four. Integration fixtures start real local child processes under the same five-second lookup deadlines as the application, so host CPU count must not multiply competing fixtures without a bound. Every test file and assertion still runs; production timeouts and retry policies are unchanged.

`npm run build:check` compiles into a newly created temporary directory, compares the complete output file set and bytes with `dist`, and removes its temporary output in `finally`. Missing declarations, stale content and orphan generated files fail the check, even when Git considers `dist` clean. The check does not repair or rewrite `dist`; ordinary `npm run build` does write it. `npm run verify` composes the required development checks without calling service lifecycle operations and belongs in an isolated checkout. The existing runtime maintenance recipe must stop the service before a build or test. History documents remain design records and link here rather than claiming to describe current behavior.

Local synthetic checks do not authorize account queries, production data changes, publication or deployment. Real sender lookup can remain unresolved when remote evidence is insufficient. No Rust rewrite or independent CLI entrypoint migration is introduced by these changes.
