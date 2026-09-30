import type { Card } from "./cards.ts";
import type { Street, TableEvent, TableState } from "./types.ts";

// What one participant can know about the table. The server derives it from
// its state; a client derives it from the events it received. The two must
// always agree, which is how the tests check that no event was lost,
// duplicated or reordered on the way.
export interface View {
  seats: ({ playerId: string; stack: number; busted: boolean } | null)[];
  hand: {
    id: number;
    button: number;
    street: Street;
    board: Card[];
    toAct: number | null;
    turn: number;
    currentBet: number;
    players: { seat: number; bet: number; total: number; folded: boolean; allIn: boolean }[];
  } | null;
  hole: Card[] | null; // the viewer's own cards
}

export function emptyView(seats: number): View {
  return { seats: Array(seats).fill(null), hand: null, hole: null };
}

export function viewOf(state: TableState, viewer: string | null): View {
  const h = state.hand;
  const mine = h?.players.find((p) => state.seats[p.seat]?.playerId === viewer);
  return {
    seats: state.seats.map((x) => (x ? { playerId: x.playerId, stack: x.stack, busted: x.busted } : null)),
    hand: h && {
      id: h.id,
      button: h.button,
      street: h.street,
      board: [...h.board],
      toAct: h.toAct,
      turn: h.turn,
      currentBet: h.currentBet,
      players: h.players.map(({ seat, bet, total, folded, allIn }) => ({ seat, bet, total, folded, allIn })),
    },
    hole: mine ? [...mine.hole] : null,
  };
}

// Hole cards are the only private information in an event stream.
export function redact(event: TableEvent, viewer: string | null): TableEvent {
  if (event.type === "HoleCards" && event.playerId !== viewer) return { ...event, cards: null };
  return event;
}

export function applyEvent(v: View, e: TableEvent, viewer: string | null): void {
  const player = (seat: number) => v.hand!.players.find((p) => p.seat === seat)!;
  switch (e.type) {
    case "PlayerSat":
      v.seats[e.seat] = { playerId: e.playerId, stack: e.stack, busted: false };
      break;
    case "PlayerLeft":
      v.seats[e.seat] = null;
      break;
    case "PlayerBusted":
      v.seats[e.seat]!.busted = true;
      break;
    case "HandStarted":
      v.hand = {
        id: e.handId,
        button: e.button,
        street: "preflop",
        board: [],
        toAct: null,
        turn: 0,
        currentBet: 0,
        players: e.seats.map((seat) => ({ seat, bet: 0, total: 0, folded: false, allIn: false })),
      };
      v.hole = null;
      break;
    case "HoleCards":
      if (e.playerId === viewer && e.cards) v.hole = [...e.cards];
      break;
    case "BlindPosted": {
      const p = player(e.seat);
      p.bet = e.bet;
      p.total = e.bet;
      p.allIn = e.allIn;
      v.seats[e.seat]!.stack = e.stack;
      v.hand!.currentBet = e.currentBet;
      break;
    }
    case "ActionTaken": {
      const p = player(e.seat);
      Object.assign(p, { bet: e.bet, total: e.total, folded: e.folded, allIn: e.allIn });
      v.seats[e.seat]!.stack = e.stack;
      v.hand!.currentBet = e.currentBet;
      v.hand!.toAct = null;
      break;
    }
    case "TurnStarted":
      v.hand!.toAct = e.seat;
      v.hand!.turn = e.turn;
      break;
    case "StreetDealt":
      v.hand!.street = e.street;
      v.hand!.board.push(...e.cards);
      v.hand!.currentBet = 0;
      v.hand!.toAct = null;
      for (const p of v.hand!.players) p.bet = 0;
      break;
    case "ShowdownRevealed":
      break;
    case "PotAwarded":
      for (const s of e.shares) v.seats[s.seat]!.stack = s.stack;
      break;
    case "HandEnded":
      v.hand = null;
      v.hole = null;
      break;
  }
}
