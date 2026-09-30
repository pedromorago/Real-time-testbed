import type { Card } from "./cards.ts";

export interface TableConfig {
  seats: number;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  seed: number;
}

export interface Seat {
  playerId: string;
  stack: number;
  busted: boolean;
}

export type Street = "preflop" | "flop" | "turn" | "river";

export interface HandPlayer {
  seat: number;
  hole: Card[];
  bet: number; // committed on this street
  total: number; // committed in this hand
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  canRaise: boolean; // false after a short all-in that didn't reopen the betting
}

export interface Hand {
  id: number;
  button: number;
  street: Street;
  board: Card[];
  deck: Card[];
  dealt: number;
  players: HandPlayer[];
  toAct: number | null;
  turn: number;
  currentBet: number;
  minRaise: number;
}

export interface HandResult {
  handId: number;
  totals: Record<number, number>;
  won: Record<number, number>;
}

export interface TableState {
  config: TableConfig;
  seats: (Seat | null)[];
  hand: Hand | null;
  handsPlayed: number;
  button: number;
  // Chips that entered the table minus chips that left it.
  ledger: number;
  lastResult: HandResult | null;
}

export type Action =
  | { kind: "fold" }
  | { kind: "check" }
  | { kind: "call" }
  | { kind: "raise"; to: number }
  | { kind: "allin" };

export type Command =
  | { type: "sit"; playerId: string; seat: number; buyIn: number }
  | { type: "leave"; playerId: string }
  | { type: "start" }
  | { type: "act"; playerId: string; handId: number; turn: number; action: Action }
  | { type: "timeout"; handId: number; turn: number };

export interface Share {
  seat: number;
  amount: number;
  stack: number;
}

export type TableEvent =
  | { type: "PlayerSat"; playerId: string; seat: number; stack: number }
  | { type: "PlayerLeft"; playerId: string; seat: number; cashOut: number }
  | { type: "HandStarted"; handId: number; button: number; seats: number[] }
  | { type: "HoleCards"; handId: number; seat: number; playerId: string; cards: Card[] | null }
  | { type: "BlindPosted"; handId: number; seat: number; amount: number; bet: number; stack: number; allIn: boolean; currentBet: number }
  | {
      type: "ActionTaken";
      handId: number;
      turn: number;
      seat: number;
      action: Action["kind"];
      amount: number;
      bet: number;
      total: number;
      stack: number;
      folded: boolean;
      allIn: boolean;
      currentBet: number;
      timeout: boolean;
    }
  | {
      type: "TurnStarted";
      handId: number;
      turn: number;
      seat: number;
      toCall: number;
      minRaiseTo: number;
      maxRaiseTo: number;
      canRaise: boolean;
    }
  | { type: "StreetDealt"; handId: number; street: Street; cards: Card[] }
  | { type: "ShowdownRevealed"; handId: number; seat: number; cards: Card[] }
  | { type: "PotAwarded"; handId: number; pot: number; amount: number; shares: Share[] }
  | { type: "HandEnded"; handId: number }
  | { type: "PlayerBusted"; playerId: string; seat: number };

export type RejectCode =
  | "bad_command"
  | "bad_seat"
  | "seat_taken"
  | "already_seated"
  | "bad_buy_in"
  | "not_seated"
  | "in_hand"
  | "hand_in_progress"
  | "not_enough_players"
  | "no_hand"
  | "not_in_hand"
  | "stale_hand"
  | "stale_turn"
  | "not_your_turn"
  | "cannot_check"
  | "nothing_to_call"
  | "cannot_raise"
  | "raise_too_small"
  | "insufficient_chips"
  | "not_authorized"
  | "idempotency_conflict"
  | "internal_error";

export type Result =
  | { ok: true; state: TableState; events: TableEvent[] }
  | { ok: false; code: RejectCode; message: string };
