/**
 * Browser side of jevjack. One SSE stream drives everything: table cards, Jev's
 * decision bars, bankroll chart, hand log. No framework.
 */

interface JevDecision {
  action: string;
  probabilities: Record<string, number>;
  confidence: number;
  winProbability: number;
  handQuality: number;
  latencyMs: number;
  inputTokens: number;
  model: string;
}

interface HandRecord {
  hand: number;
  bet: number;
  actions: string[];
  playerCards: string[];
  dealerCards: string[];
  outcome: string;
  delta: number;
  bankrollAfter: number;
}

interface TableEvent {
  kind: "hand_start" | "decision" | "hand_end" | "shoe_shuffle" | "error";
  phase: string;
  handNumber: number;
  bet: number;
  playerCards: string[];
  dealerCards: string[];
  dealerHoleHidden: boolean;
  bankroll: number;
  bankrollStart: number;
  legalActions: string[];
  decision: JevDecision | null;
  outcome: { kind: string; delta: number } | null;
  shoeFraction: number;
  trueCount: number;
  handsPlayed: number;
  history: HandRecord[];
  message?: string;
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const isRed = (suit: string): boolean => suit === "H" || suit === "D";

function suitGlyph(suit: string): string {
  switch (suit) {
    case "H": return "♥";
    case "D": return "♦";
    case "C": return "♣";
    default: return suit;
  }
}

function parseCard(label: string) {
  return { rank: label.slice(0, label.length - 1), suit: label.slice(-1) };
}

function cardEl(label: string, hidden: boolean): HTMLElement {
  const div = document.createElement("div");
  div.className = "card";

  if (hidden) {
    div.classList.add("hidden-card");

    return div;
  }

  const { rank, suit } = parseCard(label);
  div.classList.add(isRed(suit) ? "red" : "black");
  const glyph = suitGlyph(suit);

  const corner = (cls: string): HTMLElement => {
    const c = document.createElement("span");
    c.className = cls;
    const r = document.createElement("span");
    r.className = "card-rank";
    r.textContent = rank;
    const s = document.createElement("span");
    s.className = "card-suit";
    s.textContent = glyph;
    c.append(r, s);

    return c;
  };

  const main = document.createElement("span");
  main.className = "card-suit-main";
  main.textContent = glyph;
  div.append(corner("card-corner tl"), main, corner("card-corner br"));

  return div;
}

function renderCards(container: HTMLElement, labels: string[], hideLast: boolean): void {
  // Animate only newly dealt cards; existing cards must not replay the deal-in.
  const prev = container.children.length;
  container.replaceChildren();
  labels.forEach((label, i) => {
    const el = cardEl(label, hideLast && i === labels.length - 1);

    if (i >= prev) el.classList.add("card-in");
    container.append(el);
  });
}

function handTotal(labels: string[]): string {
  let total = 0;
  let aces = 0;

  for (const label of labels) {
    const rank = parseCard(label).rank;

    if (rank === "A") { total += 11; aces++; }
    else if (["K", "Q", "J", "10"].includes(rank)) total += 10;
    else total += Number(rank);
  }

  while (total > 21 && aces > 0) { total -= 10; aces--; }

  return String(total);
}

const ACTION_ORDER: readonly string[] = ["hit", "stand", "double", "split", "surrender"];

function renderProbs(decision: JevDecision, legal: string[]): void {
  const rows = $("prob-rows");
  rows.replaceChildren();

  const entries = Object.entries(decision.probabilities)
    .filter(([action]) => legal.length === 0 || legal.includes(action))
    .sort((a, b) => (ACTION_ORDER.indexOf(a[0]) - ACTION_ORDER.indexOf(b[0])) || b[1] - a[1]);

  for (const [action, p] of entries) {
    const row = document.createElement("div");
    row.className = "prob-row" + (action === decision.action ? " chosen" : "");
    const label = document.createElement("span");
    label.className = "prob-label";
    label.textContent = action;
    const track = document.createElement("div");
    track.className = "prob-track";
    const fill = document.createElement("div");
    fill.className = "prob-fill";
    fill.style.width = `${Math.round(p * 100)}%`;
    track.append(fill);
    const pct = document.createElement("span");
    pct.className = "prob-pct";
    pct.textContent = `${Math.round(p * 100)}%`;
    row.append(label, track, pct);
    rows.append(row);
  }

  $("confidence").textContent = `conf ${decision.confidence.toFixed(2)}`;
  $("latency").textContent = `${decision.latencyMs} ms`;
  $("tokens").textContent = `${decision.inputTokens} tok`;
  $("win-fill").style.width = `${Math.round(decision.winProbability * 100)}%`;
  $("win-value").textContent = `${Math.round(decision.winProbability * 100)}%`;
  $("quality-fill").style.width = `${Math.round((decision.handQuality / 3) * 100)}%`;
  $("quality-value").textContent = decision.handQuality.toFixed(1);
}

const bankrollSeries: number[] = [];

function renderBankroll(bankroll: number, start: number): void {
  $("bankroll").textContent = `$${bankroll.toLocaleString("en-US")}`;
  const delta = bankroll - start;
  const deltaEl = $("bankroll-delta");
  deltaEl.textContent = `${delta >= 0 ? "+" : "−"}$${Math.abs(delta).toLocaleString("en-US")}`;
  deltaEl.className = "bankroll-delta " + (delta > 0 ? "pos" : delta < 0 ? "neg" : "");

  // SAFETY: index.html renders the bankroll chart as a <canvas> with this id.
  const canvas = $("bankroll-chart") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (bankrollSeries.length < 2) return;
  const lo = Math.min(...bankrollSeries, start);
  const hi = Math.max(...bankrollSeries, start);
  const span = hi - lo || 1;
  const x = (i: number): number => (i / (bankrollSeries.length - 1)) * (w - 4) + 2;
  const y = (v: number): number => h - 4 - ((v - lo) / span) * (h - 8);
  ctx.beginPath();
  bankrollSeries.forEach((v, i) => (i === 0 ? ctx.moveTo(x(0), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.strokeStyle = bankrollSeries[bankrollSeries.length - 1]! >= start ? "#2f9e63" : "#c74a33";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function renderLog(history: HandRecord[]): void {
  const log = $("hand-log");
  log.replaceChildren();

  for (const rec of [...history].reverse().slice(0, 30)) {
    const li = document.createElement("li");
    li.className = `log-${rec.outcome}`;
    const left = document.createElement("span");
    left.textContent = `#${rec.hand}`;
    const mid = document.createElement("span");
    mid.className = "log-actions";
    mid.textContent = rec.actions.length ? rec.actions.join(" → ") : "—";
    const right = document.createElement("span");
    right.className = rec.delta > 0 ? "pos" : rec.delta < 0 ? "neg" : "";
    right.textContent = `${rec.delta >= 0 ? "+" : "−"}$${Math.abs(rec.delta)}`;
    li.append(left, mid, right);
    log.append(li);
  }
}

function render(e: TableEvent): void {
  const hideHole = e.dealerHoleHidden;
  renderCards($("dealer-cards"), e.dealerCards, false);
  renderCards($("player-cards"), e.playerCards, false);
  const dealerShown = hideHole ? e.dealerCards.slice(0, -1) : e.dealerCards;
  $("dealer-total").textContent = dealerShown.length ? `showing ${handTotal(dealerShown)}` : "";
  $("player-total").textContent = e.playerCards.length ? handTotal(e.playerCards) : "";
  $("hand-count").textContent = `hand ${e.handNumber}`;
  $("bet-tag").textContent = `bet $${e.bet}`;
  $("shoe-meter").textContent = `shoe ${Math.round(e.shoeFraction * 100)}%`;
  $("count-tag").textContent = `count ${e.trueCount > 0 ? "+" : ""}${e.trueCount}`;

  if (e.decision) {
    renderProbs(e.decision, e.legalActions);
    $("model-tag").textContent = `model: ${e.decision.model}`;
  }

  if (e.kind === "hand_end") {
    bankrollSeries.push(e.bankroll);
    renderBankroll(e.bankroll, e.bankrollStart);
    renderLog(e.history);
  }

  const msg = $("table-message");

  if (e.outcome && e.kind === "hand_end") {
    const text = new Map(Object.entries({
      player_blackjack: "Blackjack! Pays 3:2",
      win: "Jev wins the hand",
      push: "Push — bet returned",
      lose: "Dealer takes it",
      surrender: "Surrendered — half bet back",
      dealer_blackjack: "Dealer blackjack",
    }));

    msg.textContent = text.get(e.outcome.kind) ?? e.outcome.kind;
    msg.className = "table-message outcome-" + e.outcome.kind;
  } else if (e.decision && e.kind === "decision") {
    msg.textContent = `Jev: ${e.decision.action}`;
    msg.className = "table-message";
  } else if (e.kind === "error") {
    msg.textContent = e.message ?? "error";
    msg.className = "table-message outcome-lose";
  } else if (e.kind === "shoe_shuffle") {
    msg.textContent = "New shoe";
    msg.className = "table-message";
  }
}

function connect(): EventSource {
  const es = new EventSource("/api/events");

  for (const kind of ["snapshot", "hand_start", "decision", "hand_end", "shoe_shuffle", "error"]) {
    es.addEventListener(kind, (ev: MessageEvent) => {
      // SAFETY: the server serializes TableEvent payloads for every event kind it emits.
      render(JSON.parse(ev.data) as TableEvent);
      $("conn-dot").classList.add("live");
      $("conn-label").textContent = "live";
    });
  }

  es.onerror = () => {
    $("conn-dot").classList.remove("live");
    $("conn-label").textContent = "reconnecting";
  };

  return es;
}

connect();

$("btn-run").addEventListener("click", () => void fetch("/api/start", { method: "POST" }));

$("btn-step").addEventListener("click", () => void fetch("/api/step", { method: "POST" }));

$("btn-stop").addEventListener("click", () => void fetch("/api/stop", { method: "POST" }));

$("btn-reset").addEventListener("click", () => {
  bankrollSeries.length = 0;
  void fetch("/api/reset", { method: "POST" });
});
