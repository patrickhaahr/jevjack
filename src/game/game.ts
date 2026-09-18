/**
 * The game loop. Owns the mutable table: shoe, hands, bankroll, history. Emits
 * one event per state change; the server forwards them over SSE. One model
 * decision per player action until the hand ends.
 */

import {
  BET,
  betForCount,
  dealerShouldHit,
  dealInitial,
  draw,
  hiLo,
  isBust,
  legalActions,
  newShoe,
  PENETRATION,
  settle,
  shoeFraction,
  trueCount,
  type Card,
  type HandOutcome,
  type PlayerAction,
} from "../engine/engine";
import { buildJevState, type JevDecision, type JevState, type Model } from "../jev/jev";

export type Phase = "idle" | "dealing" | "player" | "dealer" | "settled";

export interface HandRecord {
  hand: number;
  bet: number;
  actions: PlayerAction[];
  playerCards: string[];
  dealerCards: string[];
  outcome: HandOutcome["kind"];
  delta: number;
  bankrollAfter: number;
}

export interface TableEvent {
  kind: "hand_start" | "decision" | "hand_end" | "shoe_shuffle" | "error";
  phase: Phase;
  handNumber: number;
  bet: number;
  playerCards: string[];
  dealerCards: string[];
  dealerHoleHidden: boolean;
  bankroll: number;
  bankrollStart: number;
  legalActions: PlayerAction[];
  decision: JevDecision | null;
  outcome: HandOutcome | null;
  shoeFraction: number;
  trueCount: number;
  handsPlayed: number;
  history: HandRecord[];
  message?: string;
}

const START_BANKROLL = 1000;

const OUTCOME_WINDOW = 8;

const HISTORY_CAP = 100;

export class Game {
  private model: Model;
  private shoe: Card[] = newShoe(Math.random);
  private running = 0;
  private bankroll = START_BANKROLL;
  private handNumber = 0;
  private phase: Phase = "idle";
  private player: Card[] = [];
  private dealer: Card[] = [];
  private bet: number = BET;
  private splitsUsed = 0;
  private surrendered = false;
  private doubled = false;
  private hands: { cards: Card[]; bet: number; surrendered: boolean; actions: PlayerAction[] }[] = [];
  private decision: JevDecision | null = null;
  private outcome: HandOutcome | null = null;
  private history: HandRecord[] = [];
  private recentOutcomes: string[] = [];
  private takenActions: PlayerAction[] = [];
  private listeners = new Set<(e: TableEvent) => void>();

  constructor(model: Model, random: () => number = Math.random) {
    this.model = model;
    this.random = random;
    this.shoe = newShoe(this.random);
  }

  private random: () => number;

  onEvent(listener: (e: TableEvent) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.shoe = newShoe(this.random);
    this.running = 0;
    this.bankroll = START_BANKROLL;
    this.handNumber = 0;
    this.phase = "idle";
    this.player = [];
    this.dealer = [];
    this.hands = [];
    this.decision = null;
    this.outcome = null;
    this.history = [];
    this.recentOutcomes = [];
    this.takenActions = [];
    this.emit("hand_start");
  }

  /** Current table state as an event payload (SSE connect + HTTP peek). */
  snapshot(): TableEvent {
    return this.compose("hand_start");
  }

  async playHand(): Promise<void> {
    this.decision = null;
    this.outcome = null;
    this.surrendered = false;
    this.doubled = false;
    this.splitsUsed = 0;
    this.takenActions = [];
    this.hands = [];
    this.handNumber++;
    this.phase = "dealing";

    if (1 - shoeFraction(this.shoe) > PENETRATION) {
      this.shoe = newShoe(this.random);
      this.running = 0;
      this.emit("shoe_shuffle");
    }

    // Count-based bet, sized before the deal; the bankroll is the only ceiling.
    this.bet = Math.min(betForCount(trueCount(this.running, this.shoe)), this.bankroll);

    if (this.bankroll < BET) {
      this.send({ ...this.compose("error"), message: "Bankroll exhausted. Reset to keep playing." });

      return;
    }

    let dealt = dealInitial(this.shoe);

    if (!dealt) {
      this.shoe = newShoe(this.random);
      this.running = 0;
      this.emit("shoe_shuffle");
      dealt = dealInitial(this.shoe)!;
    }

    this.player = dealt.player;
    this.dealer = dealt.dealer;
    this.hands = [];

    for (const card of [...this.player, ...this.dealer]) this.running += hiLo(card);
    this.emit("hand_start");

    await this.playerPhase();

    const anyLive = this.hands.some((h) => !h.surrendered && !isBust(h.cards));

    if (anyLive) {
      this.phase = "dealer";
      this.emit("hand_start");

      while (dealerShouldHit(this.dealer)) {
        const card = draw(this.shoe);

        if (!card) break;
        this.dealer.push(card);
        this.running += hiLo(card);
      }
    }

    this.phase = "settled";

    for (const hand of this.hands) {
      this.player = hand.cards;
      this.doubled = hand.bet !== this.bet;
      this.surrendered = hand.surrendered;
      this.outcome = settle(hand.cards, this.dealer, hand.bet, hand.surrendered);
      this.bankroll += this.outcome.delta;
      this.recentOutcomes = [...this.recentOutcomes, this.outcome.kind].slice(-OUTCOME_WINDOW);
      this.history = [
        ...this.history,
        {
          hand: this.handNumber,
          bet: hand.bet,
          actions: [...hand.actions],
          playerCards: hand.cards.map((card) => `${card.rank}${card.suit}`),
          dealerCards: this.dealer.map((card) => `${card.rank}${card.suit}`),
          outcome: this.outcome.kind,
          delta: this.outcome.delta,
          bankrollAfter: this.bankroll,
        },
      ].slice(-HISTORY_CAP);
      this.emit("hand_end");
    }
  }

  private async playerPhase(): Promise<void> {
    this.phase = "player";
    const hands: { cards: Card[]; bet: number; surrendered: boolean; actions: PlayerAction[] }[] = [
      { cards: this.player, bet: this.bet, surrendered: false, actions: [] },
    ];

    for (let i = 0; i < hands.length; i++) {
      const hand = hands[i]!;
      this.player = hand.cards;
      this.bet = hand.bet;
      this.doubled = false;
      this.surrendered = false;
      this.takenActions = hand.actions;

      await this.decideLoop(hands);

      hand.cards = this.player;
      hand.bet = this.currentBet();
      hand.surrendered = this.surrendered;
    }

    this.hands = hands;
  }

  private async decideLoop(
    hands: { cards: Card[]; bet: number; surrendered: boolean; actions: PlayerAction[] }[],
  ): Promise<void> {
    for (;;) {
      const actions = legalActions(this.player, this.splitsUsed, this.bankroll, this.bet);

      if (actions.length === 0) break; // bust

      if (actions.length === 1 && actions[0] === "stand") break; // 21 or blackjack: forced stand

      const state = buildJevState({
        player: this.player,
        dealerUpcard: this.dealer[0]!,
        legalActions: actions,
        bet: this.currentBet(),
        bankroll: this.bankroll,
        bankrollStart: START_BANKROLL,
        shoe: this.shoe,
        runningCount: this.running,
        handsPlayed: this.handNumber - 1,
        recentOutcomes: this.recentOutcomes,
        advice: this.model.usesAdvice,
      });

      this.decision = await this.model.decide(state);
      const chosen: PlayerAction = actions.includes(this.decision.action) ? this.decision.action : "stand";
      this.takenActions.push(chosen);
      this.emit("decision");

      if (chosen === "hit") {
        const card = draw(this.shoe);

        if (!card) break;
        this.player.push(card);
        this.running += hiLo(card);

        if (isBust(this.player)) break;
        continue;
      }

      if (chosen === "double") {
        this.doubled = true;
        const card = draw(this.shoe);

        if (card) {
          this.player.push(card);
          this.running += hiLo(card);
        }

        break;
      }

      if (chosen === "surrender") {
        this.surrendered = true;
        break;
      }

      if (chosen === "split") {
        this.splitsUsed++;
        const [first, second] = this.player;
        this.player = [first!];
        const extra = draw(this.shoe);

        if (extra) {
          this.player.push(extra);
          this.running += hiLo(extra);
        }

        const sibling: { cards: Card[]; bet: number; surrendered: boolean; actions: PlayerAction[] } = {
          cards: [second!],
          bet: this.bet,
          surrendered: false,
          actions: [],
        };
        const extra2 = draw(this.shoe);

        if (extra2) {
          sibling.cards.push(extra2);
          this.running += hiLo(extra2);
        }

        hands.push(sibling);
        continue; // finish this hand; the sibling plays next
      }

      break; // stand
    }
  }

  get bankrollNow(): number {
    return this.bankroll;
  }

  get historyAll(): readonly HandRecord[] {
    return this.history;
  }

  private currentBet(): number {
    return this.doubled ? this.bet * 2 : this.bet;
  }

  private compose(kind: TableEvent["kind"]): TableEvent {
    const hideHole = this.phase === "player" || this.phase === "dealing" || this.phase === "idle";

    return {
      kind,
      phase: this.phase,
      handNumber: this.handNumber,
      bet: this.currentBet(),
      playerCards: this.player.map((card) => `${card.rank}${card.suit}`),
      dealerCards: hideHole ? this.dealer.slice(0, 1).map((card) => `${card.rank}${card.suit}`) : this.dealer.map((card) => `${card.rank}${card.suit}`),
      dealerHoleHidden: hideHole && this.dealer.length > 1,
      bankroll: this.bankroll,
      bankrollStart: START_BANKROLL,
      legalActions: this.phase === "player" ? legalActions(this.player, this.splitsUsed, this.bankroll, this.bet) : [],
      decision: this.decision,
      outcome: this.outcome,
      shoeFraction: Math.round(shoeFraction(this.shoe) * 100) / 100,
      trueCount: Math.round((this.running / Math.max(0.25, this.shoe.length / 52)) * 10) / 10,
      handsPlayed: this.handNumber,
      history: this.history,
    };
  }

  private emit(kind: TableEvent["kind"]): void {
    this.send(this.compose(kind));
  }

  private send(event: TableEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
