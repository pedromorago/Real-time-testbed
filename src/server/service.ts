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

// A commit as it sits in the log, with the events it produced.
export interface LogRecord {
  commit: Commit;
  events: TableEvent[];
}

export interface Store {
  append(commit: Commit, events: TableEvent[]): Promise<void>;
}

export const memoryStore: Store = { append: async () => {} };

// A log kept in memory that outlives the service writing to it, so the
// simulator and the checks can crash a service and restore another from it.
// Records are copied through JSON, as they would be on disk.
export class MemoryLog implements Store {
  readonly records: LogRecord[] = [];
  async append(commit: Commit, events: TableEvent[]) {
    this.records.push(JSON.parse(JSON.stringify({ commit, events })));
  }
}

// The log can't be trusted: a restore refuses to start from it.
export class CorruptLogError extends Error {}

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
    const key = keyOf(from, commandId);
    const fingerprint = this.fingerprint(from, command);
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

  // What a retry must repeat to be the same command: the command as the
  // server reads it, which is also what a commit records, so the cache can be
  // rebuilt from the log.
  private fingerprint(from: string, command: Command): string {
    return JSON.stringify(this.authorize(from, command));
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
    let res: ReturnType<typeof apply>;
    try {
      res = apply(prev, command, this.faults);
    } catch (e) {
      // A bug in the engine. Most commands come from timers with nobody to
      // hear a rejected promise, and an unhandled rejection kills Node.
      this.violations.push(`${command.type} by ${from} threw: ${(e as Error).message}`);
      return { ok: false, code: "internal_error", message: "the table could not apply this command" };
    }
    if (!res.ok) return { ok: false, code: res.code, message: res.message };

    // Persist before anyone sees the change, so a crash can never take back
    // an event a client already has. With the command queue in place nothing
    // else touches the state while this awaits.
    const firstSeq = this.log.length + 1;
    const record = { from, commandId, command, firstSeq, lastSeq: firstSeq + res.events.length - 1 };
    let commit: Commit;
    if (this.faults.has("publish-before-persist")) {
      commit = this.adopt(from, commandId, command, res.state, res.events);
      await this.store.append(record, res.events);
    } else {
      await this.store.append(record, res.events);
      commit = this.adopt(from, commandId, command, res.state, res.events);
    }
    if (this.opts.audit) {
      const found = [...checkState(res.state), ...checkStep(prev, command, res.state, res.events)];
      for (const v of found) this.violations.push(`after ${command.type} by ${from}: ${v}`);
    }
    this.schedule();
    return { ok: true, firstSeq: commit.firstSeq, lastSeq: commit.lastSeq };
  }

  // Makes a commit current: the new state, the commit, and its events
  // numbered at the end of the log and sent to every subscriber.
  private adopt(from: string, commandId: string, command: Command, state: TableState, events: TableEvent[]): Commit {
    const seq0 = this.log.length + 1;
    const commit: Commit = { from, commandId, command, firstSeq: seq0, lastSeq: seq0 + events.length - 1 };
    this.state = state;
    this.commits.push(commit);
    for (const event of events) {
      const entry = { seq: this.log.length + 1, event };
      this.log.push(entry);
      for (const s of this.subscribers) s.send(entry);
    }
    return commit;
  }

  // A service rebuilt from its log after a crash. Every commit is replayed
  // through the engine and must reproduce the events it recorded, in seq
  // order with no gap, or the restore refuses to start. Accepted commands go
  // back into the idempotency cache with their original result, and the
  // action timer or next-hand start is armed again for the restored table.
  // Rejected commands were never logged: a retry is decided afresh.
  static restore(opts: ServiceOptions, records: LogRecord[]): TableService {
    const svc = new TableService(opts);
    svc.load(records);
    return svc;
  }

  private load(records: LogRecord[]) {
    const verify = !this.faults.has("restore-trusts-log");
    const kept = this.faults.has("restore-drops-last") ? records.slice(0, -1) : records;
    for (const [i, record] of kept.entries()) {
      const { commit: c, events } = record ?? {};
      const at = `log record ${i + 1} (${c?.from}/${c?.commandId})`;
      if (verify && (!c || typeof c.from !== "string" || !Array.isArray(events))) throw new CorruptLogError(`${at}: not a commit`);
      const res = apply(this.state, c.command, this.faults);
      if (verify) {
        if (this.fingerprint(c.from, c.command) !== JSON.stringify(c.command)) throw new CorruptLogError(`${at}: ${c.from} can't send ${JSON.stringify(c.command)}`);
        if (c.firstSeq !== this.log.length + 1 || c.lastSeq !== c.firstSeq + events.length - 1)
          throw new CorruptLogError(`${at}: holds events ${c.firstSeq} to ${c.lastSeq}, expected ${events.length} events from ${this.log.length + 1}`);
        if (!res.ok) throw new CorruptLogError(`${at}: ${c.command.type} is rejected on replay: ${res.code}`);
        const k = events.findIndex((e, j) => JSON.stringify(e) !== JSON.stringify(res.events[j]));
        if (k >= 0 || events.length !== res.events.length)
          throw new CorruptLogError(`${at}: event ${c.firstSeq + (k >= 0 ? k : events.length)} differs from the replay`);
      }
      this.adopt(c.from, c.commandId, c.command, res.ok ? res.state : this.state, events);
      if (!this.faults.has("restore-no-idempotency")) {
        const result: Response = { ok: true, firstSeq: c.firstSeq, lastSeq: c.lastSeq };
        this.seen.set(keyOf(c.from, c.commandId), { fingerprint: JSON.stringify(c.command), result: Promise.resolve(result) });
      }
    }
    if (!this.faults.has("restore-no-timers")) this.schedule();
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

const keyOf = (from: string, commandId: string) => `${from}\u0000${commandId}`;

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
