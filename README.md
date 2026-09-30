# Real-Time Testbed

A real-time poker table fails in ways a unit test rarely sees: a call that arrives twice, a phone that drops mid-hand and comes back a minute later, an action timer that fires in the same millisecond as the player's click. This repo builds a small No-Limit Hold'em table server and a test harness aimed at exactly those failures.

![CI](https://github.com/pedromorago/real-time-testbed/actions/workflows/ci.yml/badge.svg)

The table plays real hands (blinds, min-raise rules, short all-ins, side pots, split pots, showdowns) over WebSockets. The harness drives it with random players through a network that delays, reorders, duplicates and drops messages, then checks that every client ends up seeing exactly what the server has, that the log replays to the same table, and that no chip, card or command went missing. To check the checks, twelve deliberate bugs can be switched on, and each one has to be caught.

## The system under test

TypeScript on Node 22, one runtime dependency ([ws](https://github.com/websockets/ws)).

| Part | Role |
|---|---|
| `src/engine/table.ts` | The rules as a pure function: `apply(state, command)` rejects the command or returns the next state and the events that describe the change. No clock, no I/O; the deck is shuffled from a seed, so a command log replays to identical events. |
| `src/server/service.ts` | The single owner of a table. Deduplicates commands by (sender, command id), applies them one at a time through a queue, persists before publishing, arms action timers and serves each viewer a redacted, numbered event stream. |
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

`validation/checks.ts` holds 13 checks in five layers. Each one runs against the real code, and against each seeded bug.

| Layer | What it relies on | Checks |
|---|---|---|
| Reference | Hand-written outcomes that are beyond argument | Hand rankings; heads-up blind and action order; minimum raise and short all-ins; a three-way all-in split into main pot, side pot and returned bet; the odd chip of a split pot |
| Property | [fast-check](https://fast-check.dev/) generates command sequences, legal and not | 300 random sessions of up to 400 commands each keep every invariant |
| Protocol | The contract with the client | A retried command gets its first result and applies once; resuming after event k sends exactly k+1 onwards; hole cards reach only their owner; a timer that fires after its turn does nothing |
| Concurrency | Commands that land while another is being persisted | Two players racing for one seat; a player's action and their timeout arriving together |
| Chaos | Whole games through a hostile network | 20 generated seeds of 12 hands each, every client converging on the server's table |

`tests/websocket.test.ts` repeats the important guarantees over real sockets and real timers: the seat race, a client killed mid-hand that resumes and catches up, a command sent while offline and delivered once on reconnect, hole-card privacy on the wire, a player trying to act as someone else, and the log on disk replaying to the same events.

## The chaos simulator

`src/sim` plays games on a virtual clock. Every message between a client and the server goes through a link that adds latency and random jitter (so messages overtake each other), delivers some commands, events and results twice, and drops the whole connection now and then, losing everything in flight. Storage takes a random moment too, which opens the window where races live. Bots sit down, buy back in when they bust, play random but plausible actions and sometimes think for too long and get timed out.

The same seed gives the same run, message for message, so any failure fast-check finds comes with a seed that reproduces it.

After the games, the network calms down and the simulator checks:

1. No invariant broke at any point.
2. Replaying the command log from an empty table rebuilds the same events and the same final state.
3. Every client, the spectator included, has applied every event and sees exactly the table the server has.
4. No command was applied twice; every command has a result; every result tells the truth about whether the command was applied.
5. Nobody ever received another player's hole cards.
6. The game didn't stall.

```
$ npm run simulate -- --seed 5 --hands 100
100 hands, 3201 events, 1017 commands applied, 148 rejected, 89 timeouts, 395 reconnects, 373 s of virtual time
every client converged on the server's table; the log replays exactly
```

CI runs a 300-hand game with a new seed on every push.

## Testing the tests: seeded bugs

`src/engine/faults.ts` lists twelve bugs, each one a single flag read in one place. `npm run mutants` runs every check against every bug.

| Seeded bug | Caught by |
|---|---|
| Retried commands are executed again instead of returning the first result | retry-idempotent (protocol), chaos-games (chaos) |
| Commands are validated concurrently while an earlier one is still being persisted | seat-race (concurrency), action-vs-timeout (concurrency), chaos-games (chaos) |
| Resume replays from the last event the client has, not the one after it | resume-exact (protocol) |
| Resume replays from two events after the client's last one | resume-exact (protocol), chaos-games (chaos) |
| An action timer fires on whatever turn is current, not the turn it was set for | stale-timer (protocol), action-vs-timeout (concurrency) |
| An all-in player can win chips above their own contribution level | side-pots (reference), random-play (property), chaos-games (chaos) |
| The odd chip of a split pot goes to nobody | odd-chip (reference), random-play (property), chaos-games (chaos) |
| Hole cards are sent unredacted to every connection | hole-cards-private (protocol), chaos-games (chaos) |
| Players with no chips are still dealt into the next hand | random-play (property), chaos-games (chaos) |
| Raises smaller than the minimum raise are accepted | min-raise (reference) |
| The client applies an event again when it arrives twice | chaos-games (chaos) |
| The client applies events in arrival order, not sequence order | chaos-games (chaos) |

All twelve are caught and the real code passes every check. What the table says:

- **One layer can hide another's bug.** When the server resends one event too many on resume, the client's deduplication quietly absorbs it, so whole games look perfect. Only the protocol check, which holds the server to its own contract, sees it. The bug would surface the day a different client (a mobile app, a bot, a partner integration) trusts the server to get it right.
- **Invariants keep the state sane; they don't know the rules.** Accepting a raise below the minimum breaks no invariant: chips are still conserved and the turn still moves on. The random sessions generate plenty of small raises and never notice. Only a reference case written from the rules catches it. The side-pot bug is the opposite: chips are conserved, but the cap on what a player can win exposes it.
- **Races need a window.** With instant storage, validating commands concurrently never goes wrong. The concurrency checks use storage that takes a few milliseconds, and the simulator randomizes it, so the lost update actually happens.
- **Whole-game simulation is the widest net.** It catches nine of the twelve, including both client bugs that no single-message test reaches, but when it fails it says "the views diverged", and the focused checks say why.

The simulator also found two bugs of mine while I was building this, before any were seeded. The client didn't wake its owner after `welcome`, so on a quiet table the bots never sat down; the stall check caught it. And the server gave its automatic "start the next hand" command the id `start:<hand number>`: when a start failed because too few players were seated, the idempotency cache kept answering every later start with that same rejection, and the table froze for good after everyone busted and bought back in. Keying it to the log position fixed it.

## Running it

```bash
npm ci
npm test                                  # checks, seeded bugs, WebSocket tests
npm run mutants                           # the table above
npm run simulate -- --seed 5 --hands 100  # one chaos run, with stats
npm run serve                             # a table on ws://localhost:8080, logged to logs/
npm run replay -- logs/table-<seed>.jsonl # rebuild a logged session and compare
```

Node 22 or later.

## Limits

This is a testbed, so some things a production table needs are left out on purpose: one table in one process, no authentication (the player is whoever says hello), idempotency keys kept forever instead of expiring, no rake or antes, and play chips only.

## Next

- A multi-table tournament: blind levels, table balancing and moving players between tables without losing an event.
- Crash recovery: kill the server mid-hand, rebuild the table from the log on start, and have clients resume as if it were a reconnect.
- Load: many tables and many clients at once, with latency percentiles and the same convergence checks.

## License

MIT
