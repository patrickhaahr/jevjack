/**
 * Pure blackjack rules. Code owns the shoe, the hands, and every payout; the
 * model only chooses actions. One player hand at a time (a split plays as two
 * sequential hands). All functions are pure over explicit state.
 */

export type Suit = "S" | "H" | "D" | "C";

export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export type PlayerAction = "hit" | "stand" | "double" | "split" | "surrender";

/** Settled outcome of one hand, with its effect on the bankroll. */
export type HandOutcome =
  | { readonly kind: "player_blackjack"; readonly delta: number } // +1.5x bet
  | { readonly kind: "win"; readonly delta: number } // +1x bet (or 2x after double)
  | { readonly kind: "push"; readonly delta: number }
  | { readonly kind: "lose"; readonly delta: number } // -bet
  | { readonly kind: "surrender"; readonly delta: number } // -0.5x bet
  | { readonly kind: "dealer_blackjack"; readonly delta: number }; // -bet

export const SHOE_DECKS = 6;

/** Reshuffle when this fraction of the shoe has been dealt. */
export const PENETRATION = 0.75;

export const BET = 10;

/** Card value in blackjack points; aces count as 11 until soft totals say otherwise. */
export function cardValue(rank: Rank): number {
  if (rank === "A") return 11;

  if (rank === "K" || rank === "Q" || rank === "J" || rank === "10") return 10;

  return Number(rank);
}

/** Best total <= 21 for the given cards, plus whether that total is soft. */
export function handValue(cards: readonly Card[]) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    total += cardValue(card.rank);

    if (card.rank === "A") aces++;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  return { total, soft: aces > 0 };
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

/** Fresh shuffled 6-deck shoe. */
export function newShoe(random: () => number = Math.random): Card[] {
  const shoe: Card[] = [];

  for (let d = 0; d < SHOE_DECKS; d++) {
    for (const suit of ["S", "H", "D", "C"] as const) {
      for (const rank of ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const) {
        shoe.push({ rank, suit });
      }
    }
  }

  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = shoe[i]!;
    shoe[i] = shoe[j]!;
    shoe[j] = tmp;
  }

  return shoe;
}

/** Remove and return the top card; caller reshuffles on `undefined`. */
export function draw(shoe: Card[]): Card | undefined {
  return shoe.pop();
}

/** Deal two cards each, player first, matching real table order. */
export function dealInitial(
  shoe: Card[],
): { player: Card[]; dealer: Card[] } | undefined {
  const player: Card[] = [];
  const dealer: Card[] = [];

  for (const card of [draw(shoe), draw(shoe)]) {
    if (!card) return undefined;
    player.push(card);
  }

  for (const card of [draw(shoe), draw(shoe)]) {
    if (!card) return undefined;
    dealer.push(card);
  }

  return { player, dealer };
}

/** Cards remaining as a fraction of the shoe (0..1), for state and reshuffle checks. */
export function shoeFraction(shoe: readonly Card[]): number {
  return shoe.length / (SHOE_DECKS * 52);
}

/** Running count contribution (Hi-Lo): low cards +1, high cards -1. */
export function hiLo(card: Card): number {
  const v = cardValue(card.rank);

  if (v >= 2 && v <= 6) return 1;

  if (v >= 10) return -1;

  return 0;
}

/** True count from the running count over the remaining shoe. */
export function trueCount(running: number, shoe: readonly Card[]): number {
  const decksLeft = shoe.length / 52;

  if (decksLeft < 0.25) return running;

  return running / decksLeft;
}

/** Legal actions given the current hand. Split needs a pair and available bankroll. */
export function legalActions(
  player: readonly Card[],
  splitsUsed: number,
  bankroll: number,
  bet: number,
): PlayerAction[] {
  if (isBust(player)) return [];
  const actions: PlayerAction[] = ["hit", "stand"];
  const { total } = handValue(player);
  const firstTwo = player.length === 2;

  if (firstTwo && total === 21) return ["stand"]; // blackjack or made 21

  if (firstTwo && bankroll >= bet) actions.push("double");

  if (firstTwo && splitsUsed === 0 && player[0]!.rank === player[1]!.rank && bankroll >= bet) {
    actions.push("split");
  }

  if (firstTwo) actions.push("surrender");

  return actions;
}

/**
 * Settle a completed round. Dealer hole card is already revealed and the dealer
 * has finished drawing per stands-on-soft-17.
 */
export function settle(
  player: readonly Card[],
  dealer: readonly Card[],
  bet: number,
  surrendered: boolean,
): HandOutcome {
  if (surrendered) return { kind: "surrender", delta: -bet / 2 };
  const p = handValue(player);
  const d = handValue(dealer);
  const playerBJ = isBlackjack(player);
  const dealerBJ = isBlackjack(dealer);

  if (playerBJ && dealerBJ) return { kind: "push", delta: 0 };

  if (playerBJ) return { kind: "player_blackjack", delta: (bet * 3) / 2 };

  if (dealerBJ) return { kind: "dealer_blackjack", delta: -bet };

  if (p.total > 21) return { kind: "lose", delta: -bet };

  if (d.total > 21) return { kind: "win", delta: bet };

  if (p.total > d.total) return { kind: "win", delta: bet };

  if (p.total < d.total) return { kind: "lose", delta: -bet };

  return { kind: "push", delta: 0 };
}

/** Dealer draws to 16, stands on all 17s including soft (S17). */
export function dealerShouldHit(dealer: readonly Card[]): boolean {
  return handValue(dealer).total < 17;
}
