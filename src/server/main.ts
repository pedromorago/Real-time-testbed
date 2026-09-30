import { existsSync } from "node:fs";
import type { TableConfig } from "../engine/types.ts";
import { fileStore, resumeFileStore } from "./file-store.ts";
import { CorruptLogError, TableService } from "./service.ts";
import { listen } from "./ws.ts";

// Starts a table logged to LOG. If that file exists, the table is restored
// from it (after a crash or a restart) and carries on where it stopped.
const seed = Number(process.env.SEED ?? Date.now() % 2 ** 31);
const logPath = process.env.LOG ?? `logs/table-${seed}.jsonl`;
let service: TableService;
if (existsSync(logPath)) {
  try {
    const log = resumeFileStore(logPath);
    service = TableService.restore({ config: log.config, store: log.store, audit: true }, log.records);
    const hand = service.state.hand ? `, hand ${service.state.hand.id} in progress` : "";
    const torn = log.torn ? `, dropped a torn last line of ${log.torn.length} bytes` : "";
    console.log(`restored ${log.records.length} commands and ${service.head} events from ${logPath}${hand}${torn}`);
  } catch (e) {
    if (!(e instanceof CorruptLogError)) throw e;
    console.error(`not starting: ${logPath} can't be trusted: ${e.message}`);
    process.exit(1);
  }
} else {
  const config: TableConfig = { seats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, seed };
  service = new TableService({ config, store: fileStore(logPath, config), audit: true });
}
const { port } = await listen(service, Number(process.env.PORT ?? 8080));
console.log(`table on ws://localhost:${port}, seed ${service.state.config.seed}, log ${logPath}`);
