import { type Faults, NO_FAULTS } from "../engine/faults.ts";
import type { Command, TableEvent } from "../engine/types.ts";
import { applyEvent, emptyView, type View } from "../engine/view.ts";
import type { ClientMsg, Response, ServerMsg } from "../server/protocol.ts";

export interface Link {
  send(msg: ClientMsg): void;
}

type TurnStarted = Extract<TableEvent, { type: "TurnStarted" }>;

// A client that keeps a local copy of the table from the event stream.
// Events are applied strictly in sequence order: duplicates are dropped and
// early arrivals wait in a buffer until the gap before them is filled. On
// reconnect it asks for everything after the last event it applied and
// re-sends every command that has no result yet, under the same id.
export class TableClient {
  view: View;
  lastSeq = 0;
  turn: TurnStarted | null = null;
  readonly pending = new Map<string, Command>();
  readonly results = new Map<string, Response>();
  // Things a correct server and client should never produce.
  readonly anomalies: string[] = [];
  onChange: () => void = () => {};
  onResult: (id: string, cmd: Command, result: Response) => void = () => {};
  private readonly buffer = new Map<number, TableEvent>();
  private readonly sent = new Map<string, Command>();
  private link: Link | null = null;
  private ready = false;
  private n = 0;

  constructor(
    readonly playerId: string | null,
    seats: number,
    private readonly faults: Faults = NO_FAULTS,
  ) {
    this.view = emptyView(seats);
  }

  get connected(): boolean {
    return this.link !== null;
  }

  get seat(): number {
    return this.view.seats.findIndex((s) => s?.playerId === this.playerId);
  }

  attach(link: Link) {
    this.link = link;
    this.ready = false;
    link.send({ t: "hello", playerId: this.playerId, lastSeq: this.lastSeq });
  }

  detach() {
    this.link = null;
    this.ready = false;
  }

  send(cmd: Command): string {
    const id = `${this.playerId}-${++this.n}`;
    this.pending.set(id, cmd);
    this.sent.set(id, cmd);
    if (this.ready) this.link?.send({ t: "cmd", id, cmd });
    return id;
  }

  receive(msg: ServerMsg) {
    switch (msg.t) {
      case "welcome":
        this.ready = true;
        for (const [id, cmd] of this.pending) this.link?.send({ t: "cmd", id, cmd });
        this.onChange();
        return;
      case "event":
        return this.onEvent(msg.seq, msg.event);
      case "result": {
        const known = this.results.get(msg.id);
        if (known) {
          if (JSON.stringify(known) !== JSON.stringify(msg.result))
            this.anomalies.push(`command ${msg.id} got two different results: ${known.ok ? "ok" : known.code} and ${msg.result.ok ? "ok" : msg.result.code}`);
          return;
        }
        const cmd = this.sent.get(msg.id);
        if (!cmd) return void this.anomalies.push(`result for unknown command ${msg.id}`);
        this.pending.delete(msg.id);
        this.results.set(msg.id, msg.result);
        this.onResult(msg.id, cmd, msg.result);
        this.onChange();
        return;
      }
      case "error":
        this.anomalies.push(`server error: ${msg.message}`);
    }
  }

  private onEvent(seq: number, event: TableEvent) {
    if (event.type === "HoleCards" && event.cards && event.playerId !== this.playerId)
      this.anomalies.push(`saw ${event.playerId}'s hole cards in hand ${event.handId}`);
    if (this.faults.has("client-no-reorder")) {
      if (seq <= this.lastSeq && !this.faults.has("client-no-dedupe")) return;
      this.apply(event);
      this.lastSeq = Math.max(this.lastSeq, seq);
    } else {
      if (seq <= this.lastSeq) {
        if (this.faults.has("client-no-dedupe")) this.apply(event);
        return;
      }
      this.buffer.set(seq, event);
      while (this.buffer.has(this.lastSeq + 1)) {
        const next = this.buffer.get(this.lastSeq + 1)!;
        this.buffer.delete(this.lastSeq + 1);
        this.lastSeq += 1;
        this.apply(next);
      }
    }
    this.onChange();
  }

  private apply(event: TableEvent) {
    try {
      applyEvent(this.view, event, this.playerId);
      if (event.type === "TurnStarted") this.turn = event;
    } catch (e) {
      this.anomalies.push(`could not apply ${event.type}: ${(e as Error).message}`);
    }
  }
}
