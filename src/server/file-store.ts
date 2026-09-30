import { appendFileSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TableConfig, TableEvent } from "../engine/types.ts";
import { type Commit, CorruptLogError, type LogRecord, type Store } from "./service.ts";

// An append-only JSON Lines log: the table config first, then one line per
// accepted command with the events it produced. `npm run replay` checks it,
// and the server restores a table from it after a restart.

export interface LogFile {
  config: TableConfig;
  records: LogRecord[];
  // Bytes after the last newline: a write the crash cut short, dropped.
  torn: string | null;
  // Length of the complete lines, where the next append must start.
  bytes: number;
}

// Starts a new log, replacing any file at `path`.
export function fileStore(path: string, config: TableConfig): Store {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ config }) + "\n", { flush: true });
  return appender(path);
}

// Opens an existing log to carry on writing to it. A torn last line is cut
// off the file before the first new line is appended, so the two never merge.
export function resumeFileStore(path: string): LogFile & { store: Store } {
  const log = readLog(path);
  let cut = log.torn !== null;
  const store = appender(path);
  return {
    ...log,
    store: {
      async append(commit, events) {
        if (cut) truncateSync(path, log.bytes);
        cut = false;
        await store.append(commit, events);
      },
    },
  };
}

function appender(path: string): Store {
  return {
    // The service waits for this before publishing, so it must be on disk:
    // flush asks the OS to write it through its cache to the disk.
    async append(commit: Commit, events: TableEvent[]) {
      appendFileSync(path, JSON.stringify({ commit, events }) + "\n", { flush: true });
    },
  };
}

export function readLog(path: string): LogFile {
  return parseLog(readFileSync(path, "utf8"));
}

// A line counts once its newline is written. Every line is appended in one
// write and acknowledged only after it, so text after the last newline was
// never acknowledged to anyone and is dropped, as if the crash had come a
// moment earlier. A line that doesn't parse anywhere else is corruption.
export function parseLog(text: string): LogFile {
  const end = text.lastIndexOf("\n") + 1;
  const lines = text.slice(0, end).split("\n").slice(0, -1);
  const parsed = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new CorruptLogError(`line ${i + 1} of ${lines.length} is not JSON`);
    }
  });
  const config = parsed[0]?.config;
  if (!config) throw new CorruptLogError("the log doesn't start with the table config");
  return { config, records: parsed.slice(1), torn: text.slice(end) || null, bytes: Buffer.byteLength(text.slice(0, end)) };
}
