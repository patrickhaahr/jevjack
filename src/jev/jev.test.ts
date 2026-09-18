import { describe, expect, test } from "bun:test";
import { buildJevState, cardLabel, createModel } from "./jev";
import { BET, legalActions, newShoe, type Card } from "../engine/engine";

const c = (rank: Card["rank"], suit: Card["suit"] = "S"): Card => ({ rank, suit });

describe("buildJevState", () => {
  test("labels cards and computes totals", () => {
    const shoe = newShoe();

    const s = buildJevState({
      player: [c("A"), c("7")],
      dealerUpcard: c("10", "H"),
      legalActions: legalActions([c("A"), c("7")], 0, 100, BET),
      bet: BET,
      bankroll: 100,
      bankrollStart: 100,
      shoe,
      runningCount: 0,
      handsPlayed: 3,
      recentOutcomes: ["win", "lose"],
    });

    expect(s.playerCards).toEqual(["AS", "7S"]);
    expect(cardLabel(c("10", "D"))).toBe("10D");
    expect(s.playerTotal).toBe(18);
    expect(s.playerSoft).toBe(true);
    expect(s.legalActions).toContain("double");
    expect(s.recentOutcomes).toEqual(["win", "lose"]);
  });

  test("basicStrategy advice covers surrender and hit spots", () => {
    const base = {
      bet: BET,
      bankroll: 100,
      bankrollStart: 100,
      shoe: newShoe(),
      runningCount: 0,
      handsPlayed: 0,
      recentOutcomes: [],
    };

    // Hard 16 vs dealer 10 with surrender available: basic strategy surrenders.
    expect(buildJevState({
      player: [c("10"), c("6")],
      dealerUpcard: c("10", "H"),
      legalActions: ["hit", "stand", "surrender"],
      ...base,
    }).basicStrategy).toBe("surrender");

    // Soft 18 vs dealer 10: basic strategy hits.
    expect(buildJevState({
      player: [c("A"), c("7")],
      dealerUpcard: c("10", "H"),
      legalActions: ["hit", "stand", "double"],
      ...base,
    }).basicStrategy).toBe("hit");

    // Hard 12 vs dealer 6: basic strategy stands.
    expect(buildJevState({
      player: [c("8"), c("4")],
      dealerUpcard: c("6", "D"),
      legalActions: ["hit", "stand"],
      ...base,
    }).basicStrategy).toBe("stand");
  });
});

describe("MockModel", () => {
  // A local .env may set MODEL=jev; tests must stay offline and deterministic.
  process.env.MODEL = "mock";
  const model = createModel();

  test("hard 20 stands, hard 5 hits", async () => {
    const shoe = newShoe();

    const stand = await model.decide(buildJevState({
      player: [c("10"), c("K")],
      dealerUpcard: c("9"),
      legalActions: ["stand"],
      bet: BET,
      bankroll: 100,
      bankrollStart: 100,
      shoe,
      runningCount: 0,
      handsPlayed: 0,
      recentOutcomes: [],
    }));

    expect(stand.action).toBe("stand");
    expect(stand.probabilities["hit"]).toBeUndefined();

    const hit = await model.decide(buildJevState({
      player: [c("2"), c("3")],
      dealerUpcard: c("K"),
      legalActions: ["hit", "stand", "double", "surrender"],
      bet: BET,
      bankroll: 100,
      bankrollStart: 100,
      shoe,
      runningCount: 0,
      handsPlayed: 0,
      recentOutcomes: [],
    }));

    expect(hit.action).toBe("hit");
    expect(Object.keys(hit.probabilities).sort()).toEqual(["double", "hit", "stand", "surrender"]);
    const sum = Object.values(hit.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  test("probabilities only contain legal actions", async () => {
    const shoe = newShoe();

    const d = await model.decide(buildJevState({
      player: [c("5"), c("5"), c("2")],
      dealerUpcard: c("6"),
      legalActions: ["hit", "stand"],
      bet: BET,
      bankroll: 100,
      bankrollStart: 100,
      shoe,
      runningCount: 0,
      handsPlayed: 0,
      recentOutcomes: [],
    }));

    expect(Object.keys(d.probabilities).sort()).toEqual(["hit", "stand"]);
  });
});
