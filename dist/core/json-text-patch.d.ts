type JsonTextPatch = {
    path: readonly string[];
    value?: string;
};
/** Validate all nested syntax/keys without converting any number. */
declare function validateJsonObjectText(text: string): void;
/** One owned root member, preserving separators as well as unknown value
 * tokens. Appending then removing that member restores the original bytes. */
declare function patchTopLevelJsonMemberText(text: string, key: string, value?: string): string;
/** A raw JSON value is supplied only for an owned path; omitted value deletes
 * that path. Missing intermediate objects are created for sets, not deletions.
 * Existing non-object intermediates are rejected instead of silently replaced.
 * Unedited value subtrees (including their whitespace) retain their exact bytes. */
declare function patchJsonText(text: string, patches: readonly JsonTextPatch[], allowedPaths: readonly (readonly string[])[]): string;
/** Shallow canonical merge: absent unknown incoming keys preserve old values;
 * present incoming keys replace the whole value with its original text. Retain
 * fields keep the old representative when present. Only deleteMissing fields
 * absent from incoming are removed. No recursive unknown-field merge is implied. */
declare function mergeJsonObjectText(before: string, incoming: string, options: {
    retain: readonly string[];
    deleteMissing: readonly string[];
}): string;
export { patchJsonText, patchTopLevelJsonMemberText, mergeJsonObjectText, validateJsonObjectText };
export type { JsonTextPatch };
