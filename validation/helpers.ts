import { parseCards } from "../src/engine/cards.ts";
import type { Faults } from "../src/engine/faults.ts";
import { apply } from "../src/engine/table.ts";
import type { Command, TableConfig, TableState } from "../src/engine/types.ts";
import type { LogRecord, MemoryLog, Store } from "../src/server/service.ts";
import { TableService } from "../src/server/service.ts";

export const CONFIG: TableConfig = { seats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 10, maxBuyIn: 1000, seed: 11 };

export function run(state: TableState, cmds: Command[], faults?: Faults): TableState {
  for (const cmd of cmds) {
    const r = apply(state, cmd, faults);
    if (!r.ok) throw new Error(`${cmd.type} rejected: ${r.code} ${r.message}`);
    state = r.state;
  }
  return state;
}

// Replaces the dealt cards of the running hand so a test can decide who wins.
// State is plain data, so this needs no hook in the engine.
export function rig(state: TableState, holes: Record<number, string>, board: string): TableState {
  const s = structuredClone(state);
  const h = s.hand!;
  const used = new Set<number>();
  for (const p of h.players) {
    p.hole = parseCards(holes[p.seat]);
    p.hole.forEach((c) => used.add(c));
  }
  const b = parseCards(board);
  b.forEach((c) => used.add(c));
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  h.deck = [...h.players.flatMap((p) => p.hole), ...b, ...rest];
  h.dealt = h.players.length * 2;
  return s;
}

export const act = (state: TableState, playerId: string, action: Extract<Command, { type: "act" }>["action"]): Command => ({
  type: "act",
  playerId,
  handId: state.hand!.id,
  turn: state.hand!.turn,
  action,
});

// Runs commands one at a time, re-reading the state before building each.
export function play(state: TableState, steps: ((s: TableState) => Command)[], faults?: Faults): TableState {
  for (const step of steps) state = run(state, [step(state)], faults);
  return state;
}

export const whoActs = (s: TableState) => s.seats[s.hand!.toAct!]!.playerId;

// A scheduler the test fires by hand.
export class ManualScheduler {
  timers: { at: number; fn: () => void }[] = [];
  t = 0;
  now = () => this.t;
  after = (ms: number, fn: () => void) => void this.timers.push({ at: this.t + ms, fn });
}

// Storage that takes a moment, which is where races live.
export const slowStore = { append: () => new Promise<void>((resolve) => setTimeout(resolve, 5)) };

export function service(faults: Faults, extra: Partial<ConstructorParameters<typeof TableService>[0]> = {}) {
  const scheduler = new ManualScheduler();
  const svc = new TableService({ config: CONFIG, faults, scheduler, actionTimeoutMs: 1000, audit: true, ...extra });
  return { svc, scheduler };
}

// A new process after a crash: a service restored from what reached the disk.
export function restart(records: LogRecord[], faults: Faults, extra: Partial<ConstructorParameters<typeof TableService>[0]> = {}) {
  const scheduler = new ManualScheduler();
  const svc = TableService.restore({ config: CONFIG, faults, scheduler, actionTimeoutMs: 1000, audit: true, ...extra }, records);
  return { svc, scheduler };
}

// Storage in a process about to die. After die(), the next write either
// never reaches the disk or reaches it and is never acknowledged.
export function dyingStore(disk: MemoryLog) {
  let fate: "before-write" | "after-write" | null = null;
  const store: Store = {
    async append(commit, events) {
      if (fate !== "before-write") await disk.append(commit, events);
      if (fate) await new Promise(() => {});
    },
  };
  return { store, die: (when: "before-write" | "after-write") => void (fate = when) };
}

export const tick = () => new Promise((r) => setImmediate(r));
