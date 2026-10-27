# Synthetic worker-to-messages acceptance

This test follows the shared message-completeness v0.3 contract and the
independent latency acceptance draft. It covers a narrow normal-load path; it
does not sign off the full L01–L18 matrix, a production SLO, or deployment.

The fixture starts with an empty synthetic database, an explicitly admitted
group title/source baseline, a publisher manifest, and a fake Lark executable.
No message row or completed identity is manually inserted. The real worker
executes its ordinary sent/discovery/hot/fair/history steps through real guarded
child processes. A test-only command shim calls the real public CLI parser and
command, injecting only the fake executable, fixture-owned real flock/cooldown
directory, observation clock and an observational commit wrapper. The wrapper
calls the actual store commit before observing it. No worker result, adapter
message, name resolver or completed row is substituted.

First the publisher exposes 12 old application messages whose exact application
queries are denied, plus one human donor whose contact lookup succeeds. The
worker must actually collect this history. It then publishes two new messages
with no sender name in their raw payload: a hot actor with the exact local
contact evidence just acquired, and a cold actor whose exact contact response
is available immediately. Both use the existing known group title. One group,
two new messages, no detail debt and normal fake API responses form the explicit
capacity envelope. Existing four-call/ten-second optional name work and
60-second account admission are unchanged. The test passes no larger budget or
shorter admission override. The bootstrap ingestion resolver is a separate
existing path: its 13-message acquisition performs one contact lookup, one bot
list and 12 application lookups; the optional four-call tail is not a global
ceiling on those ingestion lookups. This test does not assert such a ceiling.

After each actual content commit, the test runs the real `messages` executable
in JSON and text modes. It compares typed actor, source version, body, group,
direction, exact authoritative name, and independent SQL latest-N membership.
Raw and JSON preserve the fixture's double-space body exactly; text preserves
the existing compact-whitespace display contract. Distinct eight-character
synthetic IDs allow exact text order checks despite existing ID abbreviation.
The first observed fresh rows must already be correct. The old failed messages
remain in the denominator. Hot local reuse must make zero name lookup calls
for that actor after publication. The actual fresh batch may make exactly one
name request, for the cold actor, and no known-title request. The cold actor must be looked up and readable
within a proposed 120-second synthetic end-to-end bound despite old failures.
Because a directly resolvable cold actor can complete in ingestion, this test
does not by itself prove fresh-queue priority after optional lookup exhaustion;
the coordinator's separate persistent scheduling tests own that counterexample.

The publisher records occurrence and upstream-available times independently of
collection. The fake epoch is shared by processes and advances only through
explicit worker idle events; real elapsed process time also advances it. Request
budgets retain actual monotonic elapsed I/O time, never a constant zero; the
existing maintenance test seam adds requested inter-request waits to that same
clock instead of sleeping. History review tickets and SQLite transaction fences
retain real wall time, since SQLite's clock is not advanced by worker idle
events. No source-to-read latency is derived from history ticket times.
Source/discovery/prepared-identity/commit/first JSON/first text observations are
recorded as a test-side oracle. Prepared identity is checked against the actual
record passed to the real commit. It is not a production readiness event.
Commit time is not borrowed from `records.updated_at`.
Observation brackets are the immediately preceding absent read and the first
complete read; they are reported directly, not advertised as fixed one-second
polling. The local commit-to-read proposal is two seconds; its actual monotonic
measurement includes both CLI subprocesses.

This is a deterministic scheduling experiment with real local I/O, not a real
wall-clock benchmark or a statistical p95 sample. Sleeping workers, upstream
delay, rate limits, multiple accounts, private recipients, complex cards and
crash recovery require the independent broader matrix. Production data,
credentials, shared production locks, service configuration and network access
are never used.

## Local result

`node --test tests/name-scheduling-worker.integration.test.mjs` passed on
2026-10-27 against the moving isolated latency candidate. One test runs two
complete real worker cycles (all seven steps, including real history), starting
with zero records. The first successful run observed both hot and cold at
58,209 ms from source publication: 0 ms upstream delay, 57,623 ms collection
wait, 314 ms preparation/observation, 67 ms commit and 205 ms to both actual CLI
reads. The preceding absent and first complete reads bound first visibility to
[57,936, 58,209] ms. These are per-sample synthetic scheduling measurements,
not statistical percentiles or a frozen-candidate acceptance signature.

The publisher denominator is 15 distinct message versions: two fresh complete
messages, one complete donor and 12 unresolved historical messages. The test
checks no omission in either format, retained unresolved history, fixture-only
flock ownership and contention, account binding, no leftover database locks,
and per-tail calls at most four. First visibility is observed immediately around
content commits; this is not the broader acceptance draft's one-second polling
experiment. Pending-queue priority, continuous-stream fairness, two-page name
continuation, failures/restarts and the remaining L01–L18 cases need the
coordinator's other tests and independent review of a frozen integrated tree.


## Combined candidate contract

The integrated test additionally asserts the shared `readiness` result on the
same actual JSON/text reads. Hot, cold and donor rows must be `ready` with their
exact authoritative names; all twelve unavailable applications must remain
selected with `enriching` and `sender_name_missing`. This is separate from a
mere nonempty label check. The integrated inline path also has its own two-batch
persisted-denial test: 26 messages and 24 exact route states, with zero repeated
requests to those isolated routes and unchanged route state after collection.
Its success does not imply that initial unknown failures have already been
persisted as terminal route failures.

The observation ledger samples current projection results after successful sync
opportunities. Its first-observed clocks are historical evidence, not exact
first source collection/readiness/publication milestones for this test oracle.
The pure latency helper and ledger do not manufacture missing production stage
times. Final verification uses the combined candidate, including the normal
worker and source-account producer wiring; earlier route-only timings above
remain historical validation notes.
