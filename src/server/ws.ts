import { WebSocketServer } from "ws";
import { openConnection } from "./gateway.ts";
import type { ClientMsg } from "./protocol.ts";
import type { TableService } from "./service.ts";

// Serves one table over WebSockets. One JSON message per frame.
export function listen(service: TableService, port = 0): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port, maxPayload: 16 * 1024 });
  wss.on("connection", (ws) => {
    const conn = openConnection(service, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
    ws.on("message", (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return ws.send(JSON.stringify({ t: "error", message: "not JSON" }));
      }
      conn.receive(msg);
    });
    ws.on("close", () => conn.close());
    ws.on("error", () => conn.close());
  });
  return new Promise((resolve) =>
    wss.on("listening", () =>
      resolve({
        port: (wss.address() as { port: number }).port,
        close: () =>
          new Promise<void>((done) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => done());
          }),
      }),
    ),
  );
}
