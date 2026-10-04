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
  Local health           OK
  Background             Running
  Current work           Waiting · between background rounds

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

## syncing-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK
  Background             Running
  Current work           Syncing · conversation list review

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

## catching_up-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           CATCHING UP · message details remain to be retrieved
  Background             Running
  Current work           Syncing · other conversation messages

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled · 9 with no content checkpoint
  Conversation list      Initial discovery has more pages to retrieve
  Message sources        15 enabled · 9 without a successful sync
  Message details        6 pending · 2 due for retry · 3 sources
  Restricted chats       5 excluded · 3 access restricted · 2 not a conversation
                         member
  Remote sample          Not verified · no cached remote sample
```

## empty-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · initial discovery or successful sync
                         evidence is missing
  Background             Running · cannot confirm it serves this database
  Current work           Unconfirmed · no current background phase could be
                         verified

Messages & progress
  Stored messages        0 total · 0 sent · 0 received
  Received chats         0 enabled
  Conversation list      Initial discovery not yet established
  Message sources        1 enabled · 1 without a successful sync
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

## foreground_stopped-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · background service is stopped
  Background             Stopped (service not loaded)
  Current work           Syncing · foreground command

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

## old_history-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           OK
  Background             Running · cannot confirm it serves this database
  Current work           Unconfirmed · no current background phase could be
                         verified

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Message details        0 pending
  Remote sample          Not verified · no cached remote sample
```

## failed-detail-80.txt

```text
Exocortex status
Observed Today 12:00:00 · UTC

Health & current work
  Local health           NEEDS ATTENTION · failed syncs recorded without a
                         successful sync
  Background             Running · selected database verified
  Current work           Waiting · between background rounds
  Phase observed         Today 11:59:50 · evidence valid until Today 12:00:20

Messages & progress
  Stored messages        293 total · 54 sent · 232 received · 7 unclassified
  Received chats         14 enabled
  Conversation list      Initial discovery complete · Today 09:00:00
  Message sources        15 enabled · 0 without a successful sync
  Message details        0 pending · 0 due for retry · 0 sources
  Restricted chats       0 excluded
  Active chat refresh    Last success Today 11:59:15
  Chat list review       Complete · Today 11:45:00
  Remote sample          Not verified · no cached remote sample

Problems
  Sync reservations      future start time x1, expired x1
  Database failures      15 retained failed runs · started in last 24h
  Failure window         2032-02-03 12:00–2032-02-04 12:00
  Failure category       Permission denied · 5
  Failure category       Network timeout · 4
  Failure category       Rate limited · 3
  Failure category       Service unavailable · 2
  Failure category       Unclassified failure · 1

Background history
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

Diagnostics
  Service config         Installed
  Service last exit      0
  Activity evidence      Verified background process, database and phase
  Sync reservations      2 total · 1 occupied · 2 abnormal
  Reservation issues     future start time x1, expired x1
  Message lists          15 recorded sources · oldest list checkpoint Today
                         11:50:00
  Content checkpoints    0 enabled received chats without a content checkpoint
  Detail retry sources   0
  Retained sync runs     15 failed
  Coverage boundary      List positions and content checkpoints do not
                         independently verify all remote content through a
                         target time.
  Command targets        All suggestions require the same --db and --log-dir
                         values as this status invocation.
  Inspect further        npm run exo -- check · npm run exo -- status --detail ·
                         npm run exo -- status --format json · npm run exo --
                         status --logs (private)
  Remote check           npm run exo -- check --live takes a new sample; add
                         --write-live-cache to update the status cache.
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
    Running
  Current work
    Syncing · other conversation
    messages

Messages & progress
  Stored messages
    293 total · 54 sent · 232 received ·
    7 unclassified
  Received chats
    14 enabled · 9 with no content
    checkpoint
  Conversation list
    Initial discovery has more pages to
    retrieve
  Message sources
    15 enabled · 9 without a successful
    sync
  Message details
    6 pending · 2 due for retry · 3
    sources
  Restricted chats
    5 excluded · 3 access restricted · 2
    not a conversation member
  Remote sample
    Not verified · no cached remote
    sample
```
