/**
 * Jevjack entrypoint. Temporary smoke check: deals a hand, verifies the
 * TypeSafe SDK reaches the API, prints both. The real loop replaces this once
 * engine.ts / jev.ts exist.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";

const SUITS = ["S", "H", "D", "C"] as const;

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

function deal(n: number): string[] {
  const deck = SUITS.flatMap((s) => RANKS.map((r) => `${r}${s}`));

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }

  return deck.slice(0, n);
}

async function main(): Promise<void> {
  const client = new TypeSafeClient();
  const models = await client.models.list();
  console.log("dealt:", deal(4).join(" "));
  console.log("typesafe models:", models.map((m) => m.name).join(", "));
}

await main();
