import { shuffledDeck } from "./cards.ts";
import { evaluate } from "./evaluator.ts";
import { type Faults, NO_FAULTS } from "./faults.ts";
import type { Action, Command, Hand, HandPlayer, RejectCode, Result, Share, Street, TableConfig, TableEvent, TableState } from "./types.ts";

// The rules of a No-Limit Hold'em table as a pure function:
// apply(state, command) either rejects the command or returns the next state
// and the events that describe the change. No clocks, no I/O, no randomness
// except the seeded deck, so a log of commands replays to the same events.

export function newTable(config: TableConfig): TableState {
  return { config, seats: Array(config.seats).fill(null), hand: null, handsPlayed: 0, button: -1, ledger: 0, lastResult: null };
}

class Reject extends Error {
  constructor(
    readonly code: RejectCode,
    message: string,
  ) {
    super(message);
  }
}
const reject = (code: RejectCode, message: string): never => {
  throw new Reject(code, message);
};

const STREETS: Street[] = ["preflop", "flop", "turn", "river"];

export function apply(prev: TableState, cmd: Command, faults: Faults = NO_FAULTS): Result {
  const state = structuredClone(prev);
  const events: TableEvent[] = [];
  try {
    new Step(state, events, faults).run(cmd);
    return { ok: true, state, events };
  } catch (e) {
    if (e instanceof Reject) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

class Step {
  constructor(
    private s: TableState,
    private events: TableEvent[],
    private faults: Faults,
  ) {}

  private get h(): Hand {
    return this.s.hand ?? reject("no_hand", "no hand in progress");
  }

  run(cmd: Command) {
    switch (cmd?.type) {
      case "sit":
        return this.sit(cmd.playerId, cmd.seat, cmd.buyIn);
      case "leave":
        return this.leave(cmd.playerId);
      case "start":
        return this.start();
      case "act":
        return this.act(cmd.playerId, cmd.handId, cmd.turn, cmd.action);
      case "timeout":
        return this.timeout(cmd.handId, cmd.turn);
      default:
        reject("bad_command", "unknown command");
    }
  }

  private seatOf(playerId: string): number {
    return this.s.seats.findIndex((x) => x?.playerId === playerId);
  }

  private sit(playerId: string, seat: number, buyIn: number) {
    const { config, seats } = this.s;
    if (typeof playerId !== "string" || !playerId) reject("bad_command", "missing player");
    if (!Number.isInteger(seat) || seat < 0 || seat >= config.seats) reject("bad_seat", `no seat ${seat}`);
    if (seats[seat]) reject("seat_taken", `seat ${seat} is taken`);
    if (this.seatOf(playerId) >= 0) reject("already_seated", `${playerId} is already seated`);
    if (!Number.isInteger(buyIn) || buyIn < config.minBuyIn || buyIn > config.maxBuyIn)
      reject("bad_buy_in", `buy-in must be ${config.minBuyIn} to ${config.maxBuyIn}`);
    seats[seat] = { playerId, stack: buyIn, busted: false };
    this.s.ledger += buyIn;
    this.events.push({ type: "PlayerSat", playerId, seat, stack: buyIn });
  }

  private leave(playerId: string) {
    const seat = this.seatOf(playerId);
    if (seat < 0) reject("not_seated", `${playerId} is not seated`);
    if (this.s.hand?.players.some((p) => p.seat === seat)) reject("in_hand", "wait for the hand to finish");
    const cashOut = this.s.seats[seat]!.stack;
    this.s.seats[seat] = null;
    this.s.ledger -= cashOut;
    this.events.push({ type: "PlayerLeft", playerId, seat, cashOut });
  }

  // Seats that get dealt in, clockwise from `from` (exclusive).
  private clockwise(from: number, seats: number[]): number[] {
    const n = this.s.config.seats;
    return [...seats].sort((a, b) => ((a - from - 1 + n) % n) - ((b - from - 1 + n) % n));
  }

  private start() {
    const { s } = this;
    if (s.hand) reject("hand_in_progress", "a hand is already running");
    const eligible = s.seats.flatMap((x, i) => (x && (!x.busted || this.faults.has("busted-dealt-in")) ? [i] : []));
    if (eligible.length < 2) reject("not_enough_players", "need two players with chips");
    const { smallBlind, bigBlind, seed } = s.config;
    const button = this.clockwise(s.button, eligible)[0];
    const order = this.clockwise(button, eligible); // left of the button first, button last
    const id = s.handsPlayed + 1;
    const hand: Hand = {
      id,
      button,
      street: "preflop",
      board: [],
      deck: shuffledDeck((seed + Math.imul(id, 0x9e3779b9)) >>> 0),
      dealt: 0,
      players: order.map((seat) => ({ seat, hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: false, canRaise: true })),
      toAct: null,
      turn: 0,
      currentBet: 0,
      minRaise: bigBlind,
    };
    s.hand = hand;
    s.button = button;
    this.events.push({ type: "HandStarted", handId: id, button, seats: order });
    for (const p of hand.players) {
      p.hole = this.draw(2);
      this.events.push({ type: "HoleCards", handId: id, seat: p.seat, playerId: s.seats[p.seat]!.playerId, cards: p.hole });
    }
    // Heads-up the button posts the small blind and acts first before the flop.
    const [sb, bb] = order.length === 2 ? [button, order[0]] : [order[0], order[1]];
    this.post(sb, smallBlind);
    this.post(bb, bigBlind);
    hand.currentBet = bigBlind;
    this.nextTurn(bb);
  }

  private draw(n: number): number[] {
    const h = this.h;
    const cards = h.deck.slice(h.dealt, h.dealt + n);
    h.dealt += n;
    return cards;
  }

  private player(seat: number): HandPlayer {
    return this.h.players.find((p) => p.seat === seat)!;
  }

  private commit(p: HandPlayer, amount: number) {
    const seat = this.s.seats[p.seat]!;
    seat.stack -= amount;
    p.bet += amount;
    p.total += amount;
    if (seat.stack === 0) p.allIn = true;
  }

  private post(seat: number, blind: number) {
    const p = this.player(seat);
    const amount = Math.min(blind, this.s.seats[seat]!.stack);
    this.commit(p, amount);
    this.h.currentBet = Math.max(this.h.currentBet, p.bet);
    this.events.push({
      type: "BlindPosted",
      handId: this.h.id,
      seat,
      amount,
      bet: p.bet,
      stack: this.s.seats[seat]!.stack,
      allIn: p.allIn,
      currentBet: this.h.currentBet,
    });
  }

  private needsAction(p: HandPlayer): boolean {
    if (p.folded || p.allIn) return false;
    if (p.bet < this.h.currentBet) return true;
    const free = this.h.players.filter((q) => !q.folded && !q.allIn).length;
    return !p.acted && free > 1;
  }

  // Hands the turn to the next player clockwise after `after` who still has
  // to act, or closes the betting round.
  private nextTurn(after: number) {
    const h = this.h;
    h.toAct = null;
    const seats = h.players.map((p) => p.seat);
    const next = this.clockwise(after, seats).find((seat) => this.needsAction(this.player(seat)));
    if (next === undefined) return this.endStreet();
    const p = this.player(next);
    const stack = this.s.seats[next]!.stack;
    h.toAct = next;
    h.turn += 1;
    this.events.push({
      type: "TurnStarted",
      handId: h.id,
      turn: h.turn,
      seat: next,
      toCall: Math.min(h.currentBet - p.bet, stack),
      minRaiseTo: Math.min(h.currentBet + h.minRaise, p.bet + stack),
      maxRaiseTo: p.bet + stack,
      canRaise: p.canRaise && p.bet + stack > h.currentBet,
    });
  }

  private act(playerId: string, handId: number, turn: number, action: Action) {
    const h = this.h;
    const seat = this.seatOf(playerId);
    if (seat < 0) reject("not_seated", `${playerId} is not seated`);
    if (!h.players.some((p) => p.seat === seat)) reject("not_in_hand", `${playerId} is not in this hand`);
    if (handId !== h.id) reject("stale_hand", `hand ${handId} is over`);
    if (turn !== h.turn) reject("stale_turn", `turn ${turn} is over`);
    if (h.toAct !== seat) reject("not_your_turn", "not your turn");
    this.take(seat, action, false);
  }

  private timeout(handId: number, turn: number) {
    const h = this.h;
    const current = handId === h.id && turn === h.turn;
    if (!current && !this.faults.has("stale-timer")) reject("stale_turn", "timer for a finished turn");
    const seat = h.toAct ?? reject("stale_turn", "nobody to act");
    const p = this.player(seat);
    this.take(p.seat, { kind: p.bet === h.currentBet ? "check" : "fold" }, true);
  }

  private take(seat: number, action: Action, timeout: boolean) {
    const h = this.h;
    const p = this.player(seat);
    const stack = this.s.seats[seat]!.stack;
    const kind = action?.kind;
    let amount = 0;
    switch (kind) {
      case "fold":
        p.folded = true;
        break;
      case "check":
        if (p.bet !== h.currentBet) reject("cannot_check", `${h.currentBet - p.bet} to call`);
        break;
      case "call":
        if (p.bet >= h.currentBet) reject("nothing_to_call", "nothing to call");
        amount = Math.min(h.currentBet - p.bet, stack);
        break;
      case "allin":
      case "raise": {
        const to = kind === "allin" ? p.bet + stack : (action as { to: number }).to;
        if (!Number.isInteger(to)) reject("bad_command", "raise needs a whole amount");
        if (kind === "allin" && to <= h.currentBet) {
          amount = stack; // an all-in that doesn't cover the bet is a call
          break;
        }
        if (to <= h.currentBet) reject("raise_too_small", `raise to more than ${h.currentBet}`);
        if (to - p.bet > stack) reject("insufficient_chips", `you have ${stack}`);
        if (!p.canRaise) reject("cannot_raise", "the betting was not reopened");
        const full = to - h.currentBet >= h.minRaise;
        const allIn = to - p.bet === stack;
        if (!full && !allIn && !this.faults.has("min-raise-ignored"))
          reject("raise_too_small", `minimum raise is to ${h.currentBet + h.minRaise}`);
        for (const q of h.players) {
          if (q === p || q.folded || q.allIn) continue;
          if (full) q.canRaise = true;
          else if (q.acted) q.canRaise = false; // a short all-in doesn't reopen the action
          q.acted = false;
        }
        if (full) h.minRaise = to - h.currentBet;
        h.currentBet = to;
        amount = to - p.bet;
        break;
      }
      default:
        reject("bad_command", "unknown action");
    }
    this.commit(p, amount);
    p.acted = true;
    h.toAct = null;
    this.events.push({
      type: "ActionTaken",
      handId: h.id,
      turn: h.turn,
      seat,
      action: action.kind,
      amount,
      bet: p.bet,
      total: p.total,
      stack: this.s.seats[seat]!.stack,
      folded: p.folded,
      allIn: p.allIn,
      currentBet: h.currentBet,
      timeout,
    });
    const live = h.players.filter((q) => !q.folded);
    if (live.length === 1) return this.award([[live[0].seat]]);
    this.nextTurn(seat);
  }

  private endStreet() {
    const h = this.h;
    if (h.street === "river") return this.showdown();
    h.street = STREETS[STREETS.indexOf(h.street) + 1];
    const cards = this.draw(h.street === "flop" ? 3 : 1);
    h.board.push(...cards);
    for (const p of h.players) {
      p.bet = 0;
      p.acted = false;
      p.canRaise = true;
    }
    h.currentBet = 0;
    h.minRaise = this.s.config.bigBlind;
    this.events.push({ type: "StreetDealt", handId: h.id, street: h.street, cards });
    this.nextTurn(h.button);
  }

  private showdown() {
    const h = this.h;
    const live = h.players.filter((p) => !p.folded);
    for (const p of live) this.events.push({ type: "ShowdownRevealed", handId: h.id, seat: p.seat, cards: p.hole });
    const score = new Map(live.map((p) => [p.seat, evaluate([...p.hole, ...h.board])]));
    // Rank groups, best first: [[seats tied for best], [next], ...]
    const values = [...new Set(score.values())].sort((a, b) => b - a);
    this.award(values.map((v) => live.filter((p) => score.get(p.seat) === v).map((p) => p.seat)));
  }

  // Splits the pot into a main pot and side pots by contribution level and
  // gives each one to the best eligible hand.
  private award(ranking: number[][]) {
    const h = this.h;
    const live = new Set(ranking.flat());
    const levels = [...new Set(h.players.filter((p) => live.has(p.seat)).map((p) => p.total))].sort((a, b) => a - b);
    const top = Math.max(...h.players.map((p) => p.total));
    if (levels.at(-1)! < top) levels.push(top);
    const won: Record<number, number> = {};
    let prev = 0;
    let carry = 0;
    const order = this.clockwise(h.button, h.players.map((p) => p.seat));
    levels.forEach((level, i) => {
      const amount = carry + h.players.reduce((sum, p) => sum + Math.min(p.total, level) - Math.min(p.total, prev), 0);
      prev = level;
      const eligible = h.players
        .filter((p) => live.has(p.seat) && (p.total >= level || this.faults.has("side-pot-cap")))
        .map((p) => p.seat);
      const winners = ranking.map((g) => g.filter((s) => eligible.includes(s))).find((g) => g.length);
      if (!winners || amount === 0) {
        carry = amount;
        return;
      }
      carry = 0;
      const base = Math.floor(amount / winners.length);
      let odd = this.faults.has("odd-chip-lost") ? 0 : amount - base * winners.length;
      const shares: Share[] = order
        .filter((s) => winners.includes(s))
        .map((seat) => {
          const got = base + (odd-- > 0 ? 1 : 0);
          this.s.seats[seat]!.stack += got;
          won[seat] = (won[seat] ?? 0) + got;
          return { seat, amount: got, stack: this.s.seats[seat]!.stack };
        });
      this.events.push({ type: "PotAwarded", handId: h.id, pot: i, amount, shares });
    });
    if (carry) throw new Error(`hand ${h.id}: ${carry} chips with no eligible winner`);
    this.s.lastResult = {
      handId: h.id,
      totals: Object.fromEntries(h.players.map((p) => [p.seat, p.total])),
      won,
    };
    this.events.push({ type: "HandEnded", handId: h.id });
    for (const p of h.players) {
      const seat = this.s.seats[p.seat]!;
      if (seat.stack === 0 && !seat.busted) {
        seat.busted = true;
        this.events.push({ type: "PlayerBusted", playerId: seat.playerId, seat: p.seat });
      }
    }
    this.s.hand = null;
    this.s.handsPlayed = h.id;
  }
}
