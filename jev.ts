/**
 * The player's brain. One TypeSafe request per decision: `action` picks the
 * move, `win_probability` and `hand_quality` are speculative scores in the same
 * call that power the UI. Code validates legality and executes.
 */

import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  cardValue,
  handValue,
  shoeFraction,
  trueCount,
  type Card,
  type PlayerAction,
} from "./engine";

/** The table as the model sees it. Built only by buildJevState, so values stay JSON-safe. */
export interface JevState {
  playerCards: string[];
  playerTotal: number;
  playerSoft: boolean;
  legalActions: PlayerAction[];
  dealerUpcard: string;
  bet: number;
  bankroll: number;
  bankrollStart: number;
  shoeFraction: number;
  trueCount: number;
  handsPlayed: number;
  recentOutcomes: string[];
}

export interface JevDecision {
  action: PlayerAction;
  probabilities: Record<string, number>;
  confidence: number;
  winProbability: number;
  handQuality: number;
  latencyMs: number;
  inputTokens: number;
  model: string;
}

const ACTION_QUESTION = choice(
  {
    question: "Which action should the player take right now?",
    goal: "Play the player's hand in this blackjack round to maximize expected bankroll. Cards settle when the player stands, busts, doubles, or surrenders.",
    rules: "Act only on the state fields. `playerTotal` is the best total of `playerCards` (aces count 11 unless that busts); `playerSoft` means an ace still counts as 11. Choose only from `legalActions`; anything else cannot execute. `dealerUpcard` shows only the dealer's face-up card. `trueCount` and `shoeFraction` describe the remaining shoe; a high positive `trueCount` favors big cards remaining.",
  },
  {
    hit: "Take another card. Chosen when the current total is too weak to stand against `dealerUpcard`.",
    stand: "Keep the current total and end the hand. Chosen when drawing risks busting more than it helps.",
    double: "Double the bet, take exactly one card, and stand. Only when `legalActions` includes it: a strong two-card draw against a weak dealer upcard.",
    split: "Split a pair into two hands. Only when `legalActions` includes it: two cards of the same rank that play better apart than together.",
    surrender: "Forfeit half the bet and end the hand. Only when `legalActions` includes it: a weak hand against a strong dealer upcard.",
  },
);

const QUESTIONS = {
  action: ACTION_QUESTION,
  win_probability: score(
    "How likely is the player to win or push this round with a well-played hand?",
    ["Almost certain loss", "Probably lose", "Roughly even", "Probably win", "Almost certain win"],
  ),
  hand_quality: score(
    "How strong is the player's current hand position right now?",
    [
      "Very weak: bust risk or near-certain loss",
      "Weak: low total that must draw",
      "Playable: decent total or a strong draw",
      "Strong: 19 to 21, or blackjack",
    ],
  ),
} as const;

export function cardLabel(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function buildJevState(args: {
  player: readonly Card[];
  dealerUpcard: Card;
  legalActions: readonly PlayerAction[];
  bet: number;
  bankroll: number;
  bankrollStart: number;
  shoe: readonly Card[];
  runningCount: number;
  handsPlayed: number;
  recentOutcomes: readonly string[];
}): JevState {
  const { total, soft } = handValue(args.player);

  return {
    playerCards: args.player.map(cardLabel),
    playerTotal: total,
    playerSoft: soft,
    legalActions: [...args.legalActions],
    dealerUpcard: cardLabel(args.dealerUpcard),
    bet: args.bet,
    bankroll: args.bankroll,
    bankrollStart: args.bankrollStart,
    shoeFraction: Math.round(shoeFraction(args.shoe) * 100) / 100,
    trueCount: Math.round(trueCount(args.runningCount, args.shoe) * 10) / 10,
    handsPlayed: args.handsPlayed,
    recentOutcomes: [...args.recentOutcomes],
  };
}

export interface Model {
  readonly name: string;
  decide(state: JevState): Promise<JevDecision>;
}

/** Real Jev through the TypeSafe SDK. */
class JevModel implements Model {
  readonly name = "jev";
  private client = new TypeSafeClient();

  async decide(state: JevState): Promise<JevDecision> {
    const t0 = performance.now();

    const result = await this.client.systemOne({
      // The JSON round trip proves the state is JSON-safe, which is what the SDK's state field accepts.
      state: JSON.parse(JSON.stringify(state)),
      questions: QUESTIONS,
      // ponytail: no per-call tuning; SDK defaults carry retry/backoff at one request per decision
    });

    const action = result.answers.action;
    const win = result.answers.win_probability;

    return {
      action: action.choice,
      probabilities: { ...action.probabilities },
      confidence: action.confidence,
      winProbability: win.score / 4,
      handQuality: result.answers.hand_quality.score,
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: result.usage.input_tokens,
      model: result.model,
    };
  }
}

/** Offline stand-in so the loop, SSE, and UI run without the API. */
class MockModel implements Model {
  readonly name = "mock";

  async decide(state: JevState): Promise<JevDecision> {
    const t0 = performance.now();
    const action = this.basicStrategy(state);
    const top = Math.min(0.94, Math.max(0.5, 0.55 + (state.playerTotal - 12) * 0.04));
    const rest = 1 - top;
    const probabilities: Record<string, number> = {};
    const others = state.legalActions.filter((a) => a !== action);
    probabilities[action] = top;

    for (const a of others) probabilities[a] = rest / Math.max(1, others.length);

    return {
      action,
      probabilities,
      confidence: top,
      winProbability: this.winProbability(state),
      handQuality: state.playerTotal >= 19 ? 3 : state.playerTotal >= 17 ? 2.2 : state.playerTotal <= 11 ? 1 : 1.6,
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: Math.round(JSON.stringify(state).length / 4),
      model: this.name,
    };
  }

  private rankOf(label: string): Card["rank"] {
    // SAFETY: labels come from cardLabel over real Cards, so "10" or the first character is a valid rank.
    return (label.startsWith("10") ? "10" : label[0]!) as Card["rank"];
  }

  private upValue(label: string): number {
    return cardValue(this.rankOf(label));
  }

  private winProbability(state: JevState): number {
    const up = this.upValue(state.dealerUpcard);
    const total = state.playerTotal;

    if (total > 21) return 0.05;

    if (total >= 19) return 0.72;

    if (total >= 17) return 0.55 - up * 0.02;

    if (total >= 13) return up <= 6 ? 0.42 : 0.32;

    return up <= 6 ? 0.35 : 0.24;
  }

  private basicStrategy(state: JevState): PlayerAction {
    const up = this.upValue(state.dealerUpcard);
    const soft = state.playerSoft;
    const total = state.playerTotal;
    const can = (a: PlayerAction): boolean => state.legalActions.includes(a);

    if (can("surrender") && ((total === 16 && up >= 9) || (total === 15 && up === 10))) return "surrender";

    if (can("split") && state.playerCards.length === 2) {
      const v = cardValue(this.rankOf(state.playerCards[0]!));

      if (v === 8 || v === 11 || (v === 9 && up !== 7 && up !== 10)) return "split";
    }

    if (total >= 17) return "stand";

    if (soft && total === 18) return up >= 9 ? "hit" : up >= 3 && can("double") ? "double" : "stand";

    if (soft) return "hit";

    if (total >= 13 && up <= 6) return "stand";

    if (total === 12 && up >= 4 && up <= 6) return "stand";

    if (can("double") && (total === 11 || (total === 10 && up <= 9))) return "double";

    return "hit";
  }
}

export function createModel(): Model {
  return process.env.MODEL === "jev" ? new JevModel() : new MockModel();
}
