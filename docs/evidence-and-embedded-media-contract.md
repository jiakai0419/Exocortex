# Bounded execution evidence and embedded media

Base: `659bceffeb3b95ddc4c565392691e4c902da6f66`. This is a local candidate design. It authorizes no deployment, permission change, directed repair or additional production request. All examples and test fixtures are invented. Private observations and their derivatives must not enter Git.

## Ownership and integration

The integration checkout owns this contract, message projection/completeness integration, migration-count fixtures and final validation. Parallel changes remain in separate checkouts until reviewed integration.

* Execution evidence owns `runtime/lark-api-lease.mjs`, maintenance request/history diagnostics, history transaction code, narrowly scoped SQLite execution evidence, associated core types, migration **025** if needed and new execution tests. Worker history compaction changes are part of that patch; other worker scheduling is unchanged.
* Content semantics owns `adapters/lark-im/card-content.mjs`, `raw-message.mjs` and new semantic tests. It does not edit the resource store or completeness reducer.
* Embedded resources owns new pure slot/reference modules, media content/store/projection, resource candidate/work/enrichment code, migration **024**, and new resource tests. It does not edit card/raw renderers or the messages entry point.
* Independent acceptance owns a separate synthetic test/evidence directory and never modifies the integration checkout.

Existing names, source/account admission, limits, status, terminal layout and ordinary message ordering remain in force. This candidate does not promise that every upstream name or resource is visible.

## Lease and transaction evidence

Keep original operation failure and later command-budget termination as independent facts. Retain existing stop reasons for compatibility and add a closed, trusted lease diagnostic containing request/commit phase, intent/API/post-acquire stage, finite state/reason, and bounded grant/elapsed values observed at that boundary. No CLI text, arguments, paths, raw exceptions or identity values are diagnostics. Arbitrary objects with matching property names are not trusted receipts.

The command work-budget check remains before lease acquisition. No admissible remainder means no helper/action. A helper failure followed by clock exhaustion remains a helper failure plus a later budget stop. Do not relabel unavailable as busy, permission denial, or a successful deferral without evidence. Keep shared idle limits, dynamic history grants, completion/output reservations, the two-second coordination ceiling, lock checks and retry behavior unchanged.

Separate action entry, actual SQL dispatch/execution evidence, validated committed effects and cleanup. Entering a JavaScript function is not SQL execution. Explicit process-launch failure may prove not started; uncertain process results remain unknown. Only a validated transaction receipt establishes committed effects. A later cleanup/output error preserves those effects. Retain returned prefix effects independently from an interrupted target.

Use opaque attempt/target references in compact output. Do not publish raw target identity. For durable successful transactions, minimally extend the existing replay audit with an explicit nullable history target marker and, if needed, a target-fence fingerprint. Ordinary/manual replay stays unmarked. Retain the newest **64 marked history receipts**, plus every marked receipt still referenced by current history progress/debt/scheduler. Evict only explicitly marked history receipts; never guess provenance from an attempt string or delete unrelated manual audits. Keep all existing effects and guards in the same transaction and avoid expanding record-write SQL. Upgrade and rollback eligibility must be tested.

No pre-commit diagnostic database write or unbounded separate log is introduced. A target without durable dispatch/commit evidence can remain unknown; the candidate must not claim to reconstruct an older missing target or receipt.

## Shared embedded-image interface

Keep the existing renderer text/status/reason interfaces. Only messages containing embedded references gain an additive `media_slots` array. One slot is an occurrence in the single selected representation, not a download job. Genuine repeated occurrences remain in order; primary/fallback representations must not be rendered twice.

The resource owner provides a pure `media-image-slot.mjs` helper, with no filesystem/network imports, to define and validate slots and trusted read-time verified evidence. Content renderers use it; the higher `media-resource-references.mjs` extractor may call content renderers with no read-time evidence. This prevents parser/representation drift and import cycles.

Slot version 1 includes `slot_id` (deterministic JSON pointer within the selected source representation), `order`, `message_type`, `representation`, `reference_kind` (`image_key` or `attachment_origin_key`), `reference_state`, and `key` or null. Alias resolution is confined to the same attachment scope. Conflicting/invalid/missing references produce explicit issues. At most **64 occurrence slots** per message; overflow remains incomplete and never silently truncates into readiness.

Resource extraction returns `{version:1, slots, issues, complete}`; `complete` means reference extraction is complete, not that content or files are complete. Download references may deduplicate identical exact resource identities while preserving every occurrence slot. An opaque key alone is not valid file evidence. Native explicit image-key references may use the existing message-image endpoint only under its documented typed contract; an attachment origin key is not automatically an image key. Unverified endpoint eligibility remains explicit and must neither trigger a request nor become ready. No external query is made to resolve that uncertainty in this implementation task.

Renderers may receive an internal `resolveImage(slot)` function. They accept only evidence created by the resource module after exact binding and actual local-byte verification; a raw `available` boolean, canonical field or ordinary JSON object cannot establish readiness. The resolver does not perform network calls. Without evidence, retain an in-position image reference diagnosis. Keep key/path values out of terminal text. The integration owner connects this to the actual `messages` read path and completeness evaluation, not only normalization.

## Finite content semantics

Support post image/text ordering and only the documented finite card structures needed here: image, collapsible panel, form and `markdown_v1`. Preserve existing ordinary-card behavior outside those additions. Unknown tags, contradictory declarations, ambiguous aliases or unrecognized representation shapes stay partial/unsupported.

Panels retain title and content order. Forms faithfully present labels, options, required/disabled state and explicitly supported values/selections. A valid unfilled control is a static state, not missing captured data. Placeholder text is a hint, not a value. A submission/action definition is not proof that an action ran. Never execute `action_request`. Conflicting or unrecognized initial-selection declarations remain partial instead of guessing precedence. A supported primary representation is selected once; invalid primary data cannot be hidden by a convenient fallback.

System messages require explicit authoritative event parameters. Do not infer a person from a group name, neighboring message, current account or nonempty display text. Identity completeness and content completeness remain independent; one cannot clear the other.

## Resource task and storage behavior

Reuse the existing work table and work identity where possible. It already admits distinct resource keys for the same message; use plural identity extraction and exact selected-work matching. Revalidate each resource against source, account, message, whole source content/version and typed reference. Cached bytes for another account/source/version/slot cannot transfer. Keep legacy top-level image bindings and cache behavior compatible.

Migration 024 broadens conservative candidate discovery to post/interactive without silently excluding valid JSON representations. Keep fixed horizons, fresh/history scan budgets, CAS and restart progress; do not reset cursors or target particular messages. Broad type candidates are not proof of an eligible resource. Measure synthetic deep-history costs rather than claim immediate recovery of every old message.

Preserve the original per-unit and shared API/self/time budgets, fairness, failure limits and exhausted/permission isolation. Multiple slots cannot expand one message into unbounded SQL or requests. The real path must be ingestion/discovery → durable work → ordinary worker → verified private resource → messages projection. Failures retain finite causes and source associations. Do not revive an exhausted task or retry an explicitly rejected route as a side effect.

## Acceptance and limits

Before freezing, run meaningful authored controls for trusted/untrusted lease results, deadlines, real flock busy, helper failure, SQL pre-dispatch/CAS/unknown outcomes, validated commit with cleanup failure, prefix preservation, retention eviction/restart and upgrade/rollback. Preserve original timing/count assertions and failed evidence.

Use actual messages JSON and terminal commands against invented SQLite data for post ordering, selected card representation, aliases, multiple slots, form hints/actions/selection conflicts, absent system identity and independent name/content debt. Recompute old post/card content from validated current raw input rather than trusting an obsolete stored rendering flag; do not mark a conflicting or unverifiable legacy body ready. Exercise actual resource enrollment/worker/reading under fixed budgets, continuous new work, deep history, restart and source/account changes. A key-only, wrong-binding, missing-file or invalid-byte row stays incomplete. Neighbor bodies, names, timestamps, order and layout remain intact; no filtering to fill a limit.

Complete type/build/syntax/regression verification on the exact frozen candidate and independent verification are required. Environment-denied process checks remain explicitly unverified until legitimately available; do not bypass them or combine partial runs into a full pass. Preserve a local code-only bundle with exact SHA/tree recovery proof. Private evidence stays outside that bundle and Git. No push or deployment is authorized.
