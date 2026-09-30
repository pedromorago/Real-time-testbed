import WebSocket from "ws";
import type { TableClient } from "./client.ts";

// Connects a TableClient over a real WebSocket. Call it again after the
// socket closes to resume: the client says where it left off.
export function connectWs(client: TableClient, url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.on("message", (data) => client.receive(JSON.parse(String(data))));
  ws.on("close", () => client.detach());
  return new Promise((resolve, reject) => {
    ws.on("open", () => {
      client.attach({ send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) });
      resolve(ws);
    });
    ws.on("error", reject);
  });
}
