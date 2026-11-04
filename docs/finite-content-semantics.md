# Finite card and post semantics

This local implementation follows `evidence-and-embedded-media-contract.md`.
It changes neither account permissions nor production data. Every fixture is
independently invented; no captured or sanitized message is a test fixture.

Card panels preserve their title and child order. Forms project their declared
labels, options, required/disabled states and supported explicit values. A
placeholder remains a labelled hint. An empty control is a valid static state;
it is not proof of a missing message field. A submit button describes an action,
not its execution or outcome. Request actions are never executed. Conflicting
or unknown selection declarations and unknown nodes remain incomplete.

`markdown_v1` selects one supported primary representation. A fallback is used
only when the primary representation is absent; invalid primary data is never
hidden by another representation. Existing ordinary cards retain their text,
limits, mention resolution and navigation rules. Newly supported card semantics
use projection version 4; an unchanged ordinary card retains version 3.

Post text and images remain at their source positions within the selected
locale and content branch. A nonempty valid `content_v2` takes precedence;
the existing empty-array fallback to `content` is preserved. An invalid declared
primary branch is incomplete and cannot borrow a valid fallback as success.
Posts using the new image projection use version 2; ordinary posts retain
version 1. Original native evidence is never rewritten.

The internal `legacyPostImages: true` verifier rebuilds the former version-1
post projection exactly, including its declared structural fallback. It does
not extract media slots or consume resource evidence. It exists only so the
read path can verify an old stored body before superseding an obsolete renderer
flag; it is not a user-facing fallback that can make invalid new content ready.

An image occurrence contributes an additive `media_slots` entry, whose identity
is its selected JSON pointer and order. At most 64 occurrences are described.
Overflow, unresolved or ambiguous references stay incomplete. Two genuine
occurrences of one image retain both positions; native/fallback copies do not.
Attachment aliases are resolved only in their own attachment scope. An origin
key is not silently converted into an image key or an approved download route.

The resource helper owns slot validation and trusted verified-image evidence.
Renderers are pure: they do no filesystem or network work and accept no ordinary
`available` object as proof. Without exact verified evidence, the original
position contains a neutral missing-image notice and content remains partial.
The resource and message projection owners integrate actual byte verification
and historical reading. Successful image evidence cannot clear an unrelated
identity, unsupported-node, mention or system-parameter defect.

Targeted controls cover source order, repeated occurrences, branch selection,
invalid primary/fallback combinations, alias ambiguity, selection contradictions,
placeholder-versus-value and action nonexecution. Integration additionally
checks real messages JSON and terminal commands on fictional SQLite databases,
including old post projections and independent identity/content incompleteness.
