# Jevjack

Jev plays blackjack. A Bun server deals, asks the TypeSafe Jev model for one
typed decision per player action, and executes it. A browser page shows the
table, Jev's probability bars, and the bankroll over time.

## Run

    cp .env.example .env
    bun install
    bun run start

`.env` keys: `TYPESAFE_API_KEY` (already set in this shell; leave unset to run
offline), `MODEL` (mock | jev), `ADVICE` (on | off), `DECISION_LOG` (optional
JSONL path), `PORT`, `DECISION_PAUSE_MS`.

Open http://localhost:3000. Controls: run/pause, step one decision, new shoe,
reset bankroll.

## How it works

- `src/engine/engine.ts` — pure blackjack rules: 6-deck shoe, 75% penetration, dealer
  stands soft 17, blackjack pays 3:2, double and split allowed. All execution
  is code; Jev never moves cards.
- `src/jev/jev.ts` — one System One request per decision. `action` is a Choice over
  hit/stand/double/split/surrender; `win_probability` and `hand_quality` are
  speculative Scores in the same call. `MODEL=mock` swaps in a basic-strategy
  heuristic so the loop runs offline. `ADVICE=off` withholds the code-computed
  `basicStrategy` field and switches to a free-form question, for A/B runs.
- `src/eval.ts` — side-by-side A/B: same seeded hands with the advice helper on,
  off, and the mock reference. `bun run eval [hands]`.
- `src/game/game.ts` — the loop: deal, ask, execute until stand/bust, dealer plays,
  settle, log. One event per state change over SSE.
- `src/server.ts` — Bun.serve: page, POST /api/decision (peek at Jev's answer
  without executing), GET /api/events.

## Test

    bun test        # engine rules + mock model
    bun run typecheck
