INSERT INTO sources (id, kind, display_name)
VALUES ('lark.im', 'lark', 'Lark Messages')
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  display_name = excluded.display_name,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

INSERT INTO sync_scopes (id, source_id, name, description)
VALUES
  (
    'lark.im.sent_by_me',
    'lark.im',
    'sent_by_me',
    'Messages authored by the current Lark user.'
  ),
  (
    'lark.im.unmuted_chat_discovery',
    'lark.im',
    'unmuted_chat_discovery',
    'Discovers current non-muted Lark chats and prepares per-chat received message scopes.'
  ),
  (
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
