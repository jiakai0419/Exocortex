INSERT INTO sync_scopes (id, source_id, name, description)
VALUES (
  'lark.im.unmuted_chat_hot',
  'lark.im',
  'unmuted_chat_hot',
  'Discovers recently active non-muted Lark chats without changing initial full discovery state.'
)
ON CONFLICT(id) DO UPDATE SET
  source_id = excluded.source_id,
  name = excluded.name,
  description = excluded.description,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
