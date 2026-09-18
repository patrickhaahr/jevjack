/**
 * Side-by-side A/B eval: runs the same number of hands with the basic-strategy
 * helper ON, OFF, and with the mock reference model, all on the same seeded
 * shoe sequence. Reports net result, final bankroll, and how often each mode
 * deviated from the code-computed advice.
 *
 *     bun run eval.ts [hands]
 */

import { basicStrategyAction, JevModel, MockModel, type JevState, type Model } from "./jev";
import { Game } from "./game";

const HANDS = Number(process.argv[2] ?? 150);

const START_BANKROLL = 1000;

/** Seeded RNG (mulberry32) so all three modes start on the identical shoe. */
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

interface ModeStats {
  tag: string;
  hands: number;
  net: number;
  decisions: number;
  deviations: number;
}

async function runMode(tag: string, model: Model): Promise<ModeStats> {
  const stats: ModeStats = { tag, hands: HANDS, net: 0, decisions: 0, deviations: 0 };

  const tracked: Model = {
    name: model.name,
    usesAdvice: model.usesAdvice,

    async decide(state: JevState) {
      const advice = state.basicStrategy ?? basicStrategyAction(state);
      const decision = await model.decide(state);
      stats.decisions++;

      if (decision.action !== advice && state.legalActions.includes(advice)) stats.deviations++;

      return decision as Awaited<ReturnType<Model["decide"]>>;
    },
  };

  const game = new Game(tracked, seeded(20260918));

  game.onEvent((e) => {
    if (e.kind === "hand_end" && e.outcome) stats.net += e.outcome.delta;
  });

  for (let i = 0; i < HANDS; i++) await game.playHand();

  return stats;
}

const results = await Promise.all([
  runMode("advice-on", new JevModel(true)),
  runMode("advice-off", new JevModel(false)),
  runMode("mock", new MockModel()),
]);

console.log("mode        hands  net      final    deviations  decisions");
for (const r of results) {
  console.log(
    `${r.tag.padEnd(12)}${String(r.hands).padEnd(7)}${String(r.net).padEnd(9)}$${String(r.net + START_BANKROLL).padEnd(9)}${String(r.deviations).padEnd(12)}${r.decisions}`,
  );
}
