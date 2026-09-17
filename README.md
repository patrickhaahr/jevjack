# Jevjack

Jev plays blackjack. A Bun server deals, asks the TypeSafe Jev model for one
typed decision per player action, and executes it. A browser page shows the
table, Jev's probability bars, and the bankroll over time.

## Run

    cp .env.example .env   # TYPESAFE_API_KEY (already set in env), MODEL=mock|jev
    bun install
    bun run start

Open http://localhost:3000. Controls: run/pause, step one decision, new shoe,
reset bankroll.

## How it works

- `engine.ts` — pure blackjack rules: 6-deck shoe, 75% penetration, dealer
  stands soft 17, blackjack pays 3:2, double and split allowed. All execution
  is code; Jev never moves cards.
- `jev.ts` — one System One request per decision. `action` is a Choice over
  hit/stand/double/split/surrender; `win_probability` and `hand_quality` are
  speculative Scores in the same call. `MODEL=mock` swaps in a basic-strategy
  heuristic so the loop runs offline.
- `game.ts` — the loop: deal, ask, execute until stand/bust, dealer plays,
  settle, log. One event per state change over SSE.
- `server.ts` — Bun.serve: page, POST /api/decision (peek at Jev's answer
  without executing), GET /api/events.

## Test

    bun test        # engine rules + mock model
    bun run typecheck
