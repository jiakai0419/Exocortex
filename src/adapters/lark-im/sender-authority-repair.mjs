// @ts-check
import { personName, senderNameFromSource } from './sender-identity.mjs';

const HUMAN_AUTHORITIES = new Set(['contact', 'chat_member', 'self']);
const APP_AUTHORITIES = new Set(['application_api', 'chat_bot_app_id']);
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Shared enrollment/application predicate after the caller's exact record and
 * task admission gates. Native names never authorize an extra remote lookup.
 * @param {Record<string,any>|null|undefined} target @param {string} accountKey */
function senderNeedsAuthorityRepair(target, accountKey) {
  if (!target || !account(accountKey)) return false;
  const { canonical, raw, identity, namespace } = target;
  if (!canonical || !raw || !identity?.verified || identity.conflict
    || !['open_id', 'app_id'].includes(namespace) || identity.type !== namespace
    || !identity.id || canonical.sender_id !== identity.id
    || canonical.sender_id_type != null && canonical.sender_id_type !== namespace) return false;
  const native = raw.raw_api && typeof raw.raw_api === 'object' ? raw.raw_api : raw;
  if ([canonical.sender_name_state, raw.sender_name_state, raw.sender?.name_state,
    native.sender_name_state, native.sender?.name_state].includes('cleared')
    || canonical.sender_name_verification?.status === 'conflict'
    || [canonical.sender_name_account_key, canonical.chat_name_account_key,
      canonical.sender_name_verification?.account_key].some(value => value != null && value !== accountKey)) return false;
  if (senderNameFromSource(raw)) return false;
  const authority = canonical.sender_name_source === 'local_history'
    ? canonical.sender_name_authority_source : canonical.sender_name_source;
  return !(personName(canonical.sender_name, identity.identifiers)
    && (namespace === 'open_id' ? HUMAN_AUTHORITIES : APP_AUTHORITIES).has(authority)
    && canonical.sender_name_confidence === 'high'
    && canonical.sender_name_account_key === accountKey);
}

export { senderNeedsAuthorityRepair };
