import assert from "node:assert/strict";
import fc from "fast-check";
import { parseCards, rng } from "../src/engine/cards.ts";
import { Category, categoryOf, evaluate } from "../src/engine/evaluator.ts";
import type { Faults } from "../src/engine/faults.ts";
import { checkState, checkStep } from "../src/engine/invariants.ts";
import { apply, newTable } from "../src/engine/table.ts";
import type { Command, TableEvent, TableState } from "../src/engine/types.ts";
import { parseLog } from "../src/server/file-store.ts";
import { CorruptLogError, MemoryLog, replay, SYSTEM, TableService } from "../src/server/service.ts";
import { simulate } from "../src/sim/simulation.ts";
import { act, CONFIG, dyingStore, play, restart, rig, run, service, slowStore, tick, whoActs } from "./helpers.ts";

export type Layer = "reference" | "property" | "protocol" | "concurrency" | "chaos" | "recovery";

export interface Check {
  id: string;
  layer: Layer;
  title: string;
  run(faults: Faults): Promise<void>;
}

const sitAll = (stacks: number[]): Command[] => stacks.map((buyIn, i) => ({ type: "sit", playerId: `p${i}`, seat: i, buyIn }));
const eventsOf = (svc: { log: { event: TableEvent }[] }) => svc.log.map((e) => e.event);
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// Two players seated and a hand dealt, and the command for the first action.
async function handInProgress(svc: TableService) {
  await svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
  await svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
  await svc.submit(SYSTEM, "s", { type: "start" });
  const h = svc.state.hand!;
  const actor = svc.state.seats[h.toAct!]!.playerId;
  const cmd: Command = { type: "act", playerId: actor, handId: h.id, turn: h.turn, action: { kind: "call" } };
  return { h, actor, cmd };
}


export const CHECKS: Check[] = [
  // Reference: hand-written expectations, only where they are beyond argument.
  {
    id: "hand-ranking",
    layer: "reference",
    title: "Textbook hand categories and kickers",
    async run() {
      const cat = (s: string) => categoryOf(evaluate(parseCards(s)));
      assert.equal(cat("As Ks Qs Js Ts 2d 3c"), Category.StraightFlush);
      assert.equal(cat("Ah 2d 3c 4s 5h 9d Kc"), Category.Straight);
      assert.equal(cat("Ah Ad As Kh Kd 2c 3c"), Category.FullHouse);
      assert.equal(cat("2h 7h 9h Jh Kh Ad Ac"), Category.Flush);
      assert.ok(evaluate(parseCards("Ah Ad Kc 7s 3d")) > evaluate(parseCards("Ah Ad Qc 7s 3d")), "kicker decides equal pairs");
      assert.ok(evaluate(parseCards("6h 2d 3c 4s 5h")) > evaluate(parseCards("Ah 2d 3c 4s 5h")), "six-high straight beats the wheel");
    },
  },
  {
    id: "heads-up-order",
    layer: "reference",
    title: "Heads-up, the button posts the small blind, acts first before the flop and last after it",
    async run(faults) {
      let s = run(newTable(CONFIG), [...sitAll([100, 100]), { type: "start" }], faults);
      const h = s.hand!;
      assert.equal(h.toAct, h.button, "button acts first preflop");
      assert.equal(h.players.find((p) => p.seat === h.button)!.bet, 1, "button posts the small blind");
      s = play(s, [(x) => act(x, whoActs(x), { kind: "call" }), (x) => act(x, whoActs(x), { kind: "check" })], faults);
      assert.equal(s.hand!.street, "flop");
      assert.notEqual(s.hand!.toAct, s.hand!.button, "big blind acts first after the flop");
    },
  },
  {
    id: "min-raise",
    layer: "reference",
    title: "Raises below the minimum are refused; a short all-in doesn't reopen the betting",
    async run(faults) {
      let s = run(newTable(CONFIG), [...sitAll([300, 300, 300]), { type: "start" }], faults);
      // UTG raises to 10 (a raise of 8). A re-raise to 14 is too small.
      s = play(s, [(x) => act(x, whoActs(x), { kind: "raise", to: 10 })], faults);
      const small = apply(s, act(s, whoActs(s), { kind: "raise", to: 14 }), faults);
      assert.equal(small.ok ? "accepted" : small.code, "raise_too_small");

      // Three players: A bets 20, B goes all-in for 25 (a short raise of 5), C calls.
      // A already acted and faced less than a full raise: call or fold only.
      s = run(newTable(CONFIG), sitAll([300, 300, 27]), faults);
      s = run(s, [{ type: "start" }], faults);
      s = play(s, [(x) => act(x, whoActs(x), { kind: "call" }), (x) => act(x, whoActs(x), { kind: "call" }), (x) => act(x, whoActs(x), { kind: "check" })], faults);
      const first = whoActs(s);
      s = play(s, [(x) => act(x, first, { kind: "raise", to: 20 })], faults);
      while (whoActs(s) !== first) {
        const p = s.hand!.players.find((q) => q.seat === s.hand!.toAct)!;
        const stack = s.seats[p.seat]!.stack;
        s = run(s, [act(s, whoActs(s), stack <= 25 ? { kind: "allin" } : { kind: "call" })], faults);
      }
      const reraise = apply(s, act(s, first, { kind: "raise", to: 60 }), faults);
      assert.equal(reraise.ok ? "accepted" : reraise.code, "cannot_raise");
    },
  },
  {
    id: "side-pots",
    layer: "reference",
    title: "Three all-ins of 50, 100 and 200 split into a main pot, a side pot and a returned bet",
    async run(faults) {
      let s = run(newTable(CONFIG), sitAll([50, 100, 200]), faults);
      s = run(s, [{ type: "start" }], faults);
      // p0 has the best hand, p1 the second best, p2 the worst.
      s = rig(s, { 0: "AhAd", 1: "KhKd", 2: "7c2s" }, "As Kc 9d 5h 3s");
      while (s.hand) s = run(s, [act(s, whoActs(s), { kind: "allin" })], faults);
      assert.deepEqual(
        s.seats.slice(0, 3).map((x) => x!.stack),
        [150, 100, 100],
        "p0 wins 3 x 50, p1 wins 2 x 50, p2 gets its uncalled 100 back",
      );
    },
  },
  {
    id: "odd-chip",
    layer: "reference",
    title: "A split pot of 5 goes 3 and 2, the odd chip to the first winner left of the button",
    async run(faults) {
      let s = run(newTable(CONFIG), [...sitAll([100, 100, 100]), { type: "start" }], faults);
      // Button p0 calls, small blind p1 folds, big blind p2 checks: pot 5.
      s = rig(s, { 0: "2c3d", 1: "4h5h", 2: "2d3c" }, "As Ks Qs Js Ts");
      s = play(s, [(x) => act(x, "p0", { kind: "call" }), (x) => act(x, "p1", { kind: "fold" }), (x) => act(x, "p2", { kind: "check" })], faults);
      while (s.hand) s = run(s, [act(s, whoActs(s), { kind: "check" })], faults);
      assert.deepEqual(s.seats.slice(0, 3).map((x) => x!.stack), [100, 99, 101]);
    },
  },

  // Property: any sequence of commands, legal or not, keeps the invariants.
  {
    id: "random-play",
    layer: "property",
    title: "Random command sequences never break an invariant (chips, seats, turns, pots)",
    async run(faults) {
      const step = fc.tuple(fc.nat(99), fc.nat(99), fc.nat(999));
      fc.assert(
        fc.property(fc.integer(), fc.array(step, { minLength: 50, maxLength: 400 }), (seed, steps) => {
          let s: TableState = newTable({ ...CONFIG, seed });
          for (const [a, b, c] of steps) {
            const cmd = randomCommand(s, a, b, c);
            const r = apply(s, cmd, faults);
            if (!r.ok) continue;
            const bad = [...checkState(r.state), ...checkStep(s, cmd, r.state, r.events)];
            if (bad.length) throw new Error(bad.join("; "));
            s = r.state;
          }
        }),
        { seed: 7, numRuns: 300 },
      );
    },
  },

  // Protocol: what the service promises to a client.
  {
    id: "retry-idempotent",
    layer: "protocol",
    title: "A retried command gets its first result and is applied once",
    async run(faults) {
      const { svc } = service(faults);
      const sit: Command = { type: "sit", playerId: "p1", seat: 0, buyIn: 100 };
      const first = await svc.submit("p1", "c1", sit);
      const again = await svc.submit("p1", "c1", sit);
      assert.deepEqual(again, first);
      assert.equal(eventsOf(svc).filter((e) => e.type === "PlayerSat").length, 1);
      const reused = await svc.submit("p1", "c1", { type: "leave", playerId: "p1" });
      assert.equal(reused.ok ? "accepted" : reused.code, "idempotency_conflict");
    },
  },
  {
    id: "resume-exact",
    layer: "protocol",
    title: "Resuming after event k sends exactly k+1 to the head, in order",
    async run(faults) {
      const { svc } = service(faults);
      await svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
      await svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
      await svc.submit(SYSTEM, "s", { type: "start" });
      for (const k of [0, 1, 3, svc.head - 1, svc.head]) {
        const got: number[] = [];
        svc.subscribe("p1", k, (e) => got.push(e.seq))();
        assert.deepEqual(got, Array.from({ length: svc.head - k }, (_, i) => k + 1 + i), `resume after ${k}`);
      }
    },
  },
  {
    id: "hole-cards-private",
    layer: "protocol",
    title: "Nobody receives another player's hole cards, spectators receive none",
    async run(faults) {
      const { svc } = service(faults);
      const seen: Record<string, TableEvent[]> = { p1: [], p2: [], watcher: [] };
      svc.subscribe("p1", 0, (e) => seen.p1.push(e.event));
      svc.subscribe("p2", 0, (e) => seen.p2.push(e.event));
      svc.subscribe(null, 0, (e) => seen.watcher.push(e.event));
      await svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
      await svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
      await svc.submit(SYSTEM, "s", { type: "start" });
      for (const [who, events] of Object.entries(seen)) {
        const visible = events.filter((e) => e.type === "HoleCards" && e.cards).map((e) => (e as { playerId: string }).playerId);
        assert.deepEqual(visible, who === "watcher" ? [] : [who], `${who} saw cards of ${visible}`);
      }
    },
  },
  {
    id: "stale-timer",
    layer: "protocol",
    title: "An action timer that fires after its turn was played does nothing",
    async run(faults) {
      const { svc, scheduler } = service(faults);
      await svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
      await svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
      await svc.submit(SYSTEM, "s", { type: "start" });
      const h = svc.state.hand!;
      const timers = scheduler.timers.length;
      const actor = svc.state.seats[h.toAct!]!.playerId;
      const res = await svc.submit(actor, "x", { type: "act", playerId: actor, handId: h.id, turn: h.turn, action: { kind: "call" } });
      assert.ok(res.ok);
      const before = svc.head;
      scheduler.timers[timers - 1].fn(); // the timer armed for the turn that was just played
      await new Promise((r) => setImmediate(r));
      assert.equal(svc.head, before, "the old timer changed the table");
    },
  },

  // Concurrency: commands that arrive while another one is being persisted.
  {
    id: "seat-race",
    layer: "concurrency",
    title: "Two players racing for the same seat: exactly one gets it",
    async run(faults) {
      const { svc } = service(faults, { store: slowStore });
      const [a, b] = await Promise.all([
        svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 3, buyIn: 100 }),
        svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 3, buyIn: 150 }),
      ]);
      assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
      assert.deepEqual(replay(CONFIG, svc.commits, faults).errors, []);
      assert.deepEqual(checkState(svc.state), []);
    },
  },
  {
    id: "action-vs-timeout",
    layer: "concurrency",
    title: "A player's action and their timeout landing together: exactly one is applied",
    async run(faults) {
      const { svc } = service(faults, { store: slowStore });
      await svc.submit("p1", "a", { type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
      await svc.submit("p2", "b", { type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
      await svc.submit(SYSTEM, "s", { type: "start" });
      const h = svc.state.hand!;
      const actor = svc.state.seats[h.toAct!]!.playerId;
      const results = await Promise.all([
        svc.submit(actor, "x", { type: "act", playerId: actor, handId: h.id, turn: h.turn, action: { kind: "call" } }),
        svc.submit(SYSTEM, `timeout:${h.id}:${h.turn}`, { type: "timeout", handId: h.id, turn: h.turn }),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1, "both were applied");
      const actions = eventsOf(svc).filter((e) => e.type === "ActionTaken" && e.turn === h.turn);
      assert.equal(actions.length, 1);
    },
  },

  // Chaos: whole games through a network that delays, reorders, duplicates and drops.
  {
    id: "chaos-games",
    layer: "chaos",
    title: "Games under latency, reordering, duplicates and disconnects: every client converges on the server's table",
    async run(faults) {
      const chaos = { latencyMs: 20, jitterMs: 80, duplicateRate: 0.1, disconnectEveryMs: 4000, reconnectAfterMs: 300 };
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
          const r = await simulate({ seed, chaos, hands: 12, faults });
          if (r.violations.length) throw new Error(`seed ${seed}: ${r.violations.slice(0, 3).join("; ")}`);
        }),
        { seed: 7, numRuns: 20 },
      );
    },
  },

  // Recovery: the server dies at any moment and a new one starts from the log.
  {
    id: "restore-exact",
    layer: "recovery",
    title: "Restoring from prefixes of a 400-command log rebuilds the same table, events, seq numbers and commits",
    async run(faults) {
      const disk = new MemoryLog();
      const { svc } = service(faults, { store: disk });
      const random = rng(3);
      const n = (k: number) => Math.floor(random() * k);
      const snapshots = [{ state: JSON.stringify(svc.state), head: 0 }];
      for (let i = 0; i < 400; i++) {
        const cmd = randomCommand(svc.state, n(100), n(100), n(1000));
        const from = cmd.type === "start" || cmd.type === "timeout" ? SYSTEM : cmd.playerId;
        const res = await svc.submit(from, `c${i}`, cmd);
        if (res.ok) snapshots.push({ state: JSON.stringify(svc.state), head: svc.head });
      }
      assert.ok(snapshots.length > 100, "the session should accept plenty of commands");
      const last = disk.records.length;
      for (const k of [...upTo(20), ...upTo(last).filter((k) => k % 9 === 0), last - 1, last]) {
        const { svc: restored } = restart(disk.records.slice(0, k), faults);
        assert.equal(JSON.stringify(restored.state), snapshots[k].state, `the table after ${k} commits`);
        assert.equal(restored.head, snapshots[k].head, `the head after ${k} commits`);
        assert.deepEqual(restored.log, svc.log.slice(0, snapshots[k].head), `the numbered events after ${k} commits`);
        assert.deepEqual(restored.commits, svc.commits.slice(0, k));
      }
    },
  },
  {
    id: "retry-after-restart",
    layer: "recovery",
    title: "A command applied before a crash and retried after it gets its original result and is applied once",
    async run(faults) {
      const disk = new MemoryLog();
      const { svc } = service(faults, { store: disk });
      const sit: Command = { type: "sit", playerId: "p1", seat: 0, buyIn: 100 };
      const first = await svc.submit("p1", "c1", sit);
      const taken = await svc.submit("p2", "c2", { type: "sit", playerId: "p2", seat: 0, buyIn: 100 });
      assert.equal(taken.ok ? "accepted" : taken.code, "seat_taken");
      const { svc: next } = restart(disk.records, faults);
      assert.deepEqual(await next.submit("p1", "c1", sit), first);
      assert.equal(eventsOf(next).filter((e) => e.type === "PlayerSat").length, 1);
      const reused = await next.submit("p1", "c1", { type: "leave", playerId: "p1" });
      assert.equal(reused.ok ? "accepted" : reused.code, "idempotency_conflict");
      // Rejections are not logged: a retry is decided again, on the same table.
      const again = await next.submit("p2", "c2", { type: "sit", playerId: "p2", seat: 0, buyIn: 100 });
      assert.equal(again.ok ? "accepted" : again.code, "seat_taken");
    },
  },
  {
    id: "crash-before-publish",
    layer: "recovery",
    title: "A crash after a commit reached the disk but before it was published: on resume each event arrives exactly once",
    async run(faults) {
      const disk = new MemoryLog();
      const dying = dyingStore(disk);
      const { svc } = service(faults, { store: dying.store });
      const seen: number[] = [];
      svc.subscribe("p1", 0, (e) => seen.push(e.seq));
      const { actor, cmd } = await handInProgress(svc);
      const head = disk.records.at(-1)!.commit.lastSeq;
      dying.die("after-write");
      void svc.submit(actor, "x", cmd);
      await tick();
      assert.equal(disk.records.length, 4, "the action should be on disk");
      const { svc: next } = restart(disk.records, faults);
      next.subscribe("p1", seen.at(-1)!, (e) => seen.push(e.seq));
      assert.ok(next.head > head, "the restored table is missing the action");
      assert.deepEqual(seen, upTo(next.head), "p1 should see every event once, in order");
      const retry = await next.submit(actor, "x", cmd);
      assert.deepEqual(retry, { ok: true, firstSeq: head + 1, lastSeq: disk.records[3].commit.lastSeq }, "the retry should get the original result");
      assert.equal(next.head, seen.length, "the retry was applied again");
    },
  },
  {
    id: "crash-before-persist",
    layer: "recovery",
    title: "A crash while a command is being persisted: no client saw its events, and its retry is applied once",
    async run(faults) {
      const disk = new MemoryLog();
      const dying = dyingStore(disk);
      const { svc } = service(faults, { store: dying.store });
      const seen: number[] = [];
      svc.subscribe("p1", 0, (e) => seen.push(e.seq));
      const { h, actor, cmd } = await handInProgress(svc);
      dying.die("before-write");
      void svc.submit(actor, "x", cmd);
      await tick();
      const { svc: next } = restart(disk.records, faults);
      assert.ok(seen.at(-1)! <= next.head, `p1 saw event ${seen.at(-1)}, the restored table ends at ${next.head}`);
      next.subscribe("p1", seen.at(-1)!, (e) => seen.push(e.seq));
      const retry = await next.submit(actor, "x", cmd);
      assert.ok(retry.ok, "the retry should be applied");
      assert.deepEqual(seen, upTo(next.head));
      assert.equal(eventsOf(next).filter((e) => e.type === "ActionTaken" && e.handId === h.id && e.turn === h.turn).length, 1);
    },
  },
  {
    id: "restart-rearms-timers",
    layer: "recovery",
    title: "After a crash mid-hand the player to act still times out, and after a crash between hands the next hand is dealt",
    async run(faults) {
      const disk = new MemoryLog();
      const { svc } = service(faults, { store: disk });
      const { h } = await handInProgress(svc);
      const first = restart(disk.records, faults, { store: disk });
      for (const t of first.scheduler.timers.splice(0)) t.fn();
      await tick();
      const timedOut = eventsOf(first.svc).some((e) => e.type === "ActionTaken" && e.handId === h.id && e.turn === h.turn && e.timeout);
      assert.ok(timedOut, "nobody timed out the player to act");
      assert.equal(first.svc.state.hand, null, "heads-up, a timed-out small blind folds and the hand ends");
      const second = restart(disk.records, faults);
      for (const t of second.scheduler.timers.splice(0)) t.fn();
      await tick();
      assert.equal(second.svc.state.hand?.id, h.id + 1, "the next hand was not dealt");
    },
  },
  {
    id: "corrupt-log-refused",
    layer: "recovery",
    title: "A restore refuses a log with a missing commit, an edited event or a forged sender, and drops only a torn last line",
    async run(faults) {
      const disk = new MemoryLog();
      const { svc } = service(faults, { store: disk });
      const { actor, cmd } = await handInProgress(svc);
      await svc.submit(actor, "x", cmd);
      const good = disk.records;
      assert.equal(restart(good, faults).svc.head, svc.head);
      const edit = (fn: (r: typeof good) => void) => {
        const r = structuredClone(good);
        fn(r);
        return r;
      };
      const bad = {
        "a missing commit": edit((r) => r.splice(1, 1)),
        "an edited event": edit((r) => void ((r[1].events[0] as { stack: number }).stack += 1)),
        "a forged sender": edit((r) => void (r[1].commit.from = "p1")),
        "shifted seq numbers": edit((r) => r.slice(2).forEach((x) => ((x.commit.firstSeq += 1), (x.commit.lastSeq += 1)))),
      };
      for (const [what, records] of Object.entries(bad)) assert.throws(() => restart(records, faults), CorruptLogError, `restored a log with ${what}`);

      const lines = [JSON.stringify({ config: CONFIG }), ...good.map((r) => JSON.stringify(r))];
      const text = lines.join("\n") + "\n";
      const torn = parseLog(text + lines[2].slice(0, 30));
      assert.equal(torn.records.length, good.length);
      assert.equal(torn.bytes, text.length);
      assert.ok(torn.torn);
      assert.equal(parseLog(text).torn, null);
      const middle = [...lines.slice(0, 2), lines[2].slice(0, 30), ...lines.slice(3)].join("\n") + "\n";
      assert.throws(() => parseLog(middle), CorruptLogError, "a torn line in the middle is corruption");
    },
  },
  {
    id: "crash-games",
    layer: "recovery",
    title: "Games with server crashes on top of the network chaos: every client converges and the log replays",
    async run(faults) {
      const chaos = { latencyMs: 20, jitterMs: 80, duplicateRate: 0.1, disconnectEveryMs: 4000, reconnectAfterMs: 300, crashEveryMs: 3000, restartAfterMs: 500 };
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
          const r = await simulate({ seed, chaos, hands: 12, faults });
          if (r.violations.length) throw new Error(`seed ${seed}: ${r.violations.slice(0, 3).join("; ")}`);
          if (r.crashes === 0) throw new Error(`seed ${seed}: the server never crashed`);
        }),
        { seed: 7, numRuns: 12 },
      );
    },
  },
];

// Turns three random numbers into a command that makes sense for the current
// state most of the time, and nonsense some of the time.
export function randomCommand(s: TableState, a: number, b: number, c: number): Command {
  const player = `p${b % 8}`;
  const h = s.hand;
  if (!h || a < 8) {
    if (a < 30) return { type: "sit", playerId: player, seat: b % s.config.seats, buyIn: 10 + (c % 300) };
    if (a < 40) return { type: "leave", playerId: player };
    return { type: "start" };
  }
  const actor = s.seats[h.toAct!]!.playerId;
  if (a < 12) return { type: "timeout", handId: h.id, turn: c % 20 === 0 ? h.turn - 1 : h.turn };
  if (a < 15) return { type: "act", playerId: player, handId: h.id, turn: h.turn, action: { kind: "call" } };
  const kinds = ["fold", "check", "call", "raise", "allin"] as const;
  const kind = kinds[b % 5];
  const action = kind === "raise" ? { kind, to: h.currentBet + (c % 60) } : { kind };
  return { type: "act", playerId: actor, handId: h.id, turn: h.turn, action };
}
