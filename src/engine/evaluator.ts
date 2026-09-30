import { type Card, rankOf, suitOf } from "./cards.ts";

// Best five-card hand out of five to seven cards, as a number where bigger
// wins and equal numbers split. Category in the top digit, then kickers in
// base 13.
export enum Category {
  HighCard,
  Pair,
  TwoPair,
  Trips,
  Straight,
  Flush,
  FullHouse,
  Quads,
  StraightFlush,
}

const B = 13;
const score = (cat: Category, ranks: number[]) =>
  ranks.reduce((acc, r) => acc * B + r, cat) * B ** (5 - ranks.length);

function straightHigh(ranks: Set<number>): number {
  for (let hi = 12; hi >= 3; hi--) {
    // hi = 3 wraps to the ace: the wheel, A-2-3-4-5.
    const need = [0, 1, 2, 3, 4].map((k) => (hi - k + 13) % 13);
    if (need.every((r) => ranks.has(r))) return hi;
  }
  return -1;
}

function five(cards: Card[]): number {
  const ranks = cards.map(rankOf);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const hi = straightHigh(new Set(ranks));
  if (hi >= 0 && new Set(ranks).size === 5) return score(flush ? Category.StraightFlush : Category.Straight, [hi]);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const order = groups.map(([r]) => r);
  const shape = groups.map(([, n]) => n).join("");
  if (flush) return score(Category.Flush, [...ranks].sort((a, b) => b - a));
  switch (shape) {
    case "41":
      return score(Category.Quads, order);
    case "32":
      return score(Category.FullHouse, order);
    case "311":
      return score(Category.Trips, order);
    case "221":
      return score(Category.TwoPair, order);
    case "2111":
      return score(Category.Pair, order);
    default:
      return score(Category.HighCard, order);
  }
}

export function evaluate(cards: Card[]): number {
  if (cards.length < 5 || cards.length > 7) throw new Error("need 5 to 7 cards");
  let best = -1;
  const pick: Card[] = [];
  const walk = (from: number) => {
    if (pick.length === 5) {
      best = Math.max(best, five(pick));
      return;
    }
    for (let i = from; i <= cards.length - (5 - pick.length); i++) {
      pick.push(cards[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best;
}

export const categoryOf = (s: number): Category => Math.floor(s / B ** 5);
