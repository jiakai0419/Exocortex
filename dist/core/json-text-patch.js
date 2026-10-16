const LIMIT_BYTES = 1024 * 1024;
function parseText(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT_BYTES)
        throw new Error('json_patch_limit');
    let at = 0, nodes = 0;
    const space = () => { while (/[\x20\t\r\n]/.test(text[at] || 'x'))
        at++; };
    const string = () => {
        if (text[at] !== '"')
            throw new Error('json_patch_invalid');
        const start = at++;
        while (at < text.length) {
            if (text[at] === '\\') {
                at += 2;
                continue;
            }
            if (text[at++] === '"') {
                try {
                    return JSON.parse(text.slice(start, at));
                }
                catch {
                    throw new Error('json_patch_invalid');
                }
            }
        }
        throw new Error('json_patch_invalid');
    };
    const value = (depth) => {
        if (++nodes > 20000 || depth > 64)
            throw new Error('json_patch_limit');
        space();
        const start = at, c = text[at];
        if (c === '"')
            string();
        else if (c === '{' || c === '[') {
            at++;
            space();
            const end = c === '{' ? '}' : ']', members = c === '{' ? [] : undefined;
            const keys = new Set();
            if (text[at] !== end)
                while (true) {
                    space();
                    if (members) {
                        const keyStart = at, key = string();
                        space();
                        if (keys.has(key))
                            throw new Error('json_patch_duplicate_key');
                        keys.add(key);
                        if (text[at++] !== ':')
                            throw new Error('json_patch_invalid');
                        members.push({ key, keyStart, value: value(depth + 1) });
                    }
                    else
                        value(depth + 1);
                    space();
                    if (text[at] === end)
                        break;
                    if (text[at++] !== ',')
                        throw new Error('json_patch_invalid');
                }
            at++;
            return { start, end: at, ...(members ? { members } : {}) };
        }
        else {
            const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0];
            if (!token)
                throw new Error('json_patch_invalid');
            at += token.length;
        }
        return { start, end: at };
    };
    const result = value(0);
    space();
    if (at !== text.length)
        throw new Error('json_patch_invalid');
    return result;
}
/** Validate all nested syntax/keys without converting any number. */
function validateJsonObjectText(text) {
    if (!parseText(text).members)
        throw new Error('json_patch_object_required');
}
/** One owned root member, preserving separators as well as unknown value
 * tokens. Appending then removing that member restores the original bytes. */
function patchTopLevelJsonMemberText(text, key, value) {
    const root = parseText(text);
    if (!root.members || typeof key !== 'string')
        throw new Error('json_patch_object_required');
    if (value !== undefined)
        parseText(value);
    const index = root.members.findIndex(member => member.key === key);
    let start, end, replacement = value ?? '';
    if (index < 0) {
        if (value === undefined)
            return text;
        start = end = root.members.at(-1)?.value.end ?? root.start + 1;
        replacement = `${root.members.length ? ',' : ''}${JSON.stringify(key)}:${value}`;
    }
    else {
        const member = root.members[index];
        if (value !== undefined) {
            start = member.value.start;
            end = member.value.end;
        }
        else if (index > 0) {
            start = root.members[index - 1].value.end;
            end = member.value.end;
        }
        else if (root.members.length > 1) {
            start = member.keyStart;
            end = root.members[1].keyStart;
        }
        else {
            start = member.keyStart;
            end = member.value.end;
        }
    }
    const result = text.slice(0, start) + replacement + text.slice(end);
    parseText(result);
    return result;
}
/** A raw JSON value is supplied only for an owned path; omitted value deletes
 * that path. Missing intermediate objects are created for sets, not deletions.
 * Existing non-object intermediates are rejected instead of silently replaced.
 * Unedited value subtrees (including their whitespace) retain their exact bytes. */
function patchJsonText(text, patches, allowedPaths) {
    const root = parseText(text);
    if (!root.members)
        throw new Error('json_patch_object_required');
    if (patches.length > 20000)
        throw new Error('json_patch_limit');
    const allowed = new Set(allowedPaths.map(path => JSON.stringify(path)));
    const paths = { terminal: false, children: new Map() };
    for (const patch of patches) {
        if (!patch.path.length || patch.path.length > 64 || patch.path.some(key => typeof key !== 'string') || !allowed.has(JSON.stringify(patch.path))) {
            throw new Error('json_patch_unowned_path');
        }
        let cursor = paths;
        for (const key of patch.path) {
            if (cursor.terminal)
                throw new Error('json_patch_overlapping_paths');
            if (!cursor.children.has(key))
                cursor.children.set(key, { terminal: false, children: new Map() });
            cursor = cursor.children.get(key);
        }
        if (cursor.terminal || cursor.children.size)
            throw new Error('json_patch_overlapping_paths');
        cursor.terminal = true;
        if (patch.value !== undefined)
            parseText(patch.value);
    }
    const apply = (node, changes) => {
        if (!node && changes.every(patch => patch.value === undefined))
            return undefined;
        if (node && !node.members)
            throw new Error('json_patch_object_required');
        const members = node?.members || [], seen = new Set(), parts = [];
        const grouped = new Map();
        for (const patch of changes) {
            const children = grouped.get(patch.path[0]) || [];
            children.push(patch);
            grouped.set(patch.path[0], children);
        }
        let changed = !node;
        const changeValue = (key, current) => {
            const children = grouped.get(key);
            if (!children)
                return current ? text.slice(current.start, current.end) : undefined;
            if (children[0].path.length === 1)
                return children[0].value;
            return apply(current, children.map(patch => ({ ...patch, path: patch.path.slice(1) })));
        };
        for (const member of members) {
            seen.add(member.key);
            const before = text.slice(member.value.start, member.value.end), after = changeValue(member.key, member.value);
            if (after !== before)
                changed = true;
            if (after !== undefined)
                parts.push(text.slice(member.keyStart, member.value.start) + after);
        }
        for (const key of grouped.keys())
            if (!seen.has(key)) {
                seen.add(key);
                const after = changeValue(key, undefined);
                if (after !== undefined) {
                    parts.push(`${JSON.stringify(key)}:${after}`);
                    changed = true;
                }
            }
        return !changed && node ? text.slice(node.start, node.end) : `{${parts.join(',')}}`;
    };
    const result = text.slice(0, root.start) + apply(root, patches) + text.slice(root.end);
    // Bound the composed result too, including depth added by a nested patch.
    parseText(result);
    return result;
}
/** Shallow canonical merge: absent unknown incoming keys preserve old values;
 * present incoming keys replace the whole value with its original text. Retain
 * fields keep the old representative when present. Only deleteMissing fields
 * absent from incoming are removed. No recursive unknown-field merge is implied. */
function mergeJsonObjectText(before, incoming, options) {
    const old = parseText(before), next = parseText(incoming);
    if (!old.members || !next.members)
        throw new Error('json_patch_object_required');
    const oldKeys = new Set(old.members.map(member => member.key));
    const nextKeys = new Set(next.members.map(member => member.key));
    const patches = next.members.filter(member => !options.retain.includes(member.key) || !oldKeys.has(member.key))
        .map(member => ({ path: [member.key], value: incoming.slice(member.value.start, member.value.end) }));
    for (const key of options.deleteMissing)
        if (oldKeys.has(key) && !nextKeys.has(key))
            patches.push({ path: [key] });
    return patchJsonText(before, patches, patches.map(patch => patch.path));
}
export { patchJsonText, patchTopLevelJsonMemberText, mergeJsonObjectText, validateJsonObjectText };
