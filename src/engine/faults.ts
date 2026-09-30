// Deliberate bugs that can be switched on to check that the tests notice them.
// Production code paths read these flags in exactly one place each.
export const FAULTS = {
  "no-idempotency": "Retried commands are executed again instead of returning the first result",
  "no-command-queue": "Commands are validated concurrently while an earlier one is still being persisted",
  "resume-from-last-seq": "Resume replays from the last event the client has, not the one after it",
  "resume-skips-one": "Resume replays from two events after the client's last one",
  "stale-timer": "An action timer fires on whatever turn is current, not the turn it was set for",
  "side-pot-cap": "An all-in player can win chips above their own contribution level",
  "odd-chip-lost": "The odd chip of a split pot goes to nobody",
  "hole-card-leak": "Hole cards are sent unredacted to every connection",
  "busted-dealt-in": "Players with no chips are still dealt into the next hand",
  "min-raise-ignored": "Raises smaller than the minimum raise are accepted",
  "client-no-dedupe": "The client applies an event again when it arrives twice",
  "client-no-reorder": "The client applies events in arrival order, not sequence order",
} as const;

export type Fault = keyof typeof FAULTS;
export type Faults = ReadonlySet<Fault>;
export const NO_FAULTS: Faults = new Set();
