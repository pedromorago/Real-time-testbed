// Replays a table log and checks it rebuilds the same events.
// npm run replay -- logs/table-123.jsonl
import { readLog } from "../src/server/file-store.ts";
import { replay } from "../src/server/service.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run replay -- <log.jsonl>");
  process.exit(2);
}
const { config, records, torn } = readLog(path);
const logged = records.flatMap((e) => e.events);
const r = replay(config, records.map((e) => e.commit));
const same = JSON.stringify(r.events) === JSON.stringify(logged);
console.log(`${records.length} commands, ${logged.length} events, ${r.state.handsPlayed} hands`);
if (torn) console.log(`  ignored a torn last line of ${torn.length} bytes (a write cut short by a crash)`);
for (const e of r.errors) console.log(`  ${e}`);
if (!same || r.errors.length) {
  const i = r.events.findIndex((e, k) => JSON.stringify(e) !== JSON.stringify(logged[k]));
  console.log(`replay diverges at event ${(i < 0 ? Math.min(r.events.length, logged.length) : i) + 1}`);
  process.exit(1);
}
console.log("replay matches the log event for event");
