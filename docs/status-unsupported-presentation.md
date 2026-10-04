# Service status presentation

`status` keeps unsupported scope information in the Sync key/value layout. A single reason shares the count row, for example `Unsupported scopes  4 · restricted_mode (access restricted)`. Multiple reasons appear as indented continuation rows with their individual counts. Nonempty numeric error codes remain visible as `code N`; empty CLI columns and the separate table are removed.

The unsupported-scope layout only changes the text view. Public JSON fields and reason grouping, synchronization behavior, and Activity are unchanged by this layout. Raw remote error messages are not shown. Synthetic regressions cover zero, single and multiple reasons, error-code retention, and terminal control sanitization.

## Compact time display

Service status declares the local IANA time zone once. `Recent cycles (up to 24h)` retains the existing bounded statistics, with a compact range such as `Today 03:11–07:26 · 4h15m`. Earlier days include their date once; ranges crossing midnight include both dates and years. Elapsed range duration is shown in whole minutes, or `<1m` for a shorter positive range. Truncated evidence adds only `log truncated`.

Other timestamps in this view use the same local context. Offsets appear only where a daylight-saving transition or repeated local hour would otherwise make an instant ambiguous. JSON timestamps, window bounds, and coverage evidence retain their existing values; only the Service text formatter changes.

Activity uses its additive `state` field when present, with the earlier `status` as a compatibility fallback. Its evidence rules are documented separately in [Activity evidence](activity-evidence.md).

The Activity line retains a fixed public explanation, for example `SYNCING · independent foreground sync observed`, `SYNCING · worker sync observed · step`, or `UNKNOWN · current phase evidence is incomplete`. JSON preserves the corresponding finite source, evidence, phase and reason categories. Internal detail text and process identities are never copied into this explanation.
