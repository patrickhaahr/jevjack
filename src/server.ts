/**
 * HTTP server. Serves the page, exposes POST /api/decision (Jev's answer for
 * the current table without executing it) and GET /api/events (SSE). Game
 * control endpoints drive the loop from the UI.
 */

import { appendFileSync } from "node:fs";
import { handValue, type Card } from "./engine/engine";
import { Game, type TableEvent } from "./game/game";
import { basicStrategyAction, createModel } from "./jev/jev";

const PORT = Number(process.env.PORT ?? 3000);

const DECISION_PAUSE_MS = Number(process.env.DECISION_PAUSE_MS ?? 0);

// Set DECISION_LOG to a path to append every decision and settlement as JSONL.
const DECISION_LOG = process.env.DECISION_LOG ?? "";

const game = new Game(createModel());

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

const encoder = new TextEncoder();

function broadcast(event: TableEvent): void {
  const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;

  for (const client of clients) {
    try {
      client.enqueue(encoder.encode(payload));
    } catch {
      clients.delete(client);
    }
  }
}

game.onEvent((event) => {
  broadcast(event);
  logEvent(event);
});

function parseCard(label: string): Card {
  // SAFETY: server emits labels via cardLabel over real Cards.
  return { rank: (label.startsWith("10") ? "10" : label[0]) as Card["rank"], suit: label.slice(-1) as Card["suit"] };
}

function logEvent(event: TableEvent): void {
  if (!DECISION_LOG) return;

  if (event.kind === "decision" && event.decision && event.legalActions.length > 0) {
    const playerCards = event.playerCards.map(parseCard);
    const { total, soft } = handValue(playerCards);
    const dealerUpcard = event.dealerCards[0] ?? "";
    const advice = basicStrategyAction({
      playerTotal: total,
      playerSoft: soft,
      dealerUpcard,
      playerCards: event.playerCards,
      legalActions: event.legalActions,
    });

    appendFileSync(
      DECISION_LOG,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: "decision",
        hand: event.handNumber,
        model: event.decision.model,
        bet: event.bet,
        player: event.playerCards,
        total,
        soft,
        dealerUpcard,
        legal: event.legalActions,
        chosen: event.decision.action,
        advice,
        deviates: event.decision.action !== advice && event.legalActions.includes(advice),
        trueCount: event.trueCount,
        confidence: event.decision.confidence,
        probs: event.decision.probabilities,
        latencyMs: event.decision.latencyMs,
      })}\n`,
    );

    return;
  }

  if (event.kind === "hand_end" && event.outcome) {
    appendFileSync(
      DECISION_LOG,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: "hand_end",
        hand: event.handNumber,
        bet: event.bet,
        outcome: event.outcome.kind,
        delta: event.outcome.delta,
        bankroll: event.bankroll,
      })}\n`,
    );
  }
}

let running = false;

let stopRequested = false;

async function runLoop(): Promise<void> {
  if (running) return;
  running = true;
  stopRequested = false;

  while (!stopRequested) {
    await game.playHand();

    if (stopRequested) break;
    await new Promise((resolve) => setTimeout(resolve, DECISION_PAUSE_MS));
  }

  running = false;
}

const page = await Bun.file(new URL("./ui/index.html", import.meta.url).pathname).text();

// Browsers cannot execute TypeScript, so the browser script is transpiled at startup.
const uiJs = await new Bun.Transpiler({ loader: "ts" }).transform(
  await Bun.file(new URL("./ui/ui.ts", import.meta.url).pathname).text(),
);

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && pathname === "/ui.js") {
      return new Response(uiJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (req.method === "GET" && pathname === "/style.css") {
      return new Response(Bun.file(new URL("./ui/style.css", import.meta.url).pathname), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }

    if (req.method === "GET" && pathname === "/api/events") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          clients.add(controller);
          sendEvent(controller, "snapshot", game.snapshot());
        },
        cancel(controller) {
          clients.delete(controller);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/decision") {
      return json({ status: "ok", message: "Use GET /api/events to observe; decisions stream there." }, 200);
    }

    if (req.method === "POST" && pathname === "/api/start") {
      void runLoop();

      return json({ status: "ok", running: true });
    }

    if (req.method === "POST" && pathname === "/api/step") {
      void game.playHand();

      return json({ status: "ok" });
    }

    if (req.method === "POST" && pathname === "/api/stop") {
      stopRequested = true;

      return json({ status: "ok", running: false });
    }

    if (req.method === "POST" && pathname === "/api/reset") {
      stopRequested = true;
      game.reset();

      return json({ status: "ok" });
    }

    return json({ error: "not found" }, 404);
  },
});

function sendEvent(controller: ReadableStreamDefaultController<Uint8Array>, kind: string, data: TableEvent): void {
  try {
    controller.enqueue(encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`));
  } catch {
    clients.delete(controller);
  }
}

interface ApiResponse {
  status?: string;
  running?: boolean;
  message?: string;
  error?: string;
}

function json(body: ApiResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

console.log(`jevjack on http://localhost:${PORT} (model: ${process.env.MODEL ?? "mock"})`);
