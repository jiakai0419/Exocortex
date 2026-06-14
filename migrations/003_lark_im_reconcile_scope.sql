INSERT INTO sync_scopes (id, source_id, name, description)
VALUES (
  'lark.im.unmuted_chat_reconcile',
  'lark.im',
  'unmuted_chat_reconcile',
  'Periodically reconciles the full non-muted Lark chat set after initial discovery is complete.'
)
ON CONFLICT(id) DO UPDATE SET
  source_id = excluded.source_id,
  name = excluded.name,
  description = excluded.description,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
