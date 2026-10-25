import { quoteSql } from '../../../dist/storage/sqlite/ingestion-store.js';
import { patchJsonText } from '../../../dist/core/json-text-patch.js';
import { createLarkImAdapter } from './adapter.mjs';
import { chatTitle, chatNameCleared, titleMessageMatches } from './chat-title.mjs';
import { readChatNameEvidence } from './name-evidence.mjs';
import { sentRecipientAccount } from './p2p-recipient.mjs';
import { nameRecordFence, NAME_REFRESH_MS, NAME_RETRY_MS } from './name-work-common.mjs';
import { readNameProjectionPage } from './name-projection-progress.mjs';

// Independent official observations do not create or enable collection scopes.
// A bounded name-only projection binds each exact message to that observation;
// a legacy sent actor never establishes ownership of unrelated received rows.
function prepareChatWork(task, { self, accountKey, nowMs, query, runLark }) {
  let evidence = readChatNameEvidence(task.evidence_json,task.chat_id,accountKey,nowMs);
  if (!evidence || nowMs-Date.parse(evidence.observed_at)>=NAME_REFRESH_MS) {
    const chat = createLarkImAdapter({ run: runLark }).fetchChatMetadata(task.chat_id);
    if (chat.chat_id !== task.chat_id || !['group','topic'].includes(chat.chat_type || '')
      || !chatTitle(chat.chat_name,task.chat_id)) return { outcome: 'unresolved', updates: [] };
    evidence = { schema: 'lark_current_chat_name/v1', source_id: 'lark.im', account_key: accountKey,
      chat_id: task.chat_id, chat_type: chat.chat_type, name: chat.chat_name,
      authority: 'im.chats.get', observed_at: new Date(nowMs).toISOString() };
  }
  const page = readNameProjectionPage(task, query, { index: 'records_name_chat', label: 'chat name projection',
    predicate: `source_id='lark.im' AND record_type='lark.im.message' AND container_id=${quoteSql(task.chat_id)}` });
  let capacity = page.capacityDeferred;
  const updates = [];
  for (const row of page.rows) {
    try {
      const canonical = JSON.parse(row.canonical_json || '{}'), raw = JSON.parse(row.raw_json);
      if (!titleMessageMatches(row,canonical,raw) || chatNameCleared(canonical,raw)
        || [canonical,raw,raw.chat,raw.raw_api,raw.raw_api?.chat].some(value => value?.chat_type === 'p2p' || value?.chat_mode === 'p2p')
        || canonical.chat_name_account_key && canonical.chat_name_account_key !== accountKey
        || canonical.sender_name_account_key && canonical.sender_name_account_key !== accountKey
        || canonical.sender_name_verification?.account_key && canonical.sender_name_verification.account_key !== accountKey
        || row.direction === 'sent' && sentRecipientAccount(row,canonical,raw) !== self.open_id) continue;
      const next = patchJsonText(row.canonical_json, [
        { path: ['chat_name_account_key'], value: JSON.stringify(accountKey) }
      ], [['chat_name_account_key']]);
      if (next !== row.canonical_json) updates.push(`UPDATE records SET canonical_json=${quoteSql(next)} WHERE id=${row.id} AND ${nameRecordFence(row)}`);
    } catch { capacity = true; /* Retain bounded debt without blocking later rows. */ }
  }
  return { outcome: page.more?'applying':capacity?'capacity_deferred':'resolved', evidenceJson: JSON.stringify(evidence),
    afterRecordId:page.after, horizonRecordId:page.horizon, projectionDeferred:capacity,
    retryDelayMs:page.more?0:capacity?NAME_RETRY_MS:NAME_REFRESH_MS,updates };
}
export { prepareChatWork };
