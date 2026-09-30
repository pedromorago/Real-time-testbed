import { type Faults, NO_FAULTS } from "../engine/faults.ts";
import { checkState, checkStep } from "../engine/invariants.ts";
import { apply, newTable } from "../engine/table.ts";
import type { Command, TableConfig, TableEvent, TableState } from "../engine/types.ts";
import { redact } from "../engine/view.ts";
import type { Response } from "./protocol.ts";
import { realScheduler, type Scheduler } from "./scheduler.ts";

export const SYSTEM = "system";

export interface LogEntry {
  seq: number;
  event: TableEvent;
}

// One accepted command and what it produced. Enough to replay the table.
export interface Commit {
  from: string;
  commandId: string;
  command: Command;
  firstSeq: number;
  lastSeq: number;
}

export interface Store {
  append(commit: Commit, events: TableEvent[]): Promise<void>;
}

export const memoryStore: Store = { append: async () => {} };

export interface ServiceOptions {
  config: TableConfig;
  faults?: Faults;
  scheduler?: Scheduler;
  store?: Store;
  actionTimeoutMs?: number;
  nextHandDelayMs?: number;
  // Stop dealing after this many hands (for simulations).
  maxHands?: number;
  // Check the table invariants after every commit.
  audit?: boolean;
}

interface Subscriber {
  viewer: string | null;
  send(entry: LogEntry): void;
}

// The single owner of a table's state. Everything goes through submit():
// commands are deduplicated by (sender, command id), applied one at a time,
// persisted, then published to subscribers in log order.
export class TableService {
  state: TableState;
  readonly log: LogEntry[] = [];
  readonly commits: Commit[] = [];
  readonly violations: string[] = [];
  private readonly faults: Faults;
  private readonly scheduler: Scheduler;
  private readonly store: Store;
  private readonly seen = new Map<string, { fingerprint: string; result: Promise<Response> }>();
  private readonly subscribers = new Set<Subscriber>();
  private queue: Promise<unknown> = Promise.resolve();
  private armedTurn = "";

  constructor(private readonly opts: ServiceOptions) {
    this.state = newTable(opts.config);
    this.faults = opts.faults ?? NO_FAULTS;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.store = opts.store ?? memoryStore;
  }

  submit(from: string, commandId: string, command: Command): Promise<Response> {
    const key = `${from}\u0000${commandId}`;
    const fingerprint = JSON.stringify(command);
    const known = this.seen.get(key);
    if (known && !this.faults.has("no-idempotency")) {
      if (known.fingerprint === fingerprint) return known.result;
      return Promise.resolve({ ok: false, code: "idempotency_conflict", message: `command id ${commandId} was used for a different command` });
    }
    const run = () => this.process(from, commandId, command);
    const result = this.faults.has("no-command-queue") ? run() : (this.queue = this.queue.then(run, run));
    this.seen.set(key, { fingerprint, result: result as Promise<Response> });
    return result as Promise<Response>;
  }

  private authorize(from: string, command: Command): Command | Response {
    const denied: Response = { ok: false, code: "not_authorized", message: `${command?.type} is not allowed from ${from}` };
    if (!command || typeof command !== "object") return { ok: false, code: "bad_command", message: "not a command" };
    if (from === SYSTEM) return command.type === "start" || command.type === "timeout" ? command : denied;
    if (command.type === "sit" || command.type === "leave" || command.type === "act") return { ...command, playerId: from };
    return denied;
  }

  private async process(from: string, commandId: string, raw: Command): Promise<Response> {
    const command = this.authorize(from, raw);
    if ("ok" in command) return command;
    const prev = this.state;
    const res = apply(prev, command, this.faults);
    if (!res.ok) return { ok: false, code: res.code, message: res.message };

    // Persist before anyone sees the change. With the command queue in
    // place nothing else touches the state while this awaits.
    const firstSeq = this.log.length + 1;
    await this.store.append({ from, commandId, command, firstSeq, lastSeq: firstSeq + res.events.length - 1 }, res.events);

    const seq0 = this.log.length + 1;
    const commit: Commit = { from, commandId, command, firstSeq: seq0, lastSeq: seq0 + res.events.length - 1 };
    this.state = res.state;
    this.commits.push(commit);
    if (this.opts.audit) {
      const found = [...checkState(res.state), ...checkStep(prev, command, res.state, res.events)];
      for (const v of found) this.violations.push(`after ${command.type} by ${from}: ${v}`);
    }
    for (const event of res.events) {
      const entry = { seq: this.log.length + 1, event };
      this.log.push(entry);
      for (const s of this.subscribers) s.send(entry);
    }
    this.schedule();
    return { ok: true, firstSeq: commit.firstSeq, lastSeq: commit.lastSeq };
  }

  // Timers are never cancelled. A timer that fires after its turn is over is
  // rejected by the table as stale, which is exactly what the tests poke at.
  private schedule() {
    const h = this.state.hand;
    const { actionTimeoutMs = 15_000, nextHandDelayMs = 2_000, maxHands = Infinity } = this.opts;
    if (h && h.toAct !== null) {
      const key = `${h.id}:${h.turn}`;
      if (key === this.armedTurn) return;
      this.armedTurn = key;
      const cmd: Command = { type: "timeout", handId: h.id, turn: h.turn };
      this.scheduler.after(actionTimeoutMs, () => void this.submit(SYSTEM, `timeout:${key}`, cmd));
    } else if (!h && this.state.handsPlayed < maxHands) {
      // Keyed by log position, not hand number: a start that failed for lack
      // of players must not be answered from the idempotency cache later.
      const id = `start:${this.state.handsPlayed + 1}@${this.head}`;
      this.scheduler.after(nextHandDelayMs, () => void this.submit(SYSTEM, id, { type: "start" }));
    }
  }

  // Sends every event after `lastSeq`, then every new one, redacted for the viewer.
  subscribe(viewer: string | null, lastSeq: number, send: (entry: LogEntry) => void): () => void {
    const leak = this.faults.has("hole-card-leak");
    const sub: Subscriber = { viewer, send: (e) => send(leak ? e : { seq: e.seq, event: redact(e.event, viewer) }) };
    const from = this.faults.has("resume-from-last-seq") ? lastSeq : this.faults.has("resume-skips-one") ? lastSeq + 2 : lastSeq + 1;
    for (let seq = Math.max(from, 1); seq <= this.log.length; seq++) sub.send(this.log[seq - 1]);
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  get head(): number {
    return this.log.length;
  }
}

// Re-runs the accepted commands from an empty table.
export function replay(config: TableConfig, commits: Commit[], faults: Faults = NO_FAULTS): { state: TableState; events: TableEvent[]; errors: string[] } {
  let state = newTable(config);
  const events: TableEvent[] = [];
  const errors: string[] = [];
  for (const c of commits) {
    const res = apply(state, c.command, faults);
    if (!res.ok) {
      errors.push(`${c.from}/${c.commandId} ${c.command.type} was accepted live but rejected on replay: ${res.code}`);
      continue;
    }
    if (events.length + 1 !== c.firstSeq) errors.push(`${c.from}/${c.commandId} starts at seq ${c.firstSeq}, replay has it at ${events.length + 1}`);
    state = res.state;
    events.push(...res.events);
  }
  return { state, events, errors };
}
