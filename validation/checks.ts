import assert from "node:assert/strict";
import fc from "fast-check";
import { parseCards } from "../src/engine/cards.ts";
import { Category, categoryOf, evaluate } from "../src/engine/evaluator.ts";
import type { Faults } from "../src/engine/faults.ts";
import { checkState, checkStep } from "../src/engine/invariants.ts";
import { apply, newTable } from "../src/engine/table.ts";
import type { Command, TableEvent, TableState } from "../src/engine/types.ts";
import { replay, SYSTEM } from "../src/server/service.ts";
import { simulate } from "../src/sim/simulation.ts";
import { act, CONFIG, play, rig, run, service, slowStore, whoActs } from "./helpers.ts";

export type Layer = "reference" | "property" | "protocol" | "concurrency" | "chaos";

export interface Check {
  id: string;
  layer: Layer;
  title: string;
  run(faults: Faults): Promise<void>;
}

const sitAll = (stacks: number[]): Command[] => stacks.map((buyIn, i) => ({ type: "sit", playerId: `p${i}`, seat: i, buyIn }));
const eventsOf = (svc: { log: { event: TableEvent }[] }) => svc.log.map((e) => e.event);

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
