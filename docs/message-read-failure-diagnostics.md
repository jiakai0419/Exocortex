# Finite message-read failure diagnostics

A failed SQLite subprocess must retain evidence from that same invocation.
A later successful read cannot reconstruct a discarded failure. When neither the
child result nor query stage was retained, the original cause remains unknown.

This change observes failures only. Queries, snapshots, ordering, rendering,
read-only access, output and time budgets, lock behavior and retry policy are
unchanged. There is no retry, database repair, additional query, default file
write or raw-error log. Successful messages JSON and terminal output remain
unchanged. The four existing public error reasons remain the command boundary.
A standalone process signal is not proof of a timeout: only `ETIMEDOUT` supports
`read_timeout`; `SIGKILL` alone now retains `read_failed` with `process_signal`.

## Failure evidence

Messages errors may include `read_diagnostic`, version 1, with an exact closed
schema. The command's text error prints the same finite evidence on a separate
line. A plain object with a matching error name cannot opt into this interface.
Unknown or invalid diagnostic fields cannot cross the CLI boundary.

- `stage`: `schema_query`, `snapshot_query`, `snapshot_validate` or `sqlite_query`.
  Only exact application-owned labels select the two query stages; the label
  itself never leaves the reader.
- `kind`: `dependency_unavailable`, `timeout`, `output_limit`, `spawn_error`,
  `process_exit`, `process_signal`, `invalid_json`, `invalid_shape` or `unknown`.
- `status`, `signal`, `spawn_code`: a finite process result; absent or unrecognized
  values are null. Output-limit and timeout codes take precedence over the
  termination signal used to enforce them.
- `sqlite_kind`: `busy`, `locked`, `schema_missing`, `schema_changed`, `syntax`,
  `corrupt`, `not_database`, `open_failed`, `io`, `full`, `readonly`, `interrupted`,
  `memory`, `size_limit` or `unknown`. Classification uses only the first bounded
  SQLite stderr line and fixed shell/error prefixes. It is diagnostic evidence,
  not permission, retry or data-integrity authority. An incomplete overlong first
  line is unknown. A numeric SQLite suffix must agree with the category's primary
  code; absent or malformed process exit evidence cannot establish a SQLite cause.
  SQLite defines that primary code as the low eight bits of its signed 32-bit
  [result code](https://www.sqlite.org/rescode.html).
- `elapsed_ms`, `timeout_ms`, `max_buffer_bytes`, `stdout_bytes`, `stderr_bytes`:
  nonnegative safe integers or null. Elapsed time uses the same call's monotonic
  observation; an unusable clock yields null and does not change execution.

No SQL, SQL hash, label, database or executable path, record identifiers, message
text, stdout/stderr excerpts, error message, stack, cause or arbitrary error
properties enter this structure. Byte lengths do not contain output bytes.
Snapshot validation errors distinguish the validation stage without claiming a
failed SQLite process. Existing callers constructing an error without execution
evidence do not acquire fabricated child results.

## Private acceptance evidence

When additional SQLite detail is needed for a bounded local investigation, an
explicit observer must capture the original child result before it is discarded.
Keep raw stderr only in the designated private local evidence directory, with
private permissions and a finite size cap; never put it in ordinary logs, Git,
CI fixtures or a shared artifact. Do not persist successful stdout merely to
diagnose failures. This operational observation is separate from the normal
read-only command and must not change arguments, results, clocks or budgets.

Synthetic gates cover schema and snapshot failures, spawn errors and thrown
spawns, timeout versus signal, output limits, canonical SQLite errors, malformed
JSON and snapshot envelopes, forged diagnostics, and private-looking sentinels
in every rejected raw field. Actual CLI JSON/text failures must expose the same
finite evidence, and healthy output/SQLite database bytes must remain unchanged.
