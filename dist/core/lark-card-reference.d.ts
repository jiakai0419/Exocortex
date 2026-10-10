/** Consumer namespaces are part of a card reference, not interchangeable ID
 * spellings. The renderer and source proof use the same dispatch policy while
 * supplying their own bounded reads and identity tables. */
declare const CARD_ID_NAMESPACES: readonly string[];
type CardReferenceBindings<T> = {
    read: (value: unknown, key: string) => unknown;
    id: (value: unknown) => string | null;
    typed: (namespace: string, id: string) => T | null | undefined;
    mention: (key: string) => T | null | undefined;
    native: (alias: string) => T | null | undefined;
    hasAttachment: boolean;
};
declare function resolveCardMention<T>(payload: unknown, bindings: CardReferenceBindings<T>): T | null;
/** Native node and XML references share this policy. The caller has already
 * validated/debited the exact ID; it must not be cleaned or charged twice. */
declare function resolveNativeCardReference<T>(native: string, bindings: CardReferenceBindings<T>): T | null;
export { CARD_ID_NAMESPACES, resolveCardMention, resolveNativeCardReference };
export type { CardReferenceBindings };
