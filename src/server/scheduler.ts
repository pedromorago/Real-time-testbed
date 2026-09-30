export interface Scheduler {
  now(): number;
  after(ms: number, fn: () => void): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  after: (ms, fn) => void setTimeout(fn, ms).unref?.(),
};
