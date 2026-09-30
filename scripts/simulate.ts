// Plays games through the chaotic network and reports what happened.
// npm run simulate -- --seed 5 --hands 50 --crash 20000
import { simulate } from "../src/sim/simulation.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const crashes = arg("crash", 20_000); // mean virtual ms between server crashes, 0 for none
const r = await simulate({
  seed: arg("seed", 1),
  hands: arg("hands", 30),
  players: arg("players", 4),
  chaos: {
    latencyMs: 20,
    jitterMs: arg("jitter", 80),
    duplicateRate: arg("dup", 0.1),
    disconnectEveryMs: arg("disconnect", 4000),
    reconnectAfterMs: 300,
    crashEveryMs: crashes,
    restartAfterMs: 500,
  },
});
console.log(
  `${r.handsPlayed} hands, ${r.events} events, ${r.commands} commands applied, ${r.rejected} rejected, ` +
    `${r.timeouts} timeouts, ${r.reconnects} reconnects, ${(r.virtualMs / 1000).toFixed(0)} s of virtual time`,
);
if (crashes) {
  console.log(
    `${r.crashes} server crashes, ${r.crashesMidHand} mid-hand, ${r.crashesBeforeWrite} before a write reached the disk, ` +
      `${r.crashesBeforePublish} between the disk and publishing`,
  );
}
if (r.violations.length) {
  console.log(r.violations.join("\n"));
  process.exit(1);
}
console.log("every client converged on the server's table; the log replays exactly");
