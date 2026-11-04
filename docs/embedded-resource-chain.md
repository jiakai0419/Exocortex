# Embedded image resources

This local candidate extends only the existing resource chain. It makes no production request, permission change or claim that an arbitrary attachment key is downloadable. The shared [execution/content contract](evidence-and-embedded-media-contract.md) governs integration.

## Reference and read-time evidence

`media-image-slot.mjs` is pure. `createImageSlot` returns a bounded version1 occurrence with a deterministic source JSON pointer, order, message type, selected representation, reference kind/state, key or null and optional alias. The maximum is64 occurrences. Missing, invalid, conflicting and overflow references remain incomplete. An ordinary object containing `available` cannot prove bytes.

Content renderers emit `media_slots` while traversing their single selected representation. `media-resource-references.mjs` reuses those renderers and validates the row's exact source/message/chat/type envelope. It does not implement an independent card selector. The extractor's `complete` means complete extraction only; source structure, identity and actual resources have separate completeness requirements.

The resource store brands only a successful fully verified read, under its normalized source/account/message/version/key binding. `imageSlotDisplay` accepts a resolution only when that branded read and the exact occurrence binding agree. Cloning/serializing a receipt loses its authority. The text is an in-position neutral marker with no key/path. `projectEmbeddedMediaResources` returns JSON-safe resources separately from an internal `resolveImage(slot)` closure. The existing top-level image interfaces and v1 cache identities remain compatible.

Native explicit image keys must meet the existing message-resource endpoint's documented type contract before requests are eligible. Card attachment `origin_key` is not promoted to `image_key` by syntax; until endpoint eligibility is independently established it remains unverified, receives no request and cannot make content ready. Actual file validation is always required even for an eligible key.

## Durable work and bounds

Reuse `lark_im_resource_work`: its stable endpoint work key already distinguishes resource keys within one message. Extract plural identities, deduplicate requests for the same endpoint key, and match the selected task by its exact work key. Real repeated image occurrences remain in the rendered order. The producer receives one exact resource target, not all resources in the selected record, preserving its existing3 CLI/2 self unit and existing shared total budget.

Migration024 broadens the conservative type index to `post` and `interactive`; it does not alter source rows, queue state, scan cursors or denial/exhaustion. Keep20 newest and20 historical source candidates, the fixed historical horizon,128KiB automatic-row limit and8MiB page limit. This broad index may inspect cards without images; it must not use a textual `img` filter that misses valid JSON encodings. No old-history completion deadline is inferred from the index change.

An expanded row must not repeat its whole raw/canonical SQL fence for every image. In the existing admitted transaction, a temporary valid-row relation evaluates each exact source fence once; per-resource INSERTs refer to that relation. A concurrently changed source enrolls none of its slots, without weakening the source/account/scan CAS or suppressing other unchanged rows. No persistent staging table or extra remote allowance is added. Tests bound SQL growth against total source bytes and distinct references rather than their product.

All old claim/result, pending-file, account closure, strict byte validation, cleanup, source association, denial, eight-claim/three-failure, restart and fresh/old fairness rules remain. Unsupported endpoint eligibility is distinct from remote permission denial. A source-derived change cannot revive exhausted or denied endpoint work.

## Validation

Use only newly authored source rows, accounts and image bytes. Cover multiple slots and same-key occurrences, aliases and selected representations, mismatched message/account/version, missing/altered files, forged read receipts, exact producer target selection, original per-unit/cycle limits, source changes during enrollment and result CAS, restart, deep history, candidate-index migration/rollback and SQL expansion cost. The integration owner additionally verifies actual `messages` JSON/text and old-neighbor fidelity. Real source structures and resource keys are not test fixtures.
