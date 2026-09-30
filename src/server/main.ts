import type { TableConfig } from "../engine/types.ts";
import { fileStore } from "./file-store.ts";
import { TableService } from "./service.ts";
import { listen } from "./ws.ts";

const config: TableConfig = { seats: 6, smallBlind: 1, bigBlind: 2, minBuyIn: 40, maxBuyIn: 200, seed: Number(process.env.SEED ?? Date.now() % 2 ** 31) };
const logPath = process.env.LOG ?? `logs/table-${config.seed}.jsonl`;
const service = new TableService({ config, store: fileStore(logPath, config), audit: true });
const { port } = await listen(service, Number(process.env.PORT ?? 8080));
console.log(`table on ws://localhost:${port}, seed ${config.seed}, log ${logPath}`);
