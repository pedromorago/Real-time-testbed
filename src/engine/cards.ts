// A card is an integer 0..51: rank * 4 + suit, rank 0 = deuce .. 12 = ace.
export type Card = number;

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";

export const rankOf = (c: Card) => c >> 2;
export const suitOf = (c: Card) => c & 3;

export function cardStr(c: Card): string {
  return RANKS[rankOf(c)] + SUITS[suitOf(c)];
}

export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const u = SUITS.indexOf(s[1].toLowerCase());
  if (s.length !== 2 || r < 0 || u < 0) throw new Error(`bad card: ${s}`);
  return r * 4 + u;
}

export function parseCards(s: string): Card[] {
  return (s.match(/\S\S/g) ?? []).map(parseCard);
}

// Small, fast, seedable PRNG (mulberry32). Same seed, same deck, same replay.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffledDeck(seed: number): Card[] {
  const next = rng(seed);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
