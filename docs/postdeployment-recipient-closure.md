# Post-deployment recipient closure

Base: `5da2f7ca507ad0332949d16e1b681e2b0e5fb2b0`. This is an isolated local candidate, not a production change or release authorization. All fixtures are invented from scratch. Private production evidence stays outside this repository and cannot become a fixture, including redacted data.

## Observed problem and completion criterion

Read-only production acceptance found newly collected ordinary human-sent p2p text with valid source/account proof but no `chat_partner`, no trusted scope recipient, and no persisted recipient task. These messages remain incomplete. A nonempty chat title is not proof of a person, and the absence of a task is not successful resolution. Why eligible records did not enroll is under investigation; no upstream denial or regression classification is assumed.

The fix must make exact-account unresolved p2p work reachable through the real successful sync and worker paths. A coordinator may prioritize work, but selection must not be a prerequisite for discovering and durably recording otherwise eligible recovery work. Enrollment, claiming, remote resolution and projection retain their distinct transaction and evidence boundaries. The synthetic counterexample must first fail on the base and then pass through the actual CLI after repair.

The normal path should prepare complete identity before formal readability whenever existing local or admitted remote evidence permits. A durable task is necessary recovery evidence, not sufficient end-to-end acceptance. Measure actual source occurrence to correct `messages` JSON and terminal observation, retain the full denominator and disclose missing stages. No arbitrary minutes target is claimed as an agreed production SLO.

## Ownership and scope

Main integration checkout: `/tmp/exocortex-recipient-closure-20261029-k0ia7rdq/repo`.

| Owner | Boundary |
| --- | --- |
| Main integrator | This document; `name-sync.mjs`, `recipient-sync.mjs`, and necessary narrow sync integration after a reproduced cause; final integration and candidate verification |
| Local regression agent | New recipient enrollment regression test file and self-contained synthetic test helper only, after interface agreement; no shared product edits |
| External content implementation route (parent assigned) | Separate supported-content contract, isolated implementation/tests and frozen patch; main does not concurrently modify those modules |
| Local content review | Completed read-only type/semantic inventory only; private handoff outside the repo, no product changes |
| External application route | Isolated legacy unknown-task backoff patch; integrate its frozen patch once, preserve exact denial and budgets; shared-file conflicts resolved by main |
| External independent route | Counterexamples and frozen-candidate verification; no main-tree product writes |

No production writes, hand-filled recipients, queue resets, service or permission changes, force push or deployment. Do not alter status layout, filter incomplete rows to fill the requested limit, guess typed identity from prefixes, or assign an individual recipient to a group.

## Required invariants and gates

- Strict source/account/chat/witness binding; exact p2p type and own-sent proof. Foreign accounts, conflicting metadata, group/topic/system/application conversations cannot be converted to personal recipients.
- Exact local evidence is used before remote lookup. Missing relationship evidence is neither a guessed name nor a permanent unsupported identity.
- Preserve existing account admission, finite API calls, monotonic budgets, locks, predecessor CAS, cursor progress and rollback. Network stays outside transactions. No global unbounded scan or extra scheduler daemon.
- Independent enrollment must not clear backoff, reset claims or stale proof, duplicate work on restart, or claim freshness from an empty discovery call. Durable selection must see old and new eligible tasks fairly.
- Synthetic real CLI matrix: absent partner with precise p2p scope; no scope/unknown type; trusted partner; group/topic; cross-account; 40-row scan boundary and old queue competition; empty discovery followed by actual collection; crash/restart and CAS loser; API success/denial/timeout/budget exhaustion. Check actual JSON/text and preserved neighbour identity/body/time/order.
- Separate content types by actual semantic payload. A supported attachment reference or intentionally non-text payload requires an explicit faithful representation and invalid/missing-reference negative tests. Never turn unknown/invalid content into ready merely by changing a label.
- After focused tests, build, typecheck, syntax, generated-file check and full verification on a fixed candidate; independent acceptance and read-only real-message comparisons. Candidate bundle is persisted and restoration checked before any separately authorized release.

## Implementation and measured outcome

Read-only evidence now distinguishes two defects. A recipient candidate can be present but omit `freshOrder`, sorting behind every old sender task with a positive source record position. Separately, its discovery predicate depends on the name coordinator's mixed-direction page, so a valid sent witness can be absent before recipient discovery is ever invoked. The first was observed in the production scheduling inputs; neither observation alone proves what every past invocation did.

The proposed narrow interface is `prepareRecipientWork(db,self,deps)`. It reuses the recipient workflow's existing newest-sent, historical-sent and queued-witness bounds, account/source/scope fences and local evidence validation. Preparation commits only enrollment and scan progress, before shared remote selection. It returns finite `pending`/`freshOrder` metadata and a one-use `run()` continuation containing the captured selection. The continuation separately commits the original exact claim before any network call and then uses the existing resolver/result path. It revalidates captured predecessor state, records, scopes and account; a stale continuation fails closed. No extra scan or independent network budget is created.

`syncRecipients` remains a wrapper that prepares and executes for existing callers. `syncNames` prepares once after its cadence check, passes the recipient's accurate positive fresh record position into the common policy, and runs the continuation only if selected. No eligible work means no shared cadence reservation. An injected test recipient executor must still be selected from the real prepared inventory; it is not an alternate product path.

Local enrollment must survive another role being selected and process restart without resetting existing retry/claim/evidence. Actual preparation time and execution time share the original optional-tail deadline. The new regression file first records failures against the unchanged base; final implementation/test outcomes remain pending.

Initial implementation now follows that split. The exact base reproduces three failing gates: a sent witness between full received pages, a completed recipient scan followed by now-valid p2p metadata, and a newest p2p target competing with eighty older sender tasks. Five negative controls pass on the base. The candidate passes sixteen new cases, including cross-process enrollment recovery, another role winning without discarding enrollment, one-use continuation, stale row/scope/state/account rejection before requests, and the shared elapsed deadline. The actual public sync/messages paths preserve the complete synthetic record population and terminal projection.

Existing focused validation is 66 recipient/coordinator cases plus 27 public-command/worker/adversarial cases; typecheck and whitespace checks pass. These are focused results, not final full-tree or production acceptance. Full verification and combined-route integration remain required. The tests measure the suffix from local data to the next correct CLI observation, not production source-to-readable latency.
