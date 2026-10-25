// @ts-check
import { validateJsonObjectText } from '../../../dist/core/json-text-patch.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function chatNameCleared(canonical,raw) {
  const native=object(raw?.raw_api)?raw.raw_api:raw;
  return [canonical,raw,raw?.chat,native,native?.chat].some(value=>value?.chat_name_state==='cleared');
}
/** A title is display text, never an identity or an authoritative clear. */
function chatTitle(value, chatId) {
  return typeof value === 'string' && value.trim() && value.trim() !== chatId
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
}
/** Every explicit identity must agree before borrowing another local source. */
function titleMessageMatches(row, canonical, raw) {
  if (!row.container_id || !row.external_id || row.record_type !== 'lark.im.message'
    || row.source_id != null && row.source_id !== 'lark.im') return false;
  for (const text of [row.canonical_json, row.raw_json]) {
    if (typeof text === 'string') { try { validateJsonObjectText(text); } catch { return false; } }
  }
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  for (const value of [canonical, raw, native]) {
    if (!object(value) || value.message_id != null && value.message_id !== row.external_id) return false;
    for (const id of [value.chat_id, value.chat?.chat_id, value.chat?.id])
      if (id != null && id !== row.container_id) return false;
  }
  return [raw, native].every(value => value.id == null || value.id === row.external_id);
}
/** Ordinary cached scope names only fill a missing message title. */
function displayChatTitle(row, canonical, raw, config, currentChat, scopeSourceMatches, currentName) {
  const native = object(raw.raw_api) ? raw.raw_api : raw;
  try { if (typeof row.canonical_json === 'string') validateJsonObjectText(row.canonical_json); } catch { return ''; }
  if (canonical.chat_name_state === 'cleared') return '';
  const matches = titleMessageMatches(row, canonical, raw);
  if (matches && chatNameCleared(canonical,raw)) return '';
  const known = chatTitle(canonical.chat_name, row.container_id);
  const modes = [canonical, raw, raw.chat, native, native.chat, currentChat,
    scopeSourceMatches ? config : null].flatMap(value => [value?.chat_type,value?.chat_mode]);
  const conflict = modes.includes('p2p') && modes.some(mode => ['group','topic'].includes(mode));
  // Only a separately validated, account-bound current API observation may
  // replace an already adopted title. Scope timestamps are not title clocks.
  if (matches && currentChat !== null && currentChat?.chat_name_state!=='cleared' && !conflict && !modes.includes('p2p') && currentName
    && currentName.chat_id === row.container_id && chatTitle(currentName.name,row.container_id)
    && !(Date.parse(canonical.chat_name_observed_at) > Date.parse(currentName.observed_at))) return currentName.name;
  // The existing message's own display is independent of newly borrowed
  // metadata. A failed new identity proof must not erase that adopted value.
  if (known) return known;
  if (!matches) return '';
  const original = [raw.chat_name,raw.chat?.name,native.chat_name,native.chat?.name]
    .map(value => chatTitle(value,row.container_id)).find(Boolean);
  if (original) return original;
  if (currentChat === null) return '';
  try { if (typeof row.scope_config_json === 'string') validateJsonObjectText(row.scope_config_json); }
  catch { scopeSourceMatches = false; }
  if (conflict) return '';
  for (const scope of [currentChat, scopeSourceMatches ? config : null]) {
    if (!object(scope) || scope.chat_id !== row.container_id || scope.chat_name_state === 'cleared') continue;
    const name = chatTitle(scope.chat_name, row.container_id);
    if (name) return name;
  }
  return '';
}
export { chatTitle, chatNameCleared, titleMessageMatches, displayChatTitle };
