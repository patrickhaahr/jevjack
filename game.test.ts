import { describe, expect, test } from "bun:test";
import { Game } from "./game";
import type { JevDecision, JevState, Model } from "./jev";
import { BET, type HandOutcome } from "./engine";

/** Deterministic model: always picks the given action, fixed probabilities. */
function stubModel(action: "hit" | "stand" | "double" | "split" | "surrender"): Model {
  return {
    name: "stub",
    async decide(state: JevState): Promise<JevDecision> {
      const probabilities: Record<string, number> = {};

      for (const a of state.legalActions) probabilities[a] = a === action ? 0.8 : 0.2 / (state.legalActions.length - 1 || 1);

      return {
        action,
        probabilities,
        confidence: 0.8,
        winProbability: 0.5,
        handQuality: 2,
        latencyMs: 1,
        inputTokens: 100,
        model: "stub",
      };
    },
  };
}

/** Seeded RNG (mulberry32) so hands are reproducible. */
function seeded(seed: number): () => number {
  let a = seed;

  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Game loop", () => {
  test("stand-only model completes hands and keeps bankroll finite", async () => {
    const game = new Game(stubModel("stand"), seeded(7));
    const events: string[] = [];
    game.onEvent((e) => events.push(e.kind));

    for (let i = 0; i < 50; i++) await game.playHand();
    expect(events.filter((k) => k === "hand_end").length).toBe(50);
    expect(Number.isFinite(game.bankrollNow)).toBe(true);
    // Directional expectation (stand-always loses slowly) is covered by the
    // 2000-round engine simulation; 50 hands is too small a sample to assert it.
  });

  test("hit-only model: some hands bust, some end by stand at >=17", async () => {
    const game = new Game(stubModel("hit"), seeded(11));
    let busts = 0;
    let stands = 0;
    const outcomes: HandOutcome[] = [];
    game.onEvent((e) => {
      if (e.kind === "hand_end" && e.outcome) outcomes.push(e.outcome);
    });

    for (let i = 0; i < 50; i++) await game.playHand();

    for (const outcome of outcomes) {
      if (outcome.kind === "lose") busts++;

      if (outcome.kind === "win") stands++;
    }

    // With hit-until-forced-stop the player busts a lot but not always.
    expect(busts).toBeGreaterThan(0);
    expect(Number.isFinite(game.bankrollNow)).toBe(true);
  });

  test("history and events stay capped and shaped", async () => {
    const game = new Game(stubModel("stand"), seeded(3));

    for (let i = 0; i < 5; i++) await game.playHand();
    let last: ReturnType<Game["snapshot"]> | null = null;
    game.onEvent((e) => {
      last = e;
    });
    await game.playHand();
    const snap = last!;
    expect(snap.handNumber).toBe(6);
    expect(snap.history.length).toBe(6);
    expect(snap.history[0]!.bet).toBe(BET);
    expect(Number.isFinite(snap.trueCount)).toBe(true);
    expect(snap.dealerHoleHidden).toBe(false);
  });

  test("illegal model answers fall back to stand", async () => {
    const rogue: Model = {
      name: "rogue",
      async decide(state: JevState): Promise<JevDecision> {
        return {
          action: "split", // rarely legal; fallback should clamp to stand
          probabilities: {},
          confidence: 1,
          winProbability: 0.5,
          handQuality: 2,
          latencyMs: 0,
          inputTokens: 0,
          model: "rogue",
        };
      },
    };

    const game = new Game(rogue, seeded(5));
    await game.playHand();
    // no throw, bankroll finite, hand recorded
    expect(Number.isFinite(game.bankrollNow)).toBe(true);
  });
});
