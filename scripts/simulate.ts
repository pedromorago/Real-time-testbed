// Plays games through the chaotic network and reports what happened.
// npm run simulate -- --seed 5 --hands 50
import { simulate } from "../src/sim/simulation.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const r = await simulate({
  seed: arg("seed", 1),
  hands: arg("hands", 30),
  players: arg("players", 4),
  chaos: { latencyMs: 20, jitterMs: arg("jitter", 80), duplicateRate: arg("dup", 0.1), disconnectEveryMs: arg("disconnect", 4000), reconnectAfterMs: 300 },
});
console.log(
  `${r.handsPlayed} hands, ${r.events} events, ${r.commands} commands applied, ${r.rejected} rejected, ` +
    `${r.timeouts} timeouts, ${r.reconnects} reconnects, ${(r.virtualMs / 1000).toFixed(0)} s of virtual time`,
);
if (r.violations.length) {
  console.log(r.violations.join("\n"));
  process.exit(1);
}
console.log("every client converged on the server's table; the log replays exactly");
