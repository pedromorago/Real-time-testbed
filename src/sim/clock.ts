import type { Scheduler } from "../server/scheduler.ts";

// Virtual time. Callbacks run in time order (ties in scheduling order), and
// after each one the microtask queue is drained, so promise chains in the
// server settle before the clock moves on. Same seed, same interleaving.
export class VirtualClock implements Scheduler {
  private t = 0;
  private order = 0;
  private queue: { at: number; order: number; fn: () => void }[] = [];

  now() {
    return this.t;
  }

  after(ms: number, fn: () => void) {
    const item = { at: this.t + Math.max(0, ms), order: this.order++, fn };
    // Binary insert keeps the queue sorted by (at, order).
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.at < item.at || (q.at === item.at && q.order < item.order)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, item);
  }

  get idle() {
    return this.queue.length === 0;
  }

  async run(opts: { until?: () => boolean; limit: number }): Promise<void> {
    await settle();
    while (this.queue.length && !opts.until?.()) {
      const next = this.queue.shift()!;
      if (next.at > opts.limit) {
        this.queue.unshift(next);
        return;
      }
      this.t = next.at;
      next.fn();
      await settle();
    }
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
