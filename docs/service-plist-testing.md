# Service plist serialization contract

The service configuration object and the XML installed for launchd must describe
the same persistent worker configuration. `RunAtLoad` and `KeepAlive` are booleans
set to `true`, `Umask` is the integer `63`, and the node/worker paths and persistent
arguments survive XML serialization without alteration. XML metacharacters in
paths and option values must round-trip exactly. Foreground lifetime flags
(`--once`, `--max-cycles`) must not enter the service configuration.

`tests/service-plist-roundtrip.test.mjs` checks this boundary with the real macOS
`/usr/bin/plutil`, using the same JSON conversion arguments as the installed
configuration reader. It also reads a newly generated plist through
`readInstalledServiceConfig`. Every file is created beneath a temporary synthetic
home; the test never invokes launchctl, installs a service, reads the user's
LaunchAgents, or starts a worker or Lark command.

The existing lifecycle fixtures continue to model service state transitions.
Their plutil substitute returns an object without decoding the generated XML,
so those fixtures alone cannot validate serialization. The system-parser test
must fail, rather than skip or substitute a parser, when the supported macOS CI
environment lacks the required plutil capability. See
[Development](development.md#macos-ci) for the supported CI platform and the
remaining real-service acceptance boundary.

A regression that emits `<false/>` for both boolean service keys must fail the
round-trip assertions even though the XML is syntactically valid. The unchanged
serializer must pass for ordinary settings and independently invented paths and
values containing XML metacharacters. Mutation validation is performed only in
an isolated source copy and is not part of normal service execution.
