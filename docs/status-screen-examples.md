# Synthetic status screens

Generated only from invented fixtures, in UTC. Reproduce with:

```sh
TZ=UTC node tests/helpers/render-status-examples.mjs /tmp/status-examples
```

## healthy-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK · local sync checks only
  Background             Running · selected database verified
  Current work           Waiting · background service is between rounds

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled · 0 awaiting a full-content cursor
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        0 pending · 0 due for retry
  Conversation lists     Initial list and review complete
  Remote sample          Not verified · no cached remote sample

Attention
  Action                 No required action identified in the available local
                         evidence
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             24h lookback · partial window · events Today
                         10:00–11:59
  History scope          Worker log; not verified for the selected database
  Completed rounds       4 succeeded · 0 failed · 4 total
  Latest success         Succeeded · Today 11:59:25 (35s ago)
  Failed tasks           0 in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## syncing-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK · local sync checks only
  Background             Running · selected database verified
  Current work           Syncing · conversation list review

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled · 0 awaiting a full-content cursor
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        0 pending · 0 due for retry
  Conversation lists     Initial list and review complete
  Remote sample          Not verified · no cached remote sample

Attention
  Action                 No required action identified in the available local
                         evidence
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             24h lookback · partial window · events Today
                         10:00–11:59
  History scope          Worker log; not verified for the selected database
  Completed rounds       4 succeeded · 0 failed · 4 total
  Latest success         Succeeded · Today 11:59:25 (35s ago)
  Failed tasks           0 in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## catching_up-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           CATCHING UP · message details remain to be retrieved
  Background             Running · selected database verified
  Current work           Syncing · other conversation messages

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Conversation list      Initial discovery has more pages to retrieve
  Received chats         14 enabled · 9 awaiting a full-content cursor
  Message sources        15 enabled · 9 without a successful sync
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        6 pending · 2 due for retry
  Restricted chats       5
  Restriction            3 · access restricted · code 71101
  Restriction            2 · bot or user is outside the conversation · code
                         71102
  Remote sample          Not verified · no cached remote sample

Attention
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Coverage limits        Restricted chats excluded; check access if needed.
  Content backlog        6 message details still need retrieval. List progress
                         does not prove full content.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             24h lookback · partial window · events Today
                         10:00–11:59
  History scope          Worker log; not verified for the selected database
  Completed rounds       4 succeeded · 0 failed · 4 total
  Latest success         Succeeded · Today 11:59:25 (35s ago)
  Failed tasks           0 in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## empty-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · initial discovery or successful sync
                         evidence is missing
  Background             Running · selected database association unverified
  Current work           Unconfirmed · no current background phase could be
                         verified

Coverage
  Stored messages        0 total · 0 sent · 0 received
  Conversation list      Initial discovery not yet established
  Received chats         0 enabled · 0 awaiting a full-content cursor
  Message sources        1 enabled · 1 without a successful sync
  Message lists          0 sources · no list cursor recorded
  Message details        0 pending · 0 due for retry
  Remote sample          Not verified · no cached remote sample

Attention
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Local checks           npm run exo -- check for supporting evidence.
  Activity evidence      Recheck; inspect with npm run exo -- status --detail.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             No events in the requested window
  History scope          Worker log; not verified for the selected database
  Completed rounds       0 succeeded · 0 failed · 0 total observed
  Latest round           No round completion recorded in retained log
  Failed tasks           No task evidence in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## foreground_stopped-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · background service is stopped
  Background             Stopped (service not loaded)
  Current work           Syncing · verified foreground command

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled · 0 awaiting a full-content cursor
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        0 pending · 0 due for retry
  Conversation lists     Initial list and review complete
  Remote sample          Not verified · no cached remote sample

Attention
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Local checks           npm run exo -- check for supporting evidence.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             24h lookback · partial window · events Today
                         10:00–11:59
  History scope          Worker log; not verified for the selected database
  Completed rounds       4 succeeded · 0 failed · 4 total
  Latest success         Succeeded · Today 11:59:25 (35s ago)
  Failed tasks           0 in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## old_history-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK · local sync checks only
  Background             Running · selected database association unverified
  Current work           Unconfirmed · no current background phase could be
                         verified

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled · 0 awaiting a full-content cursor
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        0 pending · 0 due for retry
  Conversation lists     Initial list and review complete
  Remote sample          Not verified · no cached remote sample

Attention
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Activity evidence      Recheck; inspect with npm run exo -- status --detail.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  Worker log             No events in the requested window
  History scope          Worker log; not verified for the selected database
  Completed rounds       0 succeeded · 0 failed · 0 total observed
  Latest success         Succeeded · 2032-02-02 12:00:00 (2d ago)
  Failed tasks           No task evidence in the log window
  Database failures      0 retained failed runs · last 24h by start time
```

## failed-detail-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · latest logged background round failed
  Background             Running · selected database verified
  Current work           Waiting · background service is between rounds
  Phase observed         Today 11:59:50 · evidence valid until Today 12:00:20

Coverage
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Conversation list      Initial discovery complete · Today 09:00:00
  Received chats         14 enabled · 0 awaiting a full-content cursor
  Message sources        15 enabled · 0 without a successful sync
  Message lists          15 sources · oldest list checkpoint Today 11:50:00
  Message details        0 pending · 0 due for retry
  Restricted chats       0
  Active chat refresh    Last success Today 11:59:15
  Chat list review       Complete · Today 11:45:00
  Remote sample          Not verified · no cached remote sample

Attention
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Local checks           npm run exo -- check for supporting evidence.
  Sync reservations      future start time x1, expired x1; inspect npm run exo
                         -- status --detail and the system clock.
  Logged failure         Latest recorded background round failed; inspect the
                         history below and npm run exo -- check.
  Optional sample        npm run exo -- check --live for a new remote sample.

Recent history
  History source         Retained worker log; database association is not
                         verified
  Worker window          24h lookback · 2032-02-03 12:00–2032-02-04 12:00
  Log coverage           Partial window; earlier observations unavailable
  Observed events        Today 10:00–11:59
  Completed rounds       3 succeeded · 1 failed · 4 total
  Latest round           Failed · Today 11:59:25 (35s ago)
  Latest success         Today 11:58:40 (1m 20s ago) · in log window
  Success spacing        Longest observed interval 1h57m55s
  Failed tasks           1 in the log window
  Failed task            Active conversation messages · 1
  Last logged failure    Active conversation messages · Today 11:59:24 (36s ago)
  Database failures      15 retained failed runs · last 24h by start time
  Database window        2032-02-03 12:00–2032-02-04 12:00
  Failure category       Permission denied · 5
  Failure category       Network timeout · 4
  Failure category       Rate limited · 3
  Failure category       Service unavailable · 2
  Failure category       Unclassified failure · 1

Diagnostics
  Service config         Installed
  Service last exit      0
  Activity evidence      Verified background process, database and phase
  Sync reservations      2 total · 1 occupied · 2 abnormal
  Reservation issues     future start time x1, expired x1
  Detail retry scopes    0
  Retained sync runs     26 succeeded · 15 failed
  Coverage boundary      Cursors and list progress describe local checkpoints;
                         they do not verify all remote content through a target
                         time.
  Inspect further        npm run exo -- check · npm run exo -- status --format
                         json · npm run exo -- status --logs (private)
```

## catching_up-40.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health
    CATCHING UP · message details remain
    to be retrieved
  Background
    Running · selected database verified
  Current work
    Syncing · other conversation
    messages

Coverage
  Stored messages
    293 total · 54 sent · 232 received ·
    7 unclassified
  Conversation list
    Initial discovery has more pages to
    retrieve
  Received chats
    14 enabled · 9 awaiting a
    full-content cursor
  Message sources
    15 enabled · 9 without a successful
    sync
  Message lists
    15 sources · oldest list checkpoint
    Today 11:50:00
  Message details
    6 pending · 2 due for retry
  Restricted chats
    5
  Restriction
    3 · access restricted · code 71101
  Restriction
    2 · bot or user is outside the
    conversation · code 71102
  Remote sample
    Not verified · no cached remote
    sample

Attention
  Command targets
    All suggestions require the same
    --db and --log-dir values as this
    status invocation.
  Coverage limits
    Restricted chats excluded; check
    access if needed.
  Content backlog
    6 message details still need
    retrieval. List progress does not
    prove full content.
  Optional sample
    npm run exo -- check --live for a
    new remote sample.

Recent history
  Worker log
    24h lookback · partial window ·
    events Today 10:00–11:59
  History scope
    Worker log; not verified for the
    selected database
  Completed rounds
    4 succeeded · 0 failed · 4 total
  Latest success
    Succeeded · Today 11:59:25 (35s ago)
  Failed tasks
    0 in the log window
  Database failures
    0 retained failed runs · last 24h by
    start time
```
