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
} from "../engine/engine";

/** The table as the model sees it. Built only by buildJevState, so values stay JSON-safe. */
export interface JevState {
  playerCards: string[];
  playerTotal: number;
  playerSoft: boolean;
  legalActions: PlayerAction[];
  /** Code-computed EV-optimal action on a neutral shoe. Omitted when the advice toggle is off. */
  basicStrategy?: PlayerAction;
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

const BASE_RULES =
  "Act only on the state fields. `playerTotal` is the best total of `playerCards` (aces count 11 unless that busts); `playerSoft` means an ace still counts as 11. Choose only from `legalActions`; anything else cannot execute. `dealerUpcard` shows only the dealer's face-up card. `trueCount` and `shoeFraction` describe the remaining shoe; a high positive `trueCount` favors big cards remaining.";

const ADVICE_RULES = `${BASE_RULES} \`basicStrategy\` is the code-computed mathematically optimal action for this total against \`dealerUpcard\` when the shoe is neutral; default to it. Deviate only when the remaining-shoe composition justifies it: a strongly positive \`trueCount\` means big cards remain (stand more, double and split more aggressively), a strongly negative one means small cards remain (hit more cautiously). Deviation needs a real edge, not a hunch.`;

const ACTION_CRITERIA = {
  hit: "Take another card. Chosen when the current total is too weak to stand against `dealerUpcard`.",
  stand: "Keep the current total and end the hand. Chosen when drawing risks busting more than it helps.",
  double: "Double the bet, take exactly one card, and stand. Only when `legalActions` includes it: a strong two-card draw against a weak dealer upcard.",
  split: "Split a pair into two hands. Only when `legalActions` includes it: two cards of the same rank that play better apart than together.",
  surrender: "Forfeit half the bet and end the hand. Only when `legalActions` includes it: a weak hand against a strong dealer upcard, when losing half is better than the likely outcome.",
} as const;

const WIN_SCORE = score(
  "How likely is the player to win or push this round with a well-played hand?",
  ["Almost certain loss", "Probably lose", "Roughly even", "Probably win", "Almost certain win"],
);

const QUALITY_SCORE = score(
  "How strong is the player's current hand position right now?",
  [
    "Very weak: bust risk or near-certain loss",
    "Weak: low total that must draw",
    "Playable: decent total or a strong draw",
    "Strong: 19 to 21, or blackjack",
  ],
);

function questions(withAdvice: boolean) {
  return {
    action: choice(
      {
        question: "Which action should the player take right now?",
        goal: "Play the player's hand in this blackjack round to maximize expected bankroll. Cards settle when the player stands, busts, doubles, or surrenders.",
        rules: withAdvice ? ADVICE_RULES : BASE_RULES,
      },
      ACTION_CRITERIA,
    ),
    win_probability: WIN_SCORE,
    hand_quality: QUALITY_SCORE,
  } as const;
}

const ADVICE_QUESTIONS = questions(true);

const FREE_QUESTIONS = questions(false);

export function cardLabel(card: Card): string {
  return `${card.rank}${card.suit}`;
}

/**
 * Code-computed basic strategy: the EV-optimal action for the total against
 * the upcard on a neutral shoe. Serves as the state's `basicStrategy` advice
 * for Jev and as the mock model's whole policy.
 */
export function basicStrategyAction(s: {
  playerTotal: number;
  playerSoft: boolean;
  dealerUpcard: string;
  playerCards: readonly string[];
  legalActions: readonly PlayerAction[];
}): PlayerAction {
  const up = cardValue(rankOfLabel(s.dealerUpcard));
  const soft = s.playerSoft;
  const total = s.playerTotal;
  const can = (a: PlayerAction): boolean => s.legalActions.includes(a);

  if (can("surrender") && ((total === 16 && up >= 9) || (total === 15 && up === 10))) return "surrender";

  if (can("split") && s.playerCards.length === 2) {
    const v = cardValue(rankOfLabel(s.playerCards[0]!));

    if (v === 8 || v === 11 || (v === 9 && up !== 7 && up !== 10)) return "split";
  }

  if (soft && total >= 19) return "stand";

  if (soft && total === 18) return up >= 9 ? "hit" : up >= 3 && can("double") ? "double" : "stand";

  if (soft) return "hit";

  if (total >= 17) return "stand";

  if (total >= 13 && up <= 6) return "stand";

  if (total === 12 && up >= 4 && up <= 6) return "stand";

  if (can("double") && (total === 11 || (total === 10 && up <= 9))) return "double";

  return "hit";
}

function rankOfLabel(label: string): Card["rank"] {
  // SAFETY: labels come from cardLabel over real Cards, so "10" or the first character is a valid rank.
  return (label.startsWith("10") ? "10" : label[0]!) as Card["rank"];
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
  /** When false the advice field is withheld so the model must play free-form. */
  advice?: boolean;
}): JevState {
  const { total, soft } = handValue(args.player);

  const state: JevState = {
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

  if (args.advice !== false) {
    state.basicStrategy = basicStrategyAction({
      playerTotal: total,
      playerSoft: soft,
      dealerUpcard: cardLabel(args.dealerUpcard),
      playerCards: args.player.map(cardLabel),
      legalActions: args.legalActions,
    });
  }

  return state;
}

export interface Model {
  readonly name: string;
  /** Whether the model wants the basic-strategy advice in its state. */
  readonly usesAdvice: boolean;
  decide(state: JevState): Promise<JevDecision>;
}

/** Real Jev through the TypeSafe SDK. `advice=false` plays free-form for A/B runs. */
export class JevModel implements Model {
  readonly name: string;
  readonly usesAdvice: boolean;
  private client = new TypeSafeClient();
  private questions: typeof ADVICE_QUESTIONS;

  constructor(usesAdvice = process.env.ADVICE !== "off") {
    this.usesAdvice = usesAdvice;
    this.name = usesAdvice ? "jev" : "jev-free";
    this.questions = usesAdvice ? ADVICE_QUESTIONS : FREE_QUESTIONS;
  }

  async decide(state: JevState): Promise<JevDecision> {
    const t0 = performance.now();

    const result = await this.client.systemOne({
      // The JSON round trip proves the state is JSON-safe, which is what the SDK's state field accepts.
      state: JSON.parse(JSON.stringify(state)),
      questions: this.questions,
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
      model: this.name,
    };
  }
}

/** Offline stand-in so the loop, SSE, and UI run without the API. */
export class MockModel implements Model {
  readonly name = "mock";
  readonly usesAdvice = true;

  async decide(state: JevState): Promise<JevDecision> {
    const t0 = performance.now();
    const action = basicStrategyAction(state);
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
}

export function createModel(): Model {
  return process.env.MODEL === "jev" ? new JevModel() : new MockModel();
}
