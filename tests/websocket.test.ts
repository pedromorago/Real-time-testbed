import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TableClient } from "../src/client/client.ts";
import { connectWs } from "../src/client/ws-client.ts";
import { viewOf } from "../src/engine/view.ts";
import type { Response } from "../src/server/protocol.ts";
import { readLog, fileStore } from "../src/server/file-store.ts";
import { replay, TableService } from "../src/server/service.ts";
import { listen } from "../src/server/ws.ts";
import { CONFIG, slowStore } from "../validation/helpers.ts";

// The same guarantees as the simulator, over real sockets and real timers.

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const resultOf = async (c: TableClient, id: string): Promise<Response> => {
  await until(() => c.results.has(id));
  return c.results.get(id)!;
};

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

async function table(opts: Partial<ConstructorParameters<typeof TableService>[0]> = {}) {
  const service = new TableService({ config: CONFIG, store: slowStore, audit: true, nextHandDelayMs: 20, ...opts });
  const server = await listen(service);
  stop = server.close;
  const url = `ws://localhost:${server.port}`;
  const join = async (id: string | null) => {
    const c = new TableClient(id, CONFIG.seats);
    const ws = await connectWs(c, url);
    await until(() => c.lastSeq === service.head);
    return { c, ws, reconnect: () => connectWs(c, url) };
  };
  return { service, join };
}

const converged = (service: TableService, ...clients: TableClient[]) =>
  clients.every((c) => c.lastSeq === service.head && JSON.stringify(c.view) === JSON.stringify(viewOf(service.state, c.playerId)));

describe("over WebSockets", () => {
  it("two players racing for one seat: one sits, one is told the seat is taken", async () => {
    const { service, join } = await table();
    const a = await join("p1");
    const b = await join("p2");
    const ia = a.c.send({ type: "sit", playerId: "p1", seat: 2, buyIn: 100 });
    const ib = b.c.send({ type: "sit", playerId: "p2", seat: 2, buyIn: 100 });
    const results = [await resultOf(a.c, ia), await resultOf(b.c, ib)];
    expect(results.map((r) => (r.ok ? "ok" : r.code)).sort()).toEqual(["ok", "seat_taken"]);
    await until(() => converged(service, a.c, b.c));
  });

  it("a dropped client resumes where it left off and catches up exactly", async () => {
    const { service, join } = await table({ actionTimeoutMs: 30 });
    const a = await join("p1");
    const b = await join("p2");
    a.c.send({ type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
    b.c.send({ type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
    await until(() => service.state.hand !== null);
    a.ws.terminate(); // no close handshake, like a lost connection
    const missedFrom = a.c.lastSeq;
    await until(() => service.state.handsPlayed >= 2); // timeouts keep the game moving
    expect(a.c.lastSeq).toBe(missedFrom);
    await a.reconnect();
    await until(() => converged(service, a.c, b.c));
    expect(a.c.anomalies).toEqual([]);
  });

  it("a command sent while offline is delivered on reconnect and applied once", async () => {
    const { service, join } = await table();
    const a = await join("p1");
    a.ws.terminate();
    await until(() => !a.c.connected);
    const cmd = { type: "sit", playerId: "p1", seat: 4, buyIn: 100 } as const;
    const id = a.c.send(cmd);
    const ws = await a.reconnect();
    const first = await resultOf(a.c, id);
    expect(first.ok).toBe(true);
    // The same id again, straight down the socket, is answered from the first result.
    const replies: unknown[] = [];
    ws.on("message", (d) => replies.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: "cmd", id, cmd }));
    await until(() => replies.length > 0);
    expect(replies[0]).toEqual({ t: "result", id, result: first });
    expect(service.log.filter((e) => e.event.type === "PlayerSat")).toHaveLength(1);
    await until(() => converged(service, a.c));
  });

  it("hole cards reach only their owner, spectators see none", async () => {
    const { service, join } = await table();
    const a = await join("p1");
    const b = await join("p2");
    const w = await join(null);
    a.c.send({ type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
    b.c.send({ type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
    await until(() => service.state.hand !== null && converged(service, a.c, b.c, w.c));
    expect(a.c.view.hole).toHaveLength(2);
    expect(b.c.view.hole).toHaveLength(2);
    expect(w.c.view.hole).toBeNull();
    expect([...a.c.anomalies, ...b.c.anomalies, ...w.c.anomalies]).toEqual([]);
  });

  it("players can't act for someone else or send system commands", async () => {
    const { service, join } = await table();
    const a = await join("p1");
    a.c.send({ type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
    const forged = a.c.send({ type: "sit", playerId: "p9", seat: 1, buyIn: 100 });
    const start = a.c.send({ type: "start" });
    // The server takes the player from the connection, not from the command.
    expect(await resultOf(a.c, forged)).toMatchObject({ ok: false, code: "already_seated" });
    expect(await resultOf(a.c, start)).toMatchObject({ ok: false, code: "not_authorized" });
    expect(service.state.seats.filter(Boolean).map((s) => s!.playerId)).toEqual(["p1"]);
  });

  it("the log on disk replays to the same events", async () => {
    const path = pathJoin(mkdtempSync(pathJoin(tmpdir(), "rtt-")), "table.jsonl");
    const { service, join } = await table({ store: fileStore(path, CONFIG), actionTimeoutMs: 20, maxHands: 3 });
    const a = await join("p1");
    const b = await join("p2");
    a.c.send({ type: "sit", playerId: "p1", seat: 0, buyIn: 100 });
    b.c.send({ type: "sit", playerId: "p2", seat: 1, buyIn: 100 });
    await until(() => service.state.handsPlayed === 3);
    const { config, entries } = readLog(path);
    const r = replay(config, entries.map((e) => e.commit));
    expect(r.errors).toEqual([]);
    expect(r.events).toEqual(service.log.map((e) => e.event));
    expect(r.state).toEqual(service.state);
  });
});
