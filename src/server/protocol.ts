import type { Command, RejectCode, TableEvent } from "../engine/types.ts";

export type Response = { ok: true; firstSeq: number; lastSeq: number } | { ok: false; code: RejectCode; message: string };

// Client to server. Commands are only accepted after `hello`, and a client
// sends its commands only after `welcome`.
export type ClientMsg =
  | { t: "hello"; playerId: string | null; lastSeq: number }
  | { t: "cmd"; id: string; cmd: Command };

// Server to client. Every event carries its position in the table's log.
export type ServerMsg =
  | { t: "welcome"; head: number }
  | { t: "event"; seq: number; event: TableEvent }
  | { t: "result"; id: string; result: Response }
  | { t: "error"; message: string };
