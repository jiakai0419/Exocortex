/** Consumer namespaces are part of a card reference, not interchangeable ID
 * spellings. The renderer and source proof use the same dispatch policy while
 * supplying their own bounded reads and identity tables. */
const CARD_ID_NAMESPACES = ["open_id", "user_id", "union_id", "app_id"];
function resolveCardMention(payload, bindings) {
    const { read, id } = bindings;
    const declaredId = read(payload, "id"), declaredType = read(payload, "id_type");
    let match = null, typed = false, valid = true;
    const consume = (namespace, value) => {
        typed = true;
        const exact = id(value), identity = exact ? bindings.typed(namespace, exact) : null;
        if (identity == null || match !== null && match !== identity)
            valid = false;
        else
            match = identity;
    };
    if (declaredType !== undefined) {
        const namespace = id(declaredType);
        if (!namespace || !CARD_ID_NAMESPACES.includes(namespace)) {
            typed = true;
            valid = false;
        }
        else
            consume(namespace, declaredId);
    }
    for (const namespace of CARD_ID_NAMESPACES) {
        const flat = read(payload, namespace), nested = read(declaredId, namespace);
        if (flat !== undefined)
            consume(namespace, flat);
        if (nested !== undefined)
            consume(namespace, nested);
    }
    // A typed node never falls through to a native alias or a mention key.
    if (typed)
        return valid ? match : null;
    const native = id(read(payload, "userID"));
    if (!native)
        return null;
    return resolveNativeCardReference(native, bindings);
}
/** Native node and XML references share this policy. The caller has already
 * validated/debited the exact ID; it must not be cleaned or charged twice. */
function resolveNativeCardReference(native, bindings) {
    // Even an empty or malformed attachment disables legacy fallback.
    if (bindings.hasAttachment)
        return bindings.native(native) ?? null;
    let matches = 0, match = null;
    for (const namespace of [...CARD_ID_NAMESPACES, "literal"]) {
        const identity = bindings.typed(namespace, native);
        if (identity !== undefined) {
            matches++;
            match = identity;
        }
    }
    const mention = bindings.mention(native);
    if (mention !== undefined) {
        matches++;
        match = mention;
    }
    return matches === 1 ? match : null;
}
export { CARD_ID_NAMESPACES, resolveCardMention, resolveNativeCardReference };
