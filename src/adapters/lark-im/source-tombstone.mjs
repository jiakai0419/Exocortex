// @ts-check
/** A tombstone is an explicit retained source fact, not an inferred operator. */
export const SOURCE_TOMBSTONE_TEXT = '[已撤回/已删除]';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Read only an explicit data property; decoded source JSON has no accessors.
 * @param {unknown} value @param {string} key */
const ownValue = (value, key) => object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

/** Ordinary legacy wrappers remain supported. A truthy string, inherited flag
 * or non-object native wrapper cannot establish a source tombstone.
 * @param {unknown} canonical @param {unknown} raw */
export function isSourceTombstone(canonical, raw) {
  const native = ownValue(raw, 'raw_api');
  return ownValue(canonical, 'deleted') === true || ownValue(raw, 'deleted') === true
    || ownValue(native, 'deleted') === true;
}
