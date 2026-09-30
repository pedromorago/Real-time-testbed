import type { Scheduler } from "../server/scheduler.ts";
import type { Commit, Store } from "../server/service.ts";
import type { TableEvent } from "../engine/types.ts";

export type WriteStage = "reaching-disk" | "on-disk" | "acknowledged";

// One life of a server process, so a test can kill it without stopping the
// clock or the disk. The service is built on this process's scheduler and
// store: after kill() none of its timers fire and none of its writes are
// acknowledged, so its queue never moves again. A write takes two moments,
// one to reach the disk and one for the acknowledgement to come back, and a
// crash can land before, between or after them.
export class ServerProcess {
  alive = true;
  // Writes in progress: not on disk yet, and on disk but not acknowledged.
  writing = 0;
  unacknowledged = 0;
  // Called at each stage of every write, for tests that aim a crash at one.
  onWrite: (stage: WriteStage) => void = () => {};
  readonly scheduler: Scheduler;
  readonly store: Store;

  constructor(clock: Scheduler, disk: Store, latency: () => number = () => 0) {
    this.scheduler = { now: () => clock.now(), after: (ms, fn) => clock.after(ms, () => this.alive && fn()) };
    this.store = {
      append: (commit: Commit, events: TableEvent[]) =>
        new Promise<void>((resolve) => {
          this.writing++;
          clock.after(latency(), async () => {
            if (this.alive) this.onWrite("reaching-disk");
            if (!this.alive) return;
            await disk.append(commit, events);
            this.writing--;
            this.unacknowledged++;
            this.onWrite("on-disk");
            if (!this.alive) return;
            clock.after(latency(), () => {
              if (!this.alive) return;
              this.unacknowledged--;
              resolve();
              this.onWrite("acknowledged");
            });
          });
        }),
    };
  }

  kill() {
    this.alive = false;
  }
}
