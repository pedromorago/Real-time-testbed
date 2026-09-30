# Real-Time Testbed

A real-time poker table fails in ways a unit test rarely sees: a call that arrives twice, a phone that drops mid-hand and comes back a minute later, an action timer that fires in the same millisecond as the player's click, a server that dies halfway through writing to its log. This repo builds a small No-Limit Hold'em table server and a test harness aimed at exactly those failures.

![CI](https://github.com/pedromorago/real-time-testbed/actions/workflows/ci.yml/badge.svg)

The table plays real hands (blinds, min-raise rules, short all-ins, side pots, split pots, showdowns) over WebSockets. The harness drives it with random players through a network that delays, reorders, duplicates and drops messages, kills the server at random moments and starts a new one from its log, then checks that every client ends up seeing exactly what the server has, that the log replays to the same table, and that no chip, card or command went missing. To check the checks, seventeen deliberate bugs can be switched on, and each one has to be caught.

## The system under test

TypeScript on Node 22, one runtime dependency ([ws](https://github.com/websockets/ws)).

| Part | Role |
|---|---|
| `src/engine/table.ts` | The rules as a pure function: `apply(state, command)` rejects the command or returns the next state and the events that describe the change. No clock, no I/O; the deck is shuffled from a seed, so a command log replays to identical events. |
| `src/server/service.ts` | The single owner of a table. Deduplicates commands by (sender, command id), applies them one at a time through a queue, persists before publishing, arms action timers and serves each viewer a redacted, numbered event stream. `TableService.restore` rebuilds one from its log after a crash. |
| `src/server/file-store.ts` | The log on disk, one JSON line per accepted command with its events. Written with a flush before the service publishes; read back on restart. |
| `src/server/gateway.ts`, `ws.ts` | One connection, independent of transport, and the WebSocket server on top of it. The player comes from the connection, never from the command. |
| `src/client/client.ts` | Keeps a local copy of the table from the events. Applies them strictly in sequence order, drops duplicates, buffers early arrivals, resumes from its last event on reconnect and re-sends commands that have no result yet under the same id. |

The protocol, one JSON message per frame:

| Direction | Message | Meaning |
|---|---|---|
| client → server | `hello {playerId, lastSeq}` | Who I am and the last event I applied |
| server → client | `welcome {head}` | Events after `lastSeq` follow, then live ones |
| client → server | `cmd {id, cmd}` | sit, leave or act, with a client-chosen id that makes retries safe |
| server → client | `event {seq, event}` | The table's log, numbered, hole cards redacted for everyone but their owner |
| server → client | `result {id, result}` | Accepted with the events it produced, or rejected with a reason |

Action commands carry the hand and the turn they were decided on. A decision made on a stale view (the turn timed out, the hand ended) is rejected instead of being applied to whatever is current.

## Crash recovery

The server can die at any moment, including mid-hand, while a command waits in the queue, and between writing a commit and publishing it. A new process restores the table from the log and clients carry on as after any reconnect: they say hello with the last event they applied, get everything after it, and re-send every command that has no result yet.

`TableService.restore(options, records)` does this:

- **Replays and verifies.** Every logged command goes back through the engine from an empty table. Each one must still be accepted, must come from a sender allowed to send it, must start at the seq right after the previous one, and must produce exactly the events it logged. Anything else throws `CorruptLogError` naming the record and the event, and `npm run serve` refuses to start. A log that disagrees with the engine is either damaged or was written by a different version of the rules, and a table built from it would hand out different chips than the players saw.
- **Rebuilds the event log with the same seq numbers,** so a client that says "I have up to 1,204" gets 1,205 onwards whichever process it talks to.
- **Rebuilds the idempotency cache** for every accepted command, with its original result. A command that was on disk when the server died, but whose result never reached the client, is re-sent by the client and answered "ok, events 1,205 to 1,207" without running again. For this to work the fingerprint that detects "same id, different command" is taken from the command as the server reads it (with the player taken from the connection), which is exactly what the log records.
- **Re-arms the timers.** If a hand was running, the player to act gets a fresh action timer; if not, the next hand is scheduled. Timer ids are derived from the table (hand and turn, or hand number and log position), so the re-armed timer is the same command the dead process would have sent.

Three choices worth stating:

- **Rejected commands are not logged, and a retry of one after a restart is decided again.** A rejection changes nothing, so the restored table is the same whether or not it happened. A client only re-sends commands it has no result for, so a retry after a restart means the rejection never reached it, and the new answer is the only one it will see. The engine is a pure function of the state: on an unchanged table the retry gets the same rejection. If the table has moved on, it can get a different answer (a `sit` rejected with `seat_taken` may succeed once the seat frees up), which is true of the table it was decided on and is applied once if it is accepted. Logging rejections would cost a write per rejection, and would only make that one retry get the old answer instead of a fresh one.
- **A torn last line is dropped.** A line only counts once its newline is on disk. Each line is written in one append and acknowledged only after it, so bytes after the last newline belong to a write nobody was told about: dropping them is the same as the crash landing a moment earlier. The torn bytes are cut off the file before the next append, so old and new lines never merge. A line that doesn't parse anywhere else in the file is corruption, and the server refuses to start.
- **A restored turn gets a full action timer.** The log has no clock, so the time the player already spent is unknown. Giving them the whole timer again is the generous side of the choice.

## Invariants

Checked after every accepted command, in every test and every simulation:

- Stacks are whole numbers and never negative.
- One player, one seat.
- Chips are conserved: stacks plus the pot equal everything bought in minus everything cashed out.
- A busted player is never dealt in and never acts.
- The turn belongs to someone who can act; streets and turns only move forward; no card is dealt twice.
- Nobody wins more from a hand than they could have lost to it: at most the sum over every player of what they put in, capped at the winner's own contribution.
- One command, at most one action.

## The checks

`validation/checks.ts` holds 20 checks in six layers. Each one runs against the real code, and against each seeded bug.

| Layer | What it relies on | Checks |
|---|---|---|
| Reference | Hand-written outcomes that are beyond argument | Hand rankings; heads-up blind and action order; minimum raise and short all-ins; a three-way all-in split into main pot, side pot and returned bet; the odd chip of a split pot |
| Property | [fast-check](https://fast-check.dev/) generates command sequences, legal and not | 300 random sessions of up to 400 commands each keep every invariant |
| Protocol | The contract with the client | A retried command gets its first result and applies once; resuming after event k sends exactly k+1 onwards; hole cards reach only their owner; a timer that fires after its turn does nothing |
| Concurrency | Commands that land while another is being persisted | Two players racing for one seat; a player's action and their timeout arriving together |
| Chaos | Whole games through a hostile network | 20 generated seeds of 12 hands each, every client converging on the server's table |
| Recovery | A server that dies and is restored from its log | Restoring from prefixes of a 400-command log rebuilds the same table, events, seqs and commits; a command applied before a crash and retried after it gets its original result and applies once; a crash between the disk and publishing delivers each event exactly once on resume; a crash before the disk leaves no client holding an event the new server lacks; a crash mid-hand still times out the player to act, and one between hands still deals the next; a log with a missing commit, an edited event, a forged sender or shifted seqs is refused, and only a torn last line is dropped; 12 seeds of 12 hands with crashes on top of the network chaos |

`tests/websocket.test.ts` repeats the important guarantees over real sockets and real timers: the seat race, a client killed mid-hand that resumes and catches up, a command sent while offline and delivered once on reconnect, hole-card privacy on the wire, a player trying to act as someone else, the log on disk replaying to the same events, and a server killed mid-hand and started again from its JSONL file on the same port, with the player to act answering while it is down and every client converging on the new server.

## The chaos simulator

`src/sim` plays games on a virtual clock. Every message between a client and the server goes through a link that adds latency and random jitter (so messages overtake each other), delivers some commands, events and results twice, and drops the whole connection now and then, losing everything in flight. Storage takes a random moment too, which opens the window where races live. Bots sit down, buy back in when they bust, play random but plausible actions and sometimes think for too long and get timed out.

The server crashes too. A crash throws away the whole process: the table, the command queue with whatever waited in it, the timers, and every connection, with the messages in flight on them. After a pause a new process restores the table from the log that outlives it, and the clients reconnect. A write has two moments, reaching the disk and being acknowledged, and half the crashes are aimed at one of three points of a write: the instant before it reaches the disk, on disk but not yet published, and published but not yet delivered. The rest strike at random. One write in ten is slow, as when a flush queues behind other I/O, which leaves time for a message to cross the network while a write is still in progress.

The same seed gives the same run, message for message, so any failure fast-check finds comes with a seed that reproduces it.

After the games, the network calms down and the simulator checks:

1. No invariant broke at any point, in any life of the server.
2. Replaying the command log from an empty table rebuilds the same events and the same final state, and the events on disk are exactly the events the server published.
3. Every client, the spectator included, has applied every event and sees exactly the table the server has.
4. No command was applied twice; every command has a result; every result tells the truth about whether the command was applied.
5. Nobody ever received another player's hole cards.
6. The game didn't stall.
7. Every restart accepted its log.

```
$ npm run simulate -- --seed 5 --hands 100
100 hands, 3175 events, 1020 commands applied, 141 rejected, 89 timeouts, 532 reconnects, 412 s of virtual time
24 server crashes, 22 mid-hand, 5 before a write reached the disk, 6 between the disk and publishing
every client converged on the server's table; the log replays exactly
```

CI runs two 300-hand games with a new seed on every push: one with a crash every 20 virtual seconds on average, and a crash storm with one every 2.

## Testing the tests: seeded bugs

`src/engine/faults.ts` lists seventeen bugs, each one a single flag read in one place. `npm run mutants` runs every check against every bug.

| Seeded bug | Caught by |
|---|---|
| Retried commands are executed again instead of returning the first result | retry-idempotent (protocol), chaos-games (chaos), retry-after-restart (recovery), crash-before-publish (recovery), crash-games (recovery) |
| Commands are validated concurrently while an earlier one is still being persisted | seat-race (concurrency), action-vs-timeout (concurrency), chaos-games (chaos), crash-games (recovery) |
| Resume replays from the last event the client has, not the one after it | resume-exact (protocol), crash-before-publish (recovery), crash-before-persist (recovery) |
| Resume replays from two events after the client's last one | resume-exact (protocol), chaos-games (chaos), crash-before-publish (recovery), crash-games (recovery) |
| An action timer fires on whatever turn is current, not the turn it was set for | stale-timer (protocol), action-vs-timeout (concurrency) |
| An all-in player can win chips above their own contribution level | side-pots (reference), random-play (property), chaos-games (chaos), crash-games (recovery) |
| The odd chip of a split pot goes to nobody | odd-chip (reference), random-play (property), chaos-games (chaos), crash-games (recovery) |
| Hole cards are sent unredacted to every connection | hole-cards-private (protocol), chaos-games (chaos), crash-games (recovery) |
| Players with no chips are still dealt into the next hand | random-play (property), chaos-games (chaos), crash-games (recovery) |
| Raises smaller than the minimum raise are accepted | min-raise (reference) |
| The client applies an event again when it arrives twice | chaos-games (chaos), crash-games (recovery) |
| The client applies events in arrival order, not sequence order | chaos-games (chaos), crash-games (recovery) |
| Events are published before they are persisted, so a crash can take back events clients already saw | crash-before-persist (recovery) |
| After a restart, commands applied before the crash are not remembered, so their retries run again | retry-after-restart (recovery), crash-before-publish (recovery), crash-games (recovery) |
| Restoring from the log leaves out the last commit | restore-exact (recovery), crash-before-publish (recovery), crash-before-persist (recovery), restart-rearms-timers (recovery), corrupt-log-refused (recovery), crash-games (recovery) |
| After a restart, the action timer and the next-hand start are not armed again | restart-rearms-timers (recovery), crash-games (recovery) |
| Restoring takes the logged events on trust instead of checking them against a replay of the commands | corrupt-log-refused (recovery) |

All seventeen are caught and the real code passes every check. What the table says:

- **One layer can hide another's bug.** When the server resends one event too many on resume, the client's deduplication quietly absorbs it, so whole games look perfect. Only the checks that hold the server to its own contract and count seqs exactly (the protocol check and two recovery checks) see it. The bug would surface the day a different client (a mobile app, a bot, a partner integration) trusts the server to get it right.
- **Invariants keep the state sane; they don't know the rules.** Accepting a raise below the minimum breaks no invariant: chips are still conserved and the turn still moves on. The random sessions generate plenty of small raises and never notice. Only a reference case written from the rules catches it. The side-pot bug is the opposite: chips are conserved, but the cap on what a player can win exposes it.
- **Races need a window.** With instant storage, validating commands concurrently never goes wrong. The concurrency checks use storage that takes a few milliseconds, and the simulator randomizes it, so the lost update actually happens.
- **Whole-game simulation is the widest net.** The two game checks catch twelve of the seventeen between them, including both client bugs that no single-message test reaches, but when they fail they say "the views diverged", and the focused checks say why.
- **A crash has to be able to land in the window.** In the first version of the crash simulator every write reached the disk within 20 ms and every message took at least 20 ms to cross the network, so an event published before its write could never reach a client before the write landed. Publishing before persisting passed every game I ran. Slow writes and crashes aimed at the instant before the disk now make it visible in some games (1 seed in 10 in a sweep I ran), and not in the 12 seeds the check runs. The focused check that crashes before the write catches it every time.
- **A missing cache shows up as a false answer.** With the idempotency cache not restored, the first symptom in each of ten crash games I looked at was "command was told stale_turn but was applied": a player's action made it to disk, the server died before answering, and the retry after the restart met a table where that turn was over. The engine's stale-turn guard stopped a double action, so the damage is a client told its action failed when it happened. A retried `sit` fails the same way, with `seat_taken` for a seat the player is sitting in.
- **Verification only matters for logs that went wrong.** Taking the log on trust passes every game, with or without crashes, because the server never writes a bad log. Only the check that damages a log on purpose tells a server that verifies from one that doesn't.

The simulator also found two bugs of mine while I was building this, before any were seeded. The client didn't wake its owner after `welcome`, so on a quiet table the bots never sat down; the stall check caught it. And the server gave its automatic "start the next hand" command the id `start:<hand number>`: when a start failed because too few players were seated, the idempotency cache kept answering every later start with that same rejection, and the table froze for good after everyone busted and bought back in. Keying it to the log position fixed it.

Adding the crash games found one more, while running them against a seeded bug. The seeded bug that deals busted players in can make the engine throw from inside a timer's command, and nothing handled the rejected promise; an unhandled rejection ends a Node process. With crash recovery that would become a crash loop, since the restored table re-arms the same timer for the same state. The service now catches an exception from the engine, records it as a violation and answers `internal_error`. The crash simulator found no bug in the recovery code itself: across 800 seeds of 12 hands, with crashes every 0.7 to 5 virtual seconds on average and restarts after 50 ms to 5 s, every game converged.

## Running it

```bash
npm ci
npm test                                  # checks, seeded bugs, WebSocket tests
npm run mutants                           # the table above
npm run simulate -- --seed 5 --hands 100  # one chaos run with server crashes, with stats
npm run simulate -- --seed 5 --hands 100 --crash 2000  # a crash every 2 virtual seconds; --crash 0 for none
npm run serve                             # a table on ws://localhost:8080, logged to logs/
LOG=logs/table-<seed>.jsonl npm run serve # restore that table from its log and carry on
npm run replay -- logs/table-<seed>.jsonl # rebuild a logged session and compare
```

Node 22 or later.

## Limits

This is a testbed, so some things a production table needs are left out on purpose: one table in one process, no authentication (the player is whoever says hello), idempotency keys kept forever instead of expiring, no rake or antes, and play chips only.

Recovery has limits of its own. A restart replays the whole log from the first command, with no snapshots, so start-up time grows with the log: the 300-hand crash storm with seed 5 restores 619 times and takes about 40 seconds of real time. The flush on every append asks the OS to write through to the disk; whether the disk then keeps it through a power cut is up to the hardware, and nothing here tests power loss. The simulated crash is a process that stops: its writes either land whole or not at all, and a torn line is only tested by parsing one.

## Next

- A multi-table tournament: blind levels, table balancing and moving players between tables without losing an event.
- Load: many tables and many clients at once, with latency percentiles and the same convergence checks.

## License

MIT
