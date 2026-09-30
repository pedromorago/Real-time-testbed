import type { Command, TableEvent, TableState } from "./types.ts";

const BOARD: Record<string, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

// Properties that must hold for every state the table can reach, whatever
// the players do. Returns the ones that don't.
export function checkState(s: TableState): string[] {
  const out: string[] = [];
  const seated = s.seats.filter((x) => x !== null);
  for (const [i, x] of s.seats.entries()) {
    if (x && (!Number.isInteger(x.stack) || x.stack < 0)) out.push(`seat ${i} has stack ${x.stack}`);
    if (x && x.busted !== (x.stack === 0) && !s.hand?.players.some((p) => p.seat === i))
      out.push(`seat ${i} busted=${x.busted} with stack ${x.stack}`);
  }
  const ids = seated.map((x) => x.playerId);
  if (new Set(ids).size !== ids.length) out.push(`a player holds two seats: ${ids.join(",")}`);

  const h = s.hand;
  const inPot = h ? h.players.reduce((n, p) => n + p.total, 0) : 0;
  const onTable = seated.reduce((n, x) => n + x.stack, 0) + inPot;
  if (onTable !== s.ledger) out.push(`chips not conserved: ${onTable} on the table, ${s.ledger} bought in`);

  if (h) {
    if (h.toAct === null) out.push(`hand ${h.id} is waiting for nobody`);
    if (h.board.length !== BOARD[h.street]) out.push(`${h.board.length} board cards on the ${h.street}`);
    const cards = [...h.board, ...h.players.flatMap((p) => p.hole)];
    if (new Set(cards).size !== cards.length) out.push(`hand ${h.id} deals a card twice`);
    for (const p of h.players) {
      const seat = s.seats[p.seat];
      if (!seat) {
        out.push(`seat ${p.seat} is in the hand but empty`);
        continue;
      }
      if (seat.busted) out.push(`busted seat ${p.seat} was dealt in`);
      if (p.bet > h.currentBet) out.push(`seat ${p.seat} bet ${p.bet} above the current bet ${h.currentBet}`);
      if (p.bet > p.total) out.push(`seat ${p.seat} bet more on this street than in the hand`);
      if (p.allIn !== (seat.stack === 0)) out.push(`seat ${p.seat} allIn=${p.allIn} with stack ${seat.stack}`);
    }
    const actor = h.players.find((p) => p.seat === h.toAct);
    if (h.toAct !== null && (!actor || actor.folded || actor.allIn)) out.push(`seat ${h.toAct} can't act but has the turn`);
  }

  // Nobody wins more from a pot than they could have lost to it.
  const r = s.lastResult;
  if (r) {
    for (const [seat, won] of Object.entries(r.won)) {
      const own = r.totals[+seat];
      const cap = Object.values(r.totals).reduce((n, t) => n + Math.min(t, own), 0);
      if (won > cap) out.push(`hand ${r.handId}: seat ${seat} won ${won}, more than the ${cap} it could contest`);
    }
  }
  return out;
}

// Properties of a single transition.
export function checkStep(prev: TableState, cmd: Command, next: TableState, events: TableEvent[]): string[] {
  const out: string[] = [];
  const ph = prev.hand;
  const nh = next.hand;
  if (nh && ph && nh.id === ph.id) {
    const order = ["preflop", "flop", "turn", "river"];
    if (order.indexOf(nh.street) < order.indexOf(ph.street)) out.push(`hand ${nh.id} went back to the ${nh.street}`);
    if (nh.turn < ph.turn) out.push(`hand ${nh.id} turn went back`);
  }
  if (nh && (!ph || nh.id !== ph.id) && nh.id !== prev.handsPlayed + 1) out.push(`hand ${nh.id} follows hand ${prev.handsPlayed}`);
  for (const e of events) {
    if (e.type !== "ActionTaken") continue;
    if (ph?.id === e.handId && ph.toAct !== null && e === events.find((x) => x.type === "ActionTaken") && ph.toAct !== e.seat)
      out.push(`seat ${e.seat} acted on seat ${ph.toAct}'s turn`);
    const seat = prev.seats[e.seat];
    if (seat?.busted) out.push(`busted seat ${e.seat} acted`);
  }
  if (cmd.type === "act") {
    const acted = events.filter((e) => e.type === "ActionTaken" && !e.timeout);
    if (acted.length > 1) out.push(`one command applied ${acted.length} actions`);
  }
  return out;
}
