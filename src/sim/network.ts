import { TableClient } from "../client/client.ts";
import { openConnection } from "../server/gateway.ts";
import type { ClientMsg, ServerMsg } from "../server/protocol.ts";
import type { TableService } from "../server/service.ts";
import type { VirtualClock } from "./clock.ts";

export interface Chaos {
  latencyMs: number; // base one-way delay
  jitterMs: number; // extra random delay, which also reorders messages
  duplicateRate: number; // chance a command, event or result is delivered twice
  disconnectEveryMs: number; // mean time between dropped connections, 0 for never
  reconnectAfterMs: number;
  crashEveryMs?: number; // mean time between server crashes, 0 or absent for never
  restartAfterMs?: number; // how long the server stays down
}

export const CALM: Chaos = { latencyMs: 5, jitterMs: 0, duplicateRate: 0, disconnectEveryMs: 0, reconnectAfterMs: 50 };

// A connection between one client and the server that behaves like an
// at-least-once, unordered delivery path: messages are delayed by random
// amounts (so they overtake each other), some are delivered twice, and the
// whole connection drops now and then, losing everything in flight. A single
// WebSocket is kinder than this (TCP keeps order and never duplicates), but
// retries across reconnects, several tabs and proxies bring all of it back.
// While the server is down, connecting fails and the client tries again.
export class ChaosLink {
  private epoch = 0;
  private connected = false;
  calm = false;
  connections = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly random: () => number,
    private readonly server: () => TableService | null,
    readonly client: TableClient,
    private readonly chaos: Chaos,
  ) {}

  connect() {
    const epoch = ++this.epoch;
    const service = this.server();
    if (!service) return void this.clock.after(this.chaos.reconnectAfterMs, () => this.connect());
    this.connected = true;
    this.connections++;
    const deliver = (dup: boolean, fn: () => void) => {
      const go = () => this.epoch === epoch && this.connected && fn();
      const jitter = this.calm ? 0 : this.chaos.jitterMs;
      this.clock.after(this.chaos.latencyMs + this.random() * jitter, go);
      if (dup && !this.calm && this.random() < this.chaos.duplicateRate)
        this.clock.after(this.chaos.latencyMs + this.random() * jitter * 2, go);
    };
    const server = openConnection(service, (m: ServerMsg) => deliver(m.t !== "welcome", () => this.client.receive(m)));
    this.client.attach({ send: (m: ClientMsg) => deliver(m.t === "cmd", () => server.receive(m)) });
    this.drop = () => {
      if (this.epoch !== epoch || !this.connected) return;
      this.connected = false;
      server.close();
      this.client.detach();
      this.clock.after(this.chaos.reconnectAfterMs, () => this.connect());
    };
    this.armDisconnect(epoch);
  }

  drop: () => void = () => {};

  private armDisconnect(epoch: number) {
    const mean = this.chaos.disconnectEveryMs;
    if (!mean || this.calm) return;
    const wait = -Math.log(1 - this.random()) * mean; // exponential
    this.clock.after(wait, () => this.epoch === epoch && !this.calm && this.drop());
  }
}
