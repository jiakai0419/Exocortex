# Explicit source tombstones in message display

An explicit own `deleted: true` data property in canonical metadata, outer raw
or a valid object-valued native `raw_api` wrapper is one retained source
tombstone. Strings, numbers, false, inherited values and invalid wrappers do not
establish this state. One shared predicate is used by evidence and display;
normal old object wrappers need no additional invented schema.

The default content projection is the neutral `[已撤回/已删除]` marker at the
existing message position. This applies both to invalid original content and
to valid retained prose, cards, forms, system messages and media. A source
tombstone bypasses content/resource reprojection so an old static input value,
cached image or card result cannot shadow it. The previous longer marker
asserted that original rich text was absent, which is not true for every
retained message; the neutral wording makes no such inference.

Archival body, raw, canonical, hash, identity, event time and ordering are
unchanged. The same selected rows remain visible. Content evidence may be
satisfied by the tombstone, but it cannot supply a missing sender, recipient or
operator. An incomplete identity keeps its existing state/reasons and also
shows the tombstone marker in its original terminal block. Ordinary live
messages keep their current layout and content semantics. Status, collection,
queues, permissions and resources themselves are not changed.

Validation retains the original five independent CLI failures unchanged and
adds a finite type/source matrix, strict negative controls, identity-incomplete
messages, a resource-budget tripwire, ordinary card/post neighbors and unchanged
database bytes. All inputs are independently fictional. The original missing
recall routes predate the finite renderer; the newly supported form made retained
values visible through that existing route. This is not described as five new
regressions or as evidence of production disclosure.
