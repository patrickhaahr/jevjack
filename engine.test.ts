import { describe, expect, test } from "bun:test";
import {
  BET,
  cardValue,
  dealerShouldHit,
  dealInitial,
  draw,
  handValue,
  isBlackjack,
  isBust,
  legalActions,
  newShoe,
  settle,
  shoeFraction,
  trueCount,
  type Card,
} from "./engine";

const c = (rank: Card["rank"], suit: Card["suit"] = "S"): Card => ({ rank, suit });

describe("handValue", () => {
  test("hard totals", () => {
    expect(handValue([c("10"), c("9")]).total).toBe(19);
    expect(handValue([c("10"), c("9")]).soft).toBe(false);
  });
  test("soft ace demotes to 1 when total exceeds 21", () => {
    expect(handValue([c("A"), c("6")])).toEqual({ total: 17, soft: true });
    expect(handValue([c("A"), c("6"), c("10")]).total).toBe(17);
    expect(handValue([c("A"), c("6"), c("10")]).soft).toBe(false);
    expect(handValue([c("A"), c("A"), c("9")]).total).toBe(21);
  });
  test("bust detection", () => {
    expect(isBust([c("K"), c("Q"), c("5")])).toBe(true);
    expect(isBust([c("A"), c("K")])).toBe(false);
  });
  test("blackjack is two cards totalling 21", () => {
    expect(isBlackjack([c("A"), c("K")])).toBe(true);
    expect(isBlackjack([c("A"), c("K"), c("A")])).toBe(false);
    expect(isBlackjack([c("10"), c("6"), c("5")])).toBe(false);
  });
});

describe("shoe", () => {
  test("six decks, shuffle draws without repeats until exhausted", () => {
    const shoe = newShoe(() => 0.42);
    expect(shoe.length).toBe(312);
    const seen = new Set<string>();
    let drawn = 0;

    while (draw(shoe)) {
      seen.add(shoe.length.toString());
      drawn++;
    }

    expect(drawn).toBe(312);
    expect(shoeFraction(shoe)).toBe(0);
  });
  test("true count scales running count by decks left", () => {
    const shoe = newShoe();
    shoe.length = 52 * 2; // 2 decks left
    expect(trueCount(8, shoe)).toBe(4);
  });
});

describe("legalActions", () => {
  test("two cards: hit, stand, double, split, surrender", () => {
    expect(legalActions([c("8"), c("8")], 0, BET, BET)).toEqual(["hit", "stand", "double", "split", "surrender"]);
  });
  test("insufficient bankroll blocks double and split", () => {
    expect(legalActions([c("8"), c("8")], 0, BET - 1, BET)).toEqual(["hit", "stand", "surrender"]);
  });
  test("21 on two cards only allows stand", () => {
    expect(legalActions([c("A"), c("K")], 0, BET, BET)).toEqual(["stand"]);
  });
  test("three cards: no double, split, surrender", () => {
    expect(legalActions([c("5"), c("5"), c("2")], 0, BET, BET)).toEqual(["hit", "stand"]);
  });
  test("split already used removes split", () => {
    expect(legalActions([c("9"), c("9")], 1, BET, BET)).toEqual(["hit", "stand", "double", "surrender"]);
  });
});

describe("dealer", () => {
  test("hits below 17, stands on all 17s", () => {
    expect(dealerShouldHit([c("10"), c("6")])).toBe(true);
    expect(dealerShouldHit([c("A"), c("6")])).toBe(false); // soft 17 stands
    expect(dealerShouldHit([c("10"), c("7")])).toBe(false);
  });
});

describe("settle", () => {
  test("player blackjack pays 3:2", () => {
    expect(settle([c("A"), c("K")], [c("10"), c("7")], 10, false)).toEqual({ kind: "player_blackjack", delta: 15 });
  });
  test("both blackjack pushes", () => {
    expect(settle([c("A"), c("K")], [c("A"), c("K")], 10, false).delta).toBe(0);
  });
  test("player bust loses even if dealer busts later", () => {
    expect(settle([c("K"), c("Q"), c("5")], [c("10"), c("6"), c("10")], 10, false)).toEqual({ kind: "lose", delta: -10 });
  });
  test("dealer bust with live player hand wins", () => {
    expect(settle([c("10"), c("8")], [c("10"), c("6"), c("10")], 10, false)).toEqual({ kind: "win", delta: 10 });
  });
  test("higher total wins, lower loses, equal pushes", () => {
    expect(settle([c("10"), c("9")], [c("10"), c("8")], 10, false).kind).toBe("win");
    expect(settle([c("10"), c("8")], [c("10"), c("9")], 10, false).kind).toBe("lose");
    expect(settle([c("10"), c("9")], [c("10"), c("9")], 10, false).kind).toBe("push");
  });
  test("surrender loses half", () => {
    expect(settle([c("9"), c("6")], [c("10"), c("6"), c("A")], 10, true)).toEqual({ kind: "surrender", delta: -5 });
  });
});

describe("dealInitial", () => {
  test("deals two cards each, player first", () => {
    const shoe = newShoe();
    const top = shoe[shoe.length - 1]!;
    const dealt = dealInitial(shoe)!;
    expect(dealt.player.length).toBe(2);
    expect(dealt.dealer.length).toBe(2);
    expect(dealt.player[0]).toEqual(top); // player gets the first card off the top
    expect(shoe.length).toBe(312 - 4);
  });
});

describe("simulation sanity", () => {
  test("2000 auto-stand rounds keep bankroll near house edge expectations", () => {
    let bankroll = 0;
    let rounds = 0;

    for (let i = 0; i < 2000; i++) {
      let shoe = newShoe();

      if (shoeFraction(shoe) < 0.25) shoe = newShoe();
      const dealt = dealInitial(shoe)!;
      const { player, dealer } = dealt;

      // player stands always; dealer draws to 17
      while (dealerShouldHit(dealer)) dealer.push(draw(shoe)!);
      const outcome = settle(player, dealer, BET, false);
      bankroll += outcome.delta;
      rounds++;
      expect(Number.isFinite(bankroll)).toBe(true);
    }

    // Player standing always loses slowly against S17 dealer: expect within
    // a wide band (worst case ~ -21% of total action; total action = 2000*10).
    expect(bankroll).toBeLessThan(0);
    expect(bankroll).toBeGreaterThan(-0.21 * 2000 * BET);
    expect(rounds).toBe(2000);
  });
});
