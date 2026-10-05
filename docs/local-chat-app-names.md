# Local chat application names

`messages` can fill an unknown application sender name from a private local
mapping. It changes the reading projection only: no API calls, synchronization,
database writes, or worker configuration changes are involved. The same mapping
can apply to later messages in the exact same scope when they are read.

## Scope and evidence

The mapping must match the selected database file and the original message's
tenant, chat and explicitly typed application identity. The stored actor,
container, canonical identity and scope configuration must agree wherever they
provide identity values. An application-like prefix alone is not identity proof.
Different databases, tenants, chats, applications and user senders do not match.
The database binding identifies a local file; it does not verify an authenticated
account or establish a global bot identity.

Existing source or canonical names take precedence. An explicit cleared name is
also preserved. A mapping supplies a missing display name, not an application API
result. Matching messages gain `display.sender_name_source` with local mapping
kind, evidence kind, recording time and evidence references. Other messages keep
their existing JSON shape. Text output gains no extra rows. Raw, canonical,
stored body, hashes, source versions, search behavior and quality checks remain
unchanged.

## Private configuration

The file is `<canonical database path>.chat-app-names.json`, next to the selected
database after resolving its path. The directory and file stay local; never put
real identities, names or evidence references in Git or shared fixtures. The
dedicated filename is ignored by Git. Use a regular file owned by the current
user with private `0600` permissions, without symbolic or hard links.

The example below is entirely invented. Its database key is a placeholder and
must be replaced with the selected local file's binding before use.

```json
{
  "kind": "lark_im_chat_app_names/v1",
  "context": {
    "database_key": "0000000000000000000000000000000000000000000000000000000000000000",
    "source_id": "lark.im"
  },
  "entries": [{
    "tenant_key": "synthetic_tenant",
    "chat_id": "oc_synthetic_observatory",
    "app_id": "cli_synthetic_reminder",
    "name": "Synthetic Reminder",
    "source": {
      "kind": "user_screenshot",
      "recorded_at": "2049-06-11T09:14:00.000Z",
      "evidence_refs": ["synthetic-screenshot-reference"]
    }
  }]
}
```

For an explicitly selected database, this local command prints only the binding
fields needed by `context`; it does not read message content or contact an API:

```sh
node --input-type=module -e '
import { liveProbeContext } from "./src/diagnostics/live-probe-cache.mjs";
const binding = liveProbeContext(process.argv[1]);
if (!binding) throw new Error("database binding unavailable");
const { database_key, source_id } = binding;
console.log(JSON.stringify({ database_key, source_id }, null, 2));
' "$EXO_DB_PATH"
```

Keep the complete file within 64 KiB and at most 100 entries. Each tenant/chat/app
tuple must be unique. Identity values and names are at most 128 characters; a
name must not be empty, an identity echo, or control-bearing text. Each source
has a canonical UTC timestamp and one to eight opaque evidence references of at
most 256 characters. Evidence references are recorded provenance, never fetched
or used to infer other identities.

The reader creates, repairs and chmods nothing. A missing file preserves normal
reading. An invalid, non-private, linked, oversized or mismatched file causes a
safe configuration error, with no private values dumped. Copying or replacing
the database invalidates its old file binding; review the intended scope before
recreating that binding. The database binding is checked around message reading.

There is no cache: removing an entry or the file revokes the mapping on the next
read. Removing a mapping does not undo or change any stored name because no name
was written to the database. This is a display repair for supported evidence,
not a new source of global application or contact identities.
