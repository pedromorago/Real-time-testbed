import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TableConfig, TableEvent } from "../engine/types.ts";
import type { Commit, Store } from "./service.ts";

// An append-only JSON Lines log: the table config first, then one line per
// accepted command with the events it produced. `npm run replay` checks it.
export function fileStore(path: string, config: TableConfig): Store {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ config }) + "\n");
  return {
    async append(commit: Commit, events: TableEvent[]) {
      appendFileSync(path, JSON.stringify({ commit, events }) + "\n");
    },
  };
}

export function readLog(path: string): { config: TableConfig; entries: { commit: Commit; events: TableEvent[] }[] } {
  const [head, ...rest] = readFileSync(path, "utf8").trim().split("\n");
  return { config: JSON.parse(head).config, entries: rest.map((l) => JSON.parse(l)) };
}
